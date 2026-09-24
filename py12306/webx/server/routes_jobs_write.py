# -*- coding: utf-8 -*-
"""
P2：任务写接口（创建/启停/删除）
POST /api/jobs            {name, account_key, left_dates[], stations[{left,arrive}], members[],
                           allow_less_member, seats[], train_numbers[], except_train_numbers[],
                           period_from, period_to, interval_min, interval_max}
PATCH /api/jobs/<id>      {is_active}  /  {job_name,...}
DELETE /api/jobs/<id>
批量：POST /api/jobs/toggle {ids:[], active} 暂停/启动多任务
"""
import json
import re

from flask import Blueprint, current_app, request

from py12306.log.common_log import CommonLog
from py12306.webx.db import DataStore
from py12306.webx.sync import ConfigSync
from py12306.webx.server.routes_jobs import _job_view

bp = Blueprint('jobs_write', __name__)
VALID_PERIOD = re.compile(r'^([01]\d|2[0-4]):[0-5]\d$')


def _norm_period(value, dflt):
    value = (value or '').strip()
    return value if VALID_PERIOD.match(value) else dflt


def _default_name(stations, dates):
    pairs = [s for s in (stations or []) if s.get('left') and s.get('arrive')]
    if len(pairs) == 1:
        seg = pairs[0]['left'] + ' 至 ' + pairs[0]['arrive']
    elif pairs:
        seg = pairs[0]['left'] + ' 至 ' + pairs[-1]['arrive'] + '等%d个区间' % len(pairs)
    else:
        seg = '未命名区间'
    date_part = ''
    ds = [d for d in (dates or []) if d]
    if ds:
        date_part = '·' + ds[0].replace('-', '/') + ('' if len(ds) == 1 else ('等%d天' % len(ds)))
    return (seg + date_part)[:40]


def _job_view_by_id(db, job_id):
    j = db.job_get(job_id)
    return _job_view(j, db) if j else None


