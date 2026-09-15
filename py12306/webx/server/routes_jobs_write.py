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

from flask import Blueprint, request

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
        seg = pairs[0]['left'] + '→' + pairs[0]['arrive']
    elif pairs:
        seg = pairs[0]['left'] + '⇌' + pairs[-1]['left'] + '等%d区间' % len(pairs)
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
    job_id = db.job_create({
        'job_name': name,
        'account_key': account_key,
        'left_dates': dates,
        'stations': stations,
        'seats': seats,
        'train_numbers': train_numbers,
        'except_train_numbers': except_numbers,
        'members': [str(m) for m in (body.get('members') or []) if str(m)],
        'allow_less_member': 1 if body.get('allow_less_member') else 0,
        'period_from': _norm_period(body.get('period_from'), '00:00'),
        'period_to': _norm_period(body.get('period_to'), '24:00'),
        'interval_min': imin,
        'interval_max': imax,
        'is_active': 1,
    })
    ConfigSync.publish_jobs()
    CommonLog.add_quick_log('webx 创建任务: %s (%s)' % (name, job_id)).flush()
    return {'code': 0, 'msg': '已创建', 'data': {'job_id': job_id}}


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
        patch['is_active'] = 1 if body.get('is_active') else 0
    if 'job_name' in body:
        patch['job_name'] = str(body.get('job_name') or j.get('job_name') or '')
    if 'account_key' in body:
        patch['account_key'] = str(body.get('account_key') or '').strip()
    for field, key in (('left_dates', 'left_dates'), ('seats', 'seats'),
                       ('train_numbers', 'train_numbers'), ('except_train_numbers', 'except_train_numbers'),
                       ('members', 'members'), ('stations', 'stations')):
        if key in body and isinstance(body.get(key), list):
            patch[key] = body.get(key)
    for field in ('period_from', 'period_to'):
        if field in body:
            patch[field] = _norm_period(body.get(field), j.get(field) or ('00:00' if field == 'period_from' else '24:00'))
    if 'interval_min' in body:
        patch['interval_min'] = float(body.get('interval_min') or j.get('interval_min') or 1)
    if 'interval_max' in body:
        patch['interval_max'] = float(body.get('interval_max') or patch.get('interval_min') or 1)
    if not patch:
        return {'code': 1, 'msg': '无可更新字段', 'data': None}
    db.job_update(job_id, patch)
    ConfigSync.publish_jobs()
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
