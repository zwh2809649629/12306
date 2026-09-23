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

# 经停站接口（2026-09 实测可用；参数名就叫 leftTicketDTO.*，很容易猜错）
BASE_TRAIN_INFO = ('https://kyfw.12306.cn/otn/queryTrainInfo/query'
                   '?leftTicketDTO.train_no={train_no}'
                   '&leftTicketDTO.train_date={date}&rand_code=')

# ---- 真实票价接口（2026-09 实测可用，单次约 125ms）----
# ⚠️ 三个参数**都必须精确**：train_no + 该行的**实际上/下车站电报码** + 日期。
#    站码写错**不会报错**，只会返回 `{"status":true,"data":[]}` ——
#    我最初用查询站的电报码（深圳北=IOQ）去查，拿到空数组就误判成「接口已下线」；
#    实际上 12306 会做**同城站扩展**，行的实际站可能是同城其它站（深圳=SZQ），
#    接口只认**行自己的 t[6]/t[7]**。
# ⚠️ `/otn/leftTicket/queryTicketPrice`（旧接口）确实只返回 train_no，不要再试；
#    `/otn/leftTicketPrice/queryAllPublicPrice` 返回 405，**没有批量接口**，
#    只能按车次逐个查（所以做了缓存）。
PRICE_URL = ('https://kyfw.12306.cn/otn/leftTicketPrice/query'
             '?leftTicketDTO.train_no={train_no}'
             '&leftTicketDTO.from_station={from_station}'
             '&leftTicketDTO.to_station={to_station}'
             '&leftTicketDTO.train_date={date}&rand_code=')

# 12306 价格字段（字符串，单位「角」，需 /10）→ 我们的席别 key
PRICE_FIELDS = [
    ('swz_price', 'business'),      # 商务座
    ('tz_price', 'special'),        # 特等座
    ('zy_price', 'first'),          # 一等座
    ('ze_price', 'second'),         # 二等座
    ('rw_price', 'softSleeper'),    # 软卧
    ('yw_price', 'hardSleeper'),    # 硬卧
    ('yz_price', 'hardSeat'),       # 硬座
    ('wz_price', 'noSeat'),         # 无座（与二等座/硬座同价）
]

# 票价缓存：票价在当天内不变，所以长 TTL。
# key = (train_no, from_code, to_code, date) → {seat_key: 元}
_PRICE_CACHE = {}
_PRICE_TTL = 6 * 3600
_PRICE_WORKERS = 4          # 并发查价（单次 ~125ms；55 个车次约 2s）

# 站名 → 电报码：统一走 `py12306.webx.stations`（本地表不全、需官方表兜底，见那里的文档）。
# 这里只保留「余票响应 data.map 积累」的入口，因为只有本模块拿得到那个 map。

_cache = {'session': None, 'session_at': 0.0, 'api_type': None, 'api_type_at': 0.0}
_lock = threading.Lock()


def _remember_stations(station_names):
    """余票响应的 `data.map`（电报码→站名）积累进共享站名表。"""
    from py12306.webx import stations as st
    st.remember(station_names)


def _price_of(raw):
    """12306 价格字段是「角」的字符串（'02780' → 278.0）；'--' 表示该席别不适用"""
    if not raw or raw == '--':
        return None
    try:
        return round(int(str(raw).strip()) / 10.0, 1)
    except Exception:
        return None


