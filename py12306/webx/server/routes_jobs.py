# -*- coding: utf-8 -*-
import json

from flask import Blueprint, request

from py12306.webx.db import DataStore

bp = Blueprint('jobs', __name__)


def _seat_tiers(job):
    """
    座次优先级，**统一归一成二维**（[['二等座'], ['硬卧','硬座']]），前端只按二维处理。
    兼容历史数据的三种形态：NULL（列未落库）、一维（等价于单级）、二维。
    """
    raw = None
    if job.get('seat_tiers'):
        try:
            raw = json.loads(job['seat_tiers'])
        except Exception:
            raw = None
    if not isinstance(raw, list) or not raw:
        try:
            raw = json.loads(job['seats'] or '[]')
        except Exception:
            raw = []
    if not isinstance(raw, list):
        raw = []
    if raw and not isinstance(raw[0], list):   # 一维 → 包一层（单级优先级）
        raw = [raw]
    return raw


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
        # 优先级结构（二维）；仅为展示/编辑用，引擎只消费上面展平的 seats。
        # 老数据（列未落库 / 一维）由 _seat_tiers 统一归一成二维。
        'seat_tiers': _seat_tiers(job),
        'train_numbers': json.loads(job['train_numbers'] or '[]'),
        'except_train_numbers': json.loads(job['except_train_numbers'] or '[]'),
        'members': json.loads(job['members'] or '[]'),
        'allow_less_member': bool(job.get('allow_less_member')),
        'period': {'from': job.get('period_from') or '00:00', 'to': job.get('period_to') or '24:00'},
        'interval': {'min': job.get('interval_min'), 'max': job.get('interval_max')},
        'start_at': job.get('start_at') or '',
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
    # 注意子串方向：应判断「输入」是否包含在「站名/拼音」里。
    # 原实现写成 `st['name'] in q`，输入「北」永远匹配不到「北京」→ 下拉恒为空。
    ranked = []
    for st in s.stations:
        name = st.get('name') or ''
        pinyin = (st.get('pinyin') or '').lower()
        key = (st.get('key') or '').upper()
        if name == q:
            score = 0
        elif name.startswith(q):
            score = 1
        elif pinyin.startswith(ql):
            score = 2
        elif q in name:
            score = 3
        elif ql and ql in pinyin:
            score = 4
        elif q.upper() == key:
            score = 5
        else:
            continue
        ranked.append((score, len(name), {'name': name, 'pinyin': st.get('pinyin', ''), 'key': st.get('key')}))
    ranked.sort(key=lambda x: (x[0], x[1]))
    return {'code': 0, 'msg': '', 'data': {'list': [x[2] for x in ranked[:20]]}}


@bp.route('/api/dates')
def dates():
    """
    日期条数据。区间以 12306 真实预售期为准（见 webx/presale.py），
    预售期外的日期以 open=False 返回，供前端置灰屏蔽。
    原先硬编码 32 天，其中后 17 天其实已超预售期、点了必然失败。
    """
    from py12306.webx import presale
    return {'code': 0, 'msg': '', 'data': {
        'dates': presale.window_dates(),
        'max_day': presale.presale_days(),
        'presale_days': presale.presale_days(),
        'first': presale.first_date().isoformat(),
        'last': presale.last_date().isoformat(),
        'note': presale.note(),
    }}
