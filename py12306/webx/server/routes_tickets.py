# -*- coding: utf-8 -*-
import re
import threading
import time

from flask import Blueprint, request

from py12306.config import Config
from py12306.helpers.api import API_QUERY_INIT_PAGE, LEFT_TICKETS
from py12306.webx import presale

bp = Blueprint('tickets', __name__)

# 简单并发限流：最多 3 个查询并发
_sem = threading.Semaphore(3)

# ---- 会话与接口名（2026-09 实测的 12306 行为）----
# 1) 余票接口要求先访问 init 页取得会话 cookie（JSESSIONID/BIGipServerotn）；
#    完全没有 cookie 的裸请求会被 302 到 https://www.12306.cn/mormhweb/logFiles/error.html
# 2) 12306 会把余票请求 302 到「规范 URL」，**必须跟随重定向**才能拿到数据；
#    旧代码用 allow_redirects=False 并把 302 当失败，这正是「车票查询失败(HTTP 302)」的原因
# 3) 接口名会变（现为 CLeftTicketUrl=leftTicket/queryG），从 init 页动态抓取；
#    若响应体里带 c_url 提示，则按提示重试一次（未来再改名也能自愈）
# 4) RAIL_DEVICEID 来自第三方服务 12306-rail-id-v2.pjialin.com（已下线），
#    但实测余票查询**不需要**该指纹，故不再依赖它
DEFAULT_API_TYPE = 'leftTicket/queryG'
SESSION_TTL = 600      # 兜底会话重建周期
API_TYPE_TTL = 3600    # 接口名缓存周期

_cache = {'session': None, 'session_at': 0.0, 'api_type': None, 'api_type_at': 0.0}
_lock = threading.Lock()


def _new_session():
    from py12306.helpers.request import Request
    return Request()


def _ensure_init(session):
    """确保会话已访问 init 页（拿 JSESSIONID），否则 12306 会 302 到 error.html"""
    try:
        if session.cookies.get('JSESSIONID'):
            return True
        session.get(API_QUERY_INIT_PAGE, timeout=Config().TIME_OUT_OF_REQUEST)
        return bool(session.cookies.get('JSESSIONID'))
    except Exception:
        return False


def _api_type_from_init(session):
    """从 init 页抓 CLeftTicketUrl（接口名会不定期变更）"""
    try:
        resp = session.get(API_QUERY_INIT_PAGE, timeout=Config().TIME_OUT_OF_REQUEST)
        if getattr(resp, 'status_code', None) == 200:
            m = re.search(r"CLeftTicketUrl\s*=\s*['\"]([^'\"]+)['\"]", resp.text or '')
            if m:
                return m.group(1)
    except Exception:
        pass
    return None


def _query_session():
    """
    复用 Query() 已初始化的共享 session（带设备/会话特征 cookie）。
    注意：只用 `Query.__dict__['__it__']` 读取已存在的单例，**不调用 Query()**，
    避免在未初始化时触发其 __init__ 里的网络探测（失败会无限递归）。
    """
    try:
        from py12306.query.query import Query
        inst = Query.__dict__.get('__it__')
        session = getattr(inst, 'session', None) if inst is not None else None
        if session is not None:
            _ensure_init(session)
            return session
    except Exception:
        pass
    with _lock:
        now = time.time()
        session = _cache['session']
        if session is None or now - _cache['session_at'] > SESSION_TTL:
            session = _new_session()
            _cache['session'] = session
            _cache['session_at'] = now
        _ensure_init(session)
        return session


def _resolve_api_type(session):
    """
    余票接口名以 init 页的 CLeftTicketUrl 为准（12306 会不定期改名，
    旧名如 queryZ 仍可用但会先 302，白付一跳）。抓不到时退回 Query 已探测的值。
    """
    now = time.time()
    if _cache['api_type'] and now - _cache['api_type_at'] < API_TYPE_TTL:
        return _cache['api_type']
    api_type = _api_type_from_init(session)
    if not api_type:
        try:
            from py12306.query.query import Query
            inst = Query.__dict__.get('__it__')
            api_type = getattr(inst, 'api_type', None) if inst is not None else None
        except Exception:
            api_type = None
    api_type = api_type or DEFAULT_API_TYPE
    _cache['api_type'] = api_type
    _cache['api_type_at'] = now
    return api_type


def _fetch(session, api_type, left_code, arrive_code, date):
    """请求余票；跟随重定向；返回 (payload, error_msg, suggested_api_type)"""
    url = LEFT_TICKETS['url'].format(left_date=date, left_station=left_code,
                                     arrive_station=arrive_code, type=api_type)
    with _sem:
        resp = session.get(url, timeout=Config().TIME_OUT_OF_REQUEST, allow_redirects=True)
    if getattr(resp, 'status_code', None) is None:
        return None, '连接 12306 失败（网络异常/超时，请检查网络后重试）', None
    if resp.status_code != 200:
        return None, '12306 查询失败（HTTP %s，可能被频控，稍后重试）' % resp.status_code, None
    # 超预售期的日期，12306 返回的是 HTML 错误页而不是 JSON。
    # 这里显式识别，避免落到「返回内容异常」这种误导性提示上。
    ctype = (resp.headers.get('Content-Type') or '') if hasattr(resp, 'headers') else ''
    if 'html' in ctype.lower():
        return None, '该日期尚未开售或不可查询（%s）' % presale.note(), None
    payload = resp.json()
    if not isinstance(payload, dict) or not payload:
        return None, '该日期尚未开售或 12306 返回异常（%s）' % presale.note(), None
    if not (payload.get('data') or {}).get('result'):
        # 12306 会用 c_url 提示正确接口名
        hinted = payload.get('c_url')
        if hinted and hinted != api_type:
            return None, '接口名已变更，已按提示重试', hinted
    return payload, None, None