def _fetch_price_one(session, train_no, from_code, to_code, date):
    """查一个车次的真实票价；失败/无数据返回 {}（不抛异常）"""
    url = PRICE_URL.format(train_no=train_no, from_station=from_code,
                           to_station=to_code, date=date)
    headers = {
        'Referer': '%s?linktypeid=dc&date=%s&flag=N,N,Y' % (API_QUERY_INIT_PAGE, date),
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
    }
    try:
        with _sem:
            resp = session.get(url, timeout=Config().TIME_OUT_OF_REQUEST,
                               allow_redirects=True, headers=headers)
        payload = resp.json()
    except Exception:
        return {}
    rows = payload.get('data') or []
    dto = ((rows[0] or {}).get('queryLeftNewDTO') if rows else None) or {}
    out = {}
    for field, seat_key in PRICE_FIELDS:
        value = _price_of(dto.get(field))
        if value:
            out[seat_key] = value
    return out


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
        _remember_stations(station_names)
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
                # 12306 内部车次号（如 65000Z80060Y）与起/终点站序号，
                # 停靠站（queryTrainInfo）与分站票价都要用它们定位。
                # 注意：train_no **不是**车次号（t[3] 才是「Z8006」），两者不同。
                'no': t[2],
                'from_no': t[16] if len(t) > 16 else '',
                'to_no': t[17] if len(t) > 17 else '',
                'seat_types': t[15] if len(t) > 15 else '',
                # 该行的**实际上/下车站**电报码（t[6]/t[7]）。
                # ⚠️ 12306 会做同城站扩展：查「深圳北→茂名」时返回的行可能是
                # 「深圳→马踏」（同城另站），票价接口只认行自己的这对站码。
                'f_code': left_st,
                'to_code': arrive_st,
            })
        # 任务详情可传 station_mode，让展示结果与引擎站点过滤保持同一语义。
        station_mode = (request.args.get('station_mode') or '').strip().lower()
        if station_mode in ('exact', 'expand'):
            try:
                from py12306.webx import stations as station_store
                if station_mode == 'exact':
                    allowed_left = {left}
                    allowed_arrive = {arrive}
                else:
                    allowed_left = set(station_store.expand(left) or [left])
                    allowed_arrive = set(station_store.expand(arrive) or [arrive])
                rows = [r for r in rows if (r.get('f') in allowed_left and r.get('to') in allowed_arrive)]
            except Exception:
                pass
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


# 站序（01）→ 序号（1）；12306 的 station_no 是两位字符串
def _stopover_minutes(arrive, start):
    """停留时长 = 出发时间 - 到站时间（分钟）。跨零点则 +1440。处理不出来的返回 None"""
    try:
        a = int(arrive[:2]) * 60 + int(arrive[3:5])
        s = int(start[:2]) * 60 + int(start[3:5])
        m = s - a
        if m < 0:
            m += 1440
        return m
    except Exception:
        return None


@bp.route('/api/tickets/stops')
def tickets_stops():
    """
    列车经停站（对应 12306 车次详情里的「经停站信息」弹窗）。

    数据源（2026-09 实测可用）：
      GET /otn/queryTrainInfo/query?leftTicketDTO.train_no=<train_no>&leftTicketDTO.train_date=<date>
        → data.data[] = {station_name, station_no, arrive_time, start_time,
                         arrive_day_str, arrive_day_diff, running_time, is_start}
    ⚠️ 注意参数里是 **train_no**（如 65000Z80060Y），不是车次号（Z8006）。
       `/otn/cndata/queryByTrainNo` 与 `/lcquery/queryTrainStopTime` 实测**已不可用**
       （前者返回 HTML 错误页，后者返回 `errorMsg: url error`），不要再尝试。

    **不提供票价**：12306 的分站票价接口（queryTicketPrice 带 to_station_no）
    实测**已不再返回数据**（响应里只有 train_no 字段，补 Referer / X-Requested-With /
    各种 seat_types 组合都试过）。估价值与实际差距过大（高铁长距离可差 2 倍），
    展示出来反而误导，所以干脆不给 —— 只返回 12306 真实返回的字段。
    """
    train_no = (request.args.get('train_no') or request.args.get('no') or '').strip()
    date = (request.args.get('date') or '').strip()
    if not train_no or not date:
        return {'code': 1, 'msg': '缺少 train_no/date 参数', 'data': None}
    if not re.match(r'^[0-9A-Za-z]{4,}$', train_no):
        return {'code': 1, 'msg': 'train_no 格式不正确（应为 12306 内部车次号）', 'data': None}
    try:
        session = _query_session()
        url = BASE_TRAIN_INFO.format(train_no=train_no, date=date)
        with _sem:
            resp = session.get(url, timeout=Config().TIME_OUT_OF_REQUEST, allow_redirects=True)
        ctype = (resp.headers.get('Content-Type') or '') if hasattr(resp, 'headers') else ''
        if 'json' not in ctype.lower():
            return {'code': 1, 'msg': '12306 未返回经停站数据（会话可能失效，请重试）', 'data': None}
        payload = resp.json()
        raw_stops = (payload.get('data') or {}).get('data') or []
        if not raw_stops:
            return {'code': 1, 'msg': '未获取到经停站信息', 'data': None}

        stops = []
        for raw in raw_stops:
            arrive = str(raw.get('arrive_time') or '')
            start = str(raw.get('start_time') or '')
            stops.append({
                'no': str(raw.get('station_no') or ''),
                'name': str(raw.get('station_name') or ''),
                'arrive': arrive if arrive != '----' else '',
                'start': start if start != '----' else '',
                # 跨天标记：arrive_day_diff 是「第几天到」（0 当天、1 次日）
                'day_diff': int(raw.get('arrive_day_diff') or 0),
                'elapsed': _parse_lishi(raw.get('running_time')),  # 从始发站起累计历时（分钟）
                'stay': _stopover_minutes(arrive, start),          # 停留时长（分钟）
            })
        return {'code': 0, 'msg': '', 'data': {
            'train_no': train_no,
            'train_number': str(raw_stops[0].get('station_train_code') or ''),
            'total_minutes': stops[-1]['elapsed'] if stops else None,
            'stops': stops,
        }}
    except Exception as e:
        return {'code': 1, 'msg': '获取经停站异常: %s' % e, 'data': None}


