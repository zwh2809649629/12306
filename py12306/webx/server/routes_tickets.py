# -*- coding: utf-8 -*-
import json
import threading

from flask import Blueprint, request

from py12306.config import Config

bp = Blueprint('tickets', __name__)

# 简单并发限流：最多 3 个查询并发
_sem = threading.Semaphore(3)

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
    try:
        from py12306.helpers.station import Station
        left_code = Station.get_station_key_by_name(left)
        arrive_code = Station.get_station_key_by_name(arrive)
    except Exception:
        return {'code': 1, 'msg': '车站无法解析（请确认站名与 12306 一致）', 'data': None}
    try:
        api_type = None
        try:
            from py12306.query.query import Query
            api_type = Query().api_type or 'leftTicket/queryZ'
        except Exception:
            api_type = 'leftTicket/queryZ'
        from py12306.helpers.api import LEFT_TICKETS
        url = LEFT_TICKETS['url'].format(left_date=date, left_station=left_code,
                                         arrive_station=arrive_code, type=api_type)
        session = _query_session()
        with _sem:
            resp = session.get(url, timeout=Config().TIME_OUT_OF_REQUEST, allow_redirects=False)
        # Request() 在网络异常时返回的伪 response 无 status_code
        if getattr(resp, 'status_code', None) is None:
            return {'code': 1, 'msg': '连接 12306 失败（网络异常/超时，请检查网络后重试）', 'data': None}
        if not resp.status_code == 200:
            return {'code': 1, 'msg': '12306 查询失败（HTTP %s，可能被频控，稍后重试）' % resp.status_code, 'data': None}
        result = resp.json().get('data.result')
        if not result:
            return {'code': 1, 'msg': '未查询到车次', 'data': None}
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
            try:
                left_name = Station.get_station_name_by_key(left_st)
                arrive_name = Station.get_station_name_by_key(arrive_st)
            except Exception:
                continue
            minutes = _duration_minutes(left_time, arrive_time)
            seat_map = {}
            for key, name in ALL_SEATS:
                try:
                    idx = Config.SEAT_TYPES[name]
                    seat_map[key] = t[idx] if t[idx] not in ('', 'N') else '无'
                except (KeyError, IndexError):
                    seat_map[key] = '无'
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
        return {'code': 0, 'msg': '', 'data': {'rows': rows, 'left': left, 'arrive': arrive, 'date': date}}
    except Exception as e:
        return {'code': 1, 'msg': '查询异常: %s' % e, 'data': None}


def _query_session():
    """
    优先复用 Query() 已初始化的共享 session（已带 RAIL_DEVICEID/RAIL_EXPIRATION 特征 cookie，
    12306 余票接口对无设备特征的裸请求会 302 拒绝）。Query 未初始化时才回退到新 session。
    仅调用只读属性，不改动 Query 逻辑。
    """
    try:
        from py12306.query.query import Query
        s = Query()
        return getattr(s, 'session', None) or _new_session()
    except Exception:
        return _new_session()


def _new_session():
    from py12306.helpers.request import Request
    return Request()


def _duration_minutes(dep, arr):
    """出发 → 到达 历时分钟（跨天 +1440）"""
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