# 原型展示席别 → 12306 席别名
SHOW_SEATS = [('business', '商务座'), ('first', '一等座'), ('second', '二等座'),
              ('hardSleeper', '硬卧'), ('hardSeat', '硬座')]
# 全席别（筛选用）
ALL_SEATS = SHOW_SEATS + [('softSleeper', '软卧'), ('noSeat', '无座'), ('special', '特等座')]

# 车次前缀 → 类型
TRAIN_TYPES = [
    ('G', '高铁'), ('D', '动车'), ('C', '城际'), ('Z', '直达'), ('T', '特快'),
    ('K', '快速'), ('L', '临客'), ('Y', '旅游'), ('S', '市郊'),
]


def _train_type(train_number):
    if not train_number:
        return ''
    upper = train_number.upper()
    for prefix, label in TRAIN_TYPES:
        if upper.startswith(prefix):
            return label
    return '其他'


@bp.route('/api/tickets')
def tickets():
    left = (request.args.get('left') or '').strip()
    arrive = (request.args.get('arrive') or '').strip()
    date = (request.args.get('date') or '').strip()
    if not left or not arrive or not date:
        return {'code': 1, 'msg': '缺少 left/arrive/date 参数', 'data': None}
    # 预售期校验：未开售的日期直接拦下，不发无谓请求（12306 只会返回 HTML 错误页）
    if not presale.is_open(date):
        return {'code': 1, 'msg': presale.too_early_msg(date), 'data': None}
    try:
        from py12306.helpers.station import Station
        left_code = Station.get_station_key_by_name(left)
        arrive_code = Station.get_station_key_by_name(arrive)
    except Exception:
        return {'code': 1, 'msg': '车站无法解析（请确认站名与 12306 一致）', 'data': None}
    try:
        session = _query_session()
        api_type = _resolve_api_type(session)
        payload, err, hinted = _fetch(session, api_type, left_code, arrive_code, date)
        if hinted:
            # 接口名变更：按 12306 的提示重试一次，并记住新名字
            _cache['api_type'] = hinted
            _cache['api_type_at'] = time.time()
            api_type = hinted
            payload, err, _ = _fetch(session, hinted, left_code, arrive_code, date)
        if err and payload is None:
            return {'code': 1, 'msg': err, 'data': None}
        result = (payload.get('data') or {}).get('result')
        if not result:
            return {'code': 1, 'msg': '未查询到车次（该日期可能未放票或已售完）', 'data': None}
        station_names = payload.get('data', {}).get('map') or {}
        rows = []
        for raw in result:
            t = raw.split('|')
            if len(t) < 33:
                continue
            train_number = t[3]
            left_time, arrive_time = t[8], t[9]
            left_st = t[6]
            arrive_st = t[7]
            ticket_num = t[11]
            left_name = _station_name(left_st, station_names)
            arrive_name = _station_name(arrive_st, station_names)
            if not left_name or not arrive_name:
                continue
            minutes = _parse_lishi(t[10]) or _duration_minutes(left_time, arrive_time)
            seat_map = {}
            for key, name in ALL_SEATS:
                try:
                    idx = Config.SEAT_TYPES[name]
                    raw = t[idx] if idx < len(t) else ''
                except (KeyError, IndexError):
                    raw = ''
                # 关键区分（2026-09 实测）：
                #   ''/'N' → 该车不设此席别（如高铁无硬座、普速无商务座）→ 用 '/'
                #   '无'   → 有该席别但当前无票 → 保留 '无'（前端同时给出票价估算）
                # 两者语义不同，压成同一个 '无' 会让用户无法判断「等不到」还是「等得到」
                seat_map[key] = '/' if raw in ('', 'N') else raw
            rows.append({
                'n': train_number,
                'tn': _train_type(train_number),
                'f': left_name,
                'to': arrive_name,
                'd': left_time,
                'a': arrive_time,
                'm': minutes,
                'bookable': ticket_num == 'Y',
                's': seat_map,
            })
        return {'code': 0, 'msg': '', 'data': {'rows': rows, 'left': left, 'arrive': arrive,
                                              'date': date, 'api_type': api_type}}
    except Exception as e:
        return {'code': 1, 'msg': '查询异常: %s' % e, 'data': None}


def _station_name(code, station_names):
    """车站名解析：优先本地站点表，退回 12306 响应里的 map（两者都是电报码）"""
    if not code:
        return ''
    try:
        from py12306.helpers.station import Station
        name = Station.get_station_name_by_key(code)
        if name:
            return name
    except Exception:
        pass
    try:
        return station_names.get(code) or ''
    except Exception:
        return ''


def _parse_lishi(value):
    """
    12306 自带的历时字段 t[10]，格式 'HH:MM'，小时可 >24（如 Z181 的 '25:23'）。
    这是权威值；用出发/到达时刻反推在跨天车次上会算错（只补一天）。
    """
    try:
        h, m = str(value).split(':')[:2]
        return int(h) * 60 + int(m)
    except Exception:
        return None


def _duration_minutes(dep, arr):
    """兜底：出发 → 到达 历时分钟（跨天 +1440，仅能覆盖 24 小时内）"""
    try:
        d = int(dep[:2]) * 60 + int(dep[3:5])
        a = int(arr[:2]) * 60 + int(arr[3:5])
        m = a - d
        if m < 0:
            m += 1440
        return m
    except Exception:
        return None


@bp.route('/api/tickets/hits')
def tickets_hits():
    from py12306.webx.db import DataStore
    job_id = request.args.get('job_id')
    return {'code': 0, 'msg': '', 'data': {'hits': DataStore().hit_list(job_id=job_id, limit=200)}}
