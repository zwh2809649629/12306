# -*- coding: utf-8 -*-
import datetime
import json

from flask import Blueprint, request

from py12306.webx.db import DataStore

bp = Blueprint('jobs', __name__)


def _job_view(job, db):
    hits = db.query('SELECT * FROM hit_log WHERE job_id=? ORDER BY id DESC LIMIT 20', (job['job_id'],))
    in_memory = _running_job_names()
    active = bool(job.get('is_active'))
    return {
        'job_id': job['job_id'],
        'job_name': job.get('job_name') or '',
        'account_key': job.get('account_key'),
        'status': 'running' if (active and job.get('job_name') in in_memory) else ('paused' if not active else 'stopped'),
        'left_dates': json.loads(job['left_dates'] or '[]'),
        'stations': json.loads(job['stations'] or '[]'),
        'seats': json.loads(job['seats'] or '[]'),
        'train_numbers': json.loads(job['train_numbers'] or '[]'),
        'except_train_numbers': json.loads(job['except_train_numbers'] or '[]'),
        'members': json.loads(job['members'] or '[]'),
        'allow_less_member': bool(job.get('allow_less_member')),
        'period': {'from': job.get('period_from') or '00:00', 'to': job.get('period_to') or '24:00'},
        'interval': {'min': job.get('interval_min'), 'max': job.get('interval_max')},
        'is_active': active,
        'created_at': job.get('created_at'),
        'updated_at': job.get('updated_at'),
        'last_hit_at': job.get('last_hit_at'),
        'hit_count': job.get('hit_count') or 0,
        'hits': [{'train_number': h['train_number'], 'seat': h['seat'], 'num': h['num'],
                  'left_date': h['left_date'], 'at': h['at']} for h in hits],
    }


def _running_job_names():
    try:
        from py12306.query.query import Query
        return {getattr(j, 'job_name', '') for j in Query().jobs}
    except Exception:
        return set()


@bp.route('/api/jobs')
def jobs_list():
    db = DataStore()
    return {'code': 0, 'msg': '', 'data': {
        'jobs': [_job_view(j, db) for j in db.job_list()],
    }}


@bp.route('/api/jobs/<job_id>')
def jobs_detail(job_id):
    db = DataStore()
    job = db.job_get(job_id)
    if not job:
        return {'code': 1, 'msg': '任务不存在', 'data': None}, 404
    view = _job_view(job, db)
    # 命中时间线（最近 50）
    view['hit_timeline'] = db.query(
        'SELECT * FROM hit_log WHERE job_id=? ORDER BY id DESC LIMIT 50', (job_id,))
    # 该任务的日志片段
    view['logs'] = _job_logs(job.get('job_name'))
    # 账号信息
    acc = db.account_get(job.get('account_key')) or {}
    view['account'] = {'key': acc.get('key'), 'user_name': acc.get('user_name') or ''}
    return {'code': 0, 'msg': '', 'data': view}


def _job_logs(job_name, limit=100):
    if not job_name:
        return []
    try:
        from py12306.config import Config
        import os
        path = Config().OUT_PUT_LOG_TO_FILE_PATH
        if not path or not os.path.exists(path):
            return []
        with open(path, encoding='utf-8', errors='replace') as f:
            lines = f.readlines()
        out = []
        for raw in lines:
            if job_name in raw:
                out.append(raw.rstrip('\n'))
            if len(out) >= limit:
                break
        return out[-limit:]
    except Exception:
        return []


@bp.route('/api/stations')
def stations():
    q = (request.args.get('q') or '').strip()
    try:
        from py12306.helpers.station import Station
        s = Station()
    except Exception as e:
        return {'code': 1, 'msg': 'station unavailable: %s' % e, 'data': None}
    if not q:
        return {'code': 0, 'msg': '', 'data': {'list': []}}
    ql = q.lower()
    out = []
    for st in s.stations:
        if st['name'] in q or ql in st.get('pinyin', '').lower():
            out.append({'name': st['name'], 'pinyin': st.get('pinyin', ''), 'key': st['key']})
            if len(out) >= 20:
                break
    return {'code': 0, 'msg': '', 'data': {'list': out}}


@bp.route('/api/dates')
def dates():
    """今天 ~ 今天+31（12306 预售期内可选）"""
    today = datetime.date.today()
    out = []
    for i in range(0, 32):
        d = today + datetime.timedelta(days=i)
        out.append({
            'date': d.strftime('%Y-%m-%d'),
            'weekday': '一二三四五六日'[d.weekday()],
            'tag': 'today' if i == 0 else '',
        })
    return {'code': 0, 'msg': '', 'data': {'dates': out, 'max_day': 32}}
