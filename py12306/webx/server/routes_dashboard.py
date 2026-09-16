# -*- coding: utf-8 -*-
import json

from flask import Blueprint

from py12306.config import Config
from py12306.webx.config_store import ConfigStore
from py12306.webx.db import DataStore

bp = Blueprint('dashboard', __name__)


@bp.route('/api/dashboard')
def dashboard():
    db = DataStore()
    # --- 任务 ---
    jobs_db = db.job_list()
    running_jobs = []
    try:
        from py12306.query.query import Query
        for j in Query().jobs:
            running_jobs.append({
                'id': getattr(j, 'id', ''),
                'job_name': j.job_name,
                'is_alive': bool(getattr(j, 'is_alive', False)),
                'account_key': getattr(j, 'account_key', ''),
            })
    except Exception:
        pass    # 任务状态与 /api/jobs 保持同一口径（含账号未登录 / 已完成 / 已结束），排序也一致
    from py12306.webx.server.routes_jobs import _job_view, sort_job_views
    jobs_stat = []
    for job in jobs_db:
        view = _job_view(job, db)
        jobs_stat.append({
            'job_id': view['job_id'],
            'job_name': view['job_name'],
            'status': view['status'],
            'hit_count': view['hit_count'],
            'last_hit_at': view['last_hit_at'],
            'stations': view['stations'],
            'left_dates': view['left_dates'],
            'seats': view['seats'],
            'members': view['members'],
            'train_numbers': view.get('train_numbers') or [],
            'created_at': view.get('created_at') or '',
        })
    jobs_stat = sort_job_views(jobs_stat)

    # --- 账号 ---
    accounts = db.account_list()
    online = 0
    try:
        from py12306.user.user import User
        for u in User().users:
            if u.cookie and u.is_ready: online += 1
    except Exception:
        pass
    accounts_stat = [{'key': a['key'], 'user_name': a.get('user_name') or '',
                      'type': a.get('type'), 'active': bool(a.get('active'))} for a in accounts]

    # --- 查询统计 ---
    total_query = 0
    try:
        from py12306.log.query_log import QueryLog
        total_query = (QueryLog().data or {}).get('query_count') or 0
    except Exception:
        pass

    # --- 实时 feed（日志文件尾 8 行）---
    feed = _tail_lines(8)

    return {'code': 0, 'msg': '', 'data': {
        'stats': {
            'jobs_total': len(jobs_db),
            'jobs_running': sum(1 for j in jobs_stat if j['status'] == 'running'),
            'accounts_total': len(accounts),
            'accounts_online': online,
            'query_total': total_query,
            'query_today': db.daily_today(),
            'hit_total': db.hit_count(),
        },
        'jobs': jobs_stat,
        'accounts': accounts_stat,
        'daily': db.daily_series(7),
        'feed': feed,
    }}


@bp.route('/api/cluster')
def cluster():
    out = {
        'enabled': bool(Config().CLUSTER_ENABLED),
        'node_name': Config().NODE_NAME or '',
        'nodes': [],
    }
    if Config().CLUSTER_ENABLED:
        try:
            from py12306.cluster.cluster import Cluster
            c = Cluster()
            for name in list((c.nodes or {}).keys()):
                out['nodes'].append({'name': name,
                                     'master': str((c.nodes or {}).get(name)) == str(c.KEY_MASTER)})
            out['master'] = out['nodes'] and [x for x in out['nodes'] if x['master']]
            out['is_master'] = bool(getattr(c, 'is_master', False))
        except Exception as e:
            out['nodes_error'] = str(e)
    return {'code': 0, 'msg': '', 'data': out}


def _tail_lines(n):
    path = Config().OUT_PUT_LOG_TO_FILE_PATH
    try:
        import os
        if not path or not os.path.exists(path):
            return []
        with open(path, encoding='utf-8', errors='replace') as f:
            lines = f.readlines()
        out = []
        for raw in lines[-n:]:
            out.append(raw.rstrip('\n'))
        return out
    except Exception:
        return []