@bp.route('/api/jobs', methods=['POST'])
def create_job():
    body = request.get_json(force=True) or {}
    stations = body.get('stations') or []
    stations = [
        {'left': str(s.get('left', '')).strip(), 'arrive': str(s.get('arrive', '')).strip()}
        for s in stations if isinstance(s, dict) and s.get('left') and s.get('arrive')
    ]
    if not stations:
        return {'code': 1, 'msg': '请至少填一组出发/到达', 'data': None}
    # 站点匹配方式：exact=仅指定站名（**默认**，引擎只抢与输入完全同名的站）/ expand=同城站扩展。
    # 12306 的余票结果本来就会混入同城其它站（AGENTS.md §5.25），默认取最不容易买错站的一种。
    station_mode = str(body.get('station_mode') or '').strip().lower()
    if station_mode not in ('expand', 'exact'):
        station_mode = 'exact'
    # 站名校验：站名写错时引擎的 `Station.get_station_key_by_name()` 会抛 KeyError，
    # 或（改名/新站时）拿不到电报码 → 查询静默失败、任务看起来在跑但永远没结果。
    # 这里提前拦住，并把「这个输入会匹配哪些站」一并回给前端，让同城扩展规则可见。
    try:
        from py12306.webx import stations as st_mod
        bad, hints = [], []
        for s in stations:
            for role, name in (('出发', s['left']), ('到达', s['arrive'])):
                info = st_mod.describe(name, station_mode)
                if not info['known']:
                    bad.append('%s站「%s」' % (role, name))
                elif station_mode == 'exact' and not info['exact']:
                    bad.append('%s站「%s」不是完整站名' % (role, name))
                else:
                    hints.append(info)
        if bad:
            tail = '（「仅指定站名」模式需从下拉里选完整站名）' if station_mode == 'exact' else '（可在输入框下拉里选择）'
            return {'code': 1, 'msg': '未收录或不合法：%s。请检查站名%s' % ('、'.join(bad), tail),
                    'data': None}
    except Exception:
        hints = None
    dates = [str(d).strip() for d in (body.get('left_dates') or []) if str(d).strip()]
    if not dates:
        return {'code': 1, 'msg': '请至少选择一个出行日期', 'data': None}
    account_key = str(body.get('account_key') or '').strip()
    db = DataStore()
    if not account_key or not db.account_get(account_key):
        return {'code': 1, 'msg': '请选择有效的 12306 账号', 'data': None}
    train_numbers = [str(t).strip().upper() for t in (body.get('train_numbers') or []) if str(t).strip()]
    except_numbers = [str(t).strip().upper() for t in (body.get('except_train_numbers') or []) if str(t).strip()]
    if train_numbers and except_numbers:
        return {'code': 1, 'msg': '指定车次与排除车次二选一', 'data': None}
    name = str(body.get('name') or '').strip() or _default_name(stations, dates)
    seats = [str(s).strip() for s in (body.get('seats') or []) if str(s).strip()]
    if not seats:
        return {'code': 1, 'msg': '请至少选择一种席别', 'data': None}
    try:
        imin = float(body.get('interval_min') or 1)
        imax = float(body.get('interval_max') or imin)
    except Exception:
        imin, imax = 1, 1
    imin, imax = max(0.5, imin), max(imin, min(60, imax))
    # 座次优先级（二维）：引擎只消费上面展平的 seats，这列只为把「哪几个属同一级」
    # 带到详情/编辑页做分级配色。**必须落库** —— 之前漏传导致该列恒为 NULL，
    # 接口回落到一维 seats，前端按二维处理时会 "xxx.forEach is not a function"。
    tiers = body.get('seat_tiers')
    if isinstance(tiers, list) and tiers:
        tiers = [[str(x).strip() for x in t if str(x).strip()]
                 for t in tiers if isinstance(t, list)]
        tiers = [t for t in tiers if t] or [seats]
    else:
        tiers = [seats]
    # 定时开始按北京时间存储，支持到秒；非法时间和已过期的新时间明确拒绝。
    from py12306.webx.job_schedule import is_future_start, normalize_start_at
    try:
        start_at = normalize_start_at(body.get('start_at'))
    except ValueError as exc:
        return {'code': 1, 'msg': str(exc), 'data': None}
    start_mode = str(body.get('start_mode') or ('at' if start_at else 'now')).strip().lower()
    if start_mode not in ('now', 'at'):
        return {'code': 1, 'msg': '开始模式无效，请重新选择', 'data': None}
    if start_mode == 'at' and not start_at:
        return {'code': 1, 'msg': '已选择定时开始，请填写到秒的开始时间', 'data': None}
    if start_mode == 'now':
        start_at = ''
    if start_at and not is_future_start(start_at):
        return {'code': 1, 'msg': '定时开始时间必须晚于当前北京时间', 'data': None}
    job_id = db.job_create({
        'job_name': name,
        'account_key': account_key,
        'left_dates': dates,
        'stations': stations,
        'seats': seats,
        'seat_tiers': tiers,
        'train_numbers': train_numbers,
        'except_train_numbers': except_numbers,
        'members': [str(m) for m in (body.get('members') or []) if str(m)],
        'allow_less_member': 1 if body.get('allow_less_member') else 0,
        'period_from': _norm_period(body.get('period_from'), '00:00'),
        'period_to': _norm_period(body.get('period_to'), '24:00'),
        'interval_min': imin,
        'interval_max': imax,
        'start_at': start_at,
        'query_mode': 'train' if body.get('query_mode') == 'train' else 'range',
        'station_mode': station_mode,
        'is_active': 1,
    })
    ConfigSync.publish_jobs()
    try:
        from py12306.webx.task_catalog import enqueue_job_catalog
        enqueue_job_catalog(current_app._get_current_object(), job_id)
    except Exception as e:
        CommonLog.add_quick_log('webx 任务车次详情缓存启动失败: %s' % e).flush()
    start_note = ('定时开始 北京时间 ' + start_at) if start_at else '立即开始'
    CommonLog.add_quick_log('webx 创建任务: %s (%s) [%s]' % (name, job_id, start_note)).flush()
    # 把「区间 → 实际匹配的车站」回给前端写进日志：同城扩展是引擎侧的过滤规则，
    # 不写出来用户根本不知道「广州」= 6 个站、「广州南」= 只 1 个站。
    if hints:
        for h in hints:
            CommonLog.add_quick_log('webx 区间站点(%s): %s 至 %s'
                                    % (station_mode, h['input'], h['note'])).flush()
    return {'code': 0, 'msg': '已创建',
            'data': {'job_id': job_id, 'station_notes': hints or [], 'station_mode': station_mode,
                     'start_mode': start_mode, 'start_at': start_at}}


@bp.route('/api/jobs/toggle', methods=['POST'])
def batch_toggle():
    body = request.get_json(force=True) or {}
    ids = body.get('ids') or []
    active = body.get('active')
    db = DataStore()
    changed = []
    for jid in ids:
        j = db.job_get(str(jid))
        if not j:
            continue
        db.job_toggle_active(str(jid), 1 if active else 0)
        changed.append({'job_id': str(jid), 'is_active': 1 if active else 0})
    ConfigSync.publish_jobs()
    return {'code': 0, 'msg': '已更新', 'data': {'updated': changed}}