@bp.route('/api/tickets/prices')
def tickets_prices():
    """
    真实票价（逐车次查 12306）。

    `items=train_no:from_code:to_code|...`（`from_code`/`to_code` 是该行的实际
    上下站电报码，即 `/api/tickets` 行里的 `f_code`/`to_code`）。
    返回 `{ "train_no:from:to": {seat_key: 元} }`。

    为什么不用估算：实测「历时 × 单价」在两个方向上都会错很多 ——
      G531 北京南→上海虹桥 二等座估 ¥292，实际 **¥661**（低 56%）；
      G5148 深圳→马踏 二等座估 ¥127，实际 **¥278**（低 54%）。
    根因是**真实票价按里程、而估算按历时**：同样 1 分钟，跑 200km/h 的深茂铁路
    比跑 350km/h 的京沪高铁走得短得多。所以必须用 12306 的真实价格。
    """
    date = (request.args.get('date') or '').strip()
    items_raw = (request.args.get('items') or '').strip()
    if not date or not items_raw:
        return {'code': 1, 'msg': '缺少 date/items 参数', 'data': None}
    keys = []
    for chunk in items_raw.split('|'):
        parts = chunk.split(':')
        if len(parts) != 3 or not all(parts):
            continue
        key = (parts[0], parts[1], parts[2])
        if key not in keys:
            keys.append(key)
    if not keys:
        return {'code': 1, 'msg': 'items 格式应为 train_no:from_code:to_code', 'data': None}
    keys = keys[:150]        # 保险：单次最多 150 个车次

    def _to_code(value):
        """
        上/下站写成 3 位大写字母（如 SZQ）就是电报码，直接用；
        否则当站名解析（本地表 → 余票 map → 12306 官方站名表，见 `webx.stations`）。
        后两级兜底是为了「在经停站里改成中间站」后仍能查价 —— 那时行里的电报码已失效，
        只剩站名，而中间站很可能是本地表没有的新站（湛江北 / 茂名南 / 番禺…）。
        """
        s = str(value or '').strip()
        if len(s) == 3 and s.isalpha() and s.isupper():
            return s
        from py12306.webx import stations as st
        return st.code_of(s) or s

    result = {}
    missing = []
    now = time.time()
    for train_no, from_ref, to_ref in keys:
        from_code = _to_code(from_ref)
        to_code = _to_code(to_ref)
        cache_key = (train_no, from_code, to_code, date)
        hit = _PRICE_CACHE.get(cache_key)
        slot = '%s:%s:%s' % (train_no, from_ref, to_ref)
        if hit and (now - hit[0]) < _PRICE_TTL:
            result[slot] = hit[1]
        else:
            missing.append((cache_key, slot))

    if missing:
        try:
            import concurrent.futures
            session = _query_session()
            with concurrent.futures.ThreadPoolExecutor(max_workers=_PRICE_WORKERS) as pool:
                futures = {pool.submit(_fetch_price_one, session, ck[0], ck[1], ck[2], date): (ck, slot)
                           for (ck, slot) in missing}
                for fut in concurrent.futures.as_completed(futures):
                    cache_key, slot = futures[fut]
                    try:
                        prices = fut.result() or {}
                    except Exception:
                        prices = {}
                    # 只缓存「拿到了价格」的结果：空结果可能是临时失败，下次重试
                    if prices:
                        _PRICE_CACHE[cache_key] = (time.time(), prices)
                    result[slot] = prices
        except Exception as e:
            return {'code': 1, 'msg': '查询票价异常: %s' % e, 'data': None}

    return {'code': 0, 'msg': '', 'data': {'prices': result, 'date': date}}


@bp.route('/api/tickets/hits')
def tickets_hits():
    from py12306.webx.db import DataStore
    job_id = request.args.get('job_id')
    return {'code': 0, 'msg': '', 'data': {'hits': DataStore().hit_list(job_id=job_id, limit=200)}}