@bp.route('/api/jobs/<job_id>', methods=['PATCH', 'POST'])
def update_job(job_id):
    body = request.get_json(force=True) or {}
    db = DataStore()
    j = db.job_get(job_id)
    if not j:
        return {'code': 1, 'msg': '任务不存在', 'data': None}, 404
    patch = {}
    if 'is_active' in body:
        on = 1 if body.get('is_active') else 0
        patch['is_active'] = on
        # 重新启用要清掉「已结束」标记：否则引擎 destroy 过的任务会一直停在「已完成/已结束」，
        # 点了开始也不会回到待启动/运行中
        if on:
            patch['finished_at'] = None
            patch['finish_reason'] = None
    # 新建/编辑页提交的字段名是 name；job_name 为兼容旧调用方
    if 'job_name' in body or 'name' in body:
        patch['job_name'] = str(body.get('job_name') or body.get('name') or j.get('job_name') or '')
    if 'account_key' in body:
        patch['account_key'] = str(body.get('account_key') or '').strip()
    for field, key in (('left_dates', 'left_dates'), ('seats', 'seats'), ('seat_tiers', 'seat_tiers'),
                       ('train_numbers', 'train_numbers'), ('except_train_numbers', 'except_train_numbers'),
                       ('members', 'members'), ('stations', 'stations')):
        if key in body and isinstance(body.get(key), list):
            patch[key] = body.get(key)
    # 站点匹配方式（exact / expand）；非法值就保持任务原有设置，不要强行重置
    if 'station_mode' in body:
        sm = str(body.get('station_mode') or '').strip().lower()
        if sm in ('expand', 'exact'):
            patch['station_mode'] = sm
    if 'query_mode' in body:
        qm = str(body.get('query_mode') or '').strip().lower()
        if qm in ('train', 'range'):
            patch['query_mode'] = qm
    # 定时开始：接受旧的分钟格式并补秒；新改的时间必须在未来。
    if 'start_at' in body or 'start_mode' in body:
        from py12306.webx.job_schedule import is_future_start, normalize_start_at
        try:
            raw_start = body.get('start_at') if 'start_at' in body else j.get('start_at')
            sa = normalize_start_at(raw_start)
        except ValueError as exc:
            return {'code': 1, 'msg': str(exc), 'data': None}
        try:
            old_sa = normalize_start_at(j.get('start_at'))
        except ValueError:
            old_sa = ''
        start_mode = str(body.get('start_mode') or ('at' if sa else 'now')).strip().lower()
        if start_mode not in ('now', 'at'):
            return {'code': 1, 'msg': '开始模式无效，请重新选择', 'data': None}
        if start_mode == 'at' and not sa:
            return {'code': 1, 'msg': '已选择定时开始，请填写到秒的开始时间', 'data': None}
        if start_mode == 'now':
            sa = ''
        if sa and sa != old_sa and not is_future_start(sa):
            return {'code': 1, 'msg': '新的定时开始时间必须晚于当前北京时间', 'data': None}
        patch['start_at'] = sa
        if sa and sa != old_sa:
            patch['finished_at'] = None
            patch['finish_reason'] = None
    for field in ('period_from', 'period_to'):
        if field in body:
            patch[field] = _norm_period(body.get(field), j.get(field) or ('00:00' if field == 'period_from' else '24:00'))
    if 'interval_min' in body:
        patch['interval_min'] = float(body.get('interval_min') or j.get('interval_min') or 1)
    if 'interval_max' in body:
        patch['interval_max'] = float(body.get('interval_max') or patch.get('interval_min') or 1)
    if 'allow_less_member' in body:
        patch['allow_less_member'] = 1 if body.get('allow_less_member') else 0
    if not patch:
        return {'code': 1, 'msg': '无可更新字段', 'data': None}
    db.job_update(job_id, patch)
    ConfigSync.publish_jobs()
    catalog_fields = {'left_dates', 'stations', 'train_numbers', 'except_train_numbers',
                      'period_from', 'period_to', 'station_mode', 'query_mode'}
    if catalog_fields.intersection(patch):
        try:
            from py12306.webx.task_catalog import enqueue_job_catalog
            enqueue_job_catalog(current_app._get_current_object(), job_id)
        except Exception as e:
            CommonLog.add_quick_log('webx 任务车次详情缓存更新失败: %s' % e).flush()
    return {'code': 0, 'msg': '已更新', 'data': {'job': _job_view_by_id(db, job_id)}}


@bp.route('/api/jobs/<job_id>', methods=['DELETE'])
def delete_job(job_id):
    db = DataStore()
    j = db.job_get(job_id)
    if not j:
        return {'code': 1, 'msg': '任务不存在', 'data': None}, 404
    db.job_delete(job_id)
    ConfigSync.publish_jobs()
    return {'code': 0, 'msg': '已删除', 'data': {'deleted': job_id}}
