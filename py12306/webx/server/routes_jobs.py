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


def _engine_jobs():
    """
    引擎内存里的任务实例 {job_name: is_alive}。
    用 is_alive 而不只是「在不在列表里」：`Job.destroy()` 会先置 `is_alive=False`，
    下次 `update_query_jobs()` 才把它从 `Query().jobs` 里摘掉 ——
    两个阶段都能判定为「已结束」。
    引擎未起时不调用 `Query()`（避免其 __init__ 的网络初始化），直接返回空。
    """
    try:
        from py12306.query.query import Query
        ins = Query.__dict__.get('__it__')
        if ins is None:
            return {}
        return {getattr(j, 'job_name', ''): bool(getattr(j, 'is_alive', False))
                for j in (getattr(ins, 'jobs', None) or [])}
    except Exception:
        return {}


def _account_state():
    """引擎内存里的账号状态 {key: {'is_ready','user_name'}}；引擎没起时返回 {}（由调用方回落 DB）"""
    out = {}
    try:
        from py12306.user.user import User
        ins = User.__dict__.get('__it__')
        if ins is None:
            return out
        for u in (getattr(ins, 'users', None) or []):
            key = str(getattr(u, 'key', '') or '')
            if not key:
                continue
            out[key] = {'is_ready': bool(getattr(u, 'is_ready', False)),
                        'user_name': getattr(u, 'user_name', '') or ''}
    except Exception:
        pass
    return out


def _account_ready(db, account_key, runtime):
    """
    账号是否可用。
    - 引擎里有该账号对象 → 以 `is_ready` 为准（这是真正的「可用」）。
    - 引擎里没有（还没起来 / 已销毁）→ 回落 DB：扫码成功过（login_ok）且未登出（active）。
      否则启动瞬间会把所有任务误判成「账号未登录」。
    """
    key = str(account_key or '')
    if not key:
        return False, ''
    if key in runtime:
        return runtime[key]['is_ready'], runtime[key]['user_name']
    acc = db.account_get(key) or {}
    return bool(acc.get('login_ok')) and bool(acc.get('active')), acc.get('user_name') or ''


def _job_status(job, active, alive, acc_ready, order_success):
    """
    任务状态（文案在前端 JOB_STATUS）。

    顺序很重要：
    1. **存在成功的下单记录 → completed**。终态且时效性强（12306 要求 30 分钟内支付），
       不能被其它状态掩盖。注意传进来的应是「是否存在任一 success 记录」，
       而不是「最新一条订单记录的状态」—— 后者会被后续的 queued/failed 覆盖。
    2. **用户主动暂停 → paused**：必须在 finished_at 之前判。
       因为暂停会从 QUERY_JOBS 摘除任务 → 引擎 `Job.destroy()` → 我们的钩子
       会写 finished_at，若先判 finished_at 就会把「已暂停」错显示成「已结束」。
    3. 引擎已结束（finished_at）→ finished。
    4. 账号掉了 → blocked：引擎卡在 `wait_for_ready()`，一条查询都发不出去，
       **绝不能显示「运行中」**（用户就是这样「卡住没提示」）。
    5. 在内存且存活 → running。
    6. 其余 → pending（已启用但还未被引擎加载）。
    """
    if order_success:
        return 'completed'
    if not active:
        return 'paused'
    if job.get('finished_at'):
        return 'finished'
    if not acc_ready:
        return 'blocked'
    if alive:
        return 'running'
    return 'pending'


# 列表排序权重：正在运行 > （账号未登录）> 待启动 > 已暂停 > 已完成 > 已结束。
# 放在后端是为了让「抢票任务」与「总览」两处顺序天然一致。
_STATUS_RANK = {'running': 0, 'blocked': 1, 'pending': 2,
                'paused': 3, 'completed': 4, 'finished': 5}


def status_rank(status):
    return _STATUS_RANK.get(str(status or ''), 9)


def _order_info(db, job_id):
    """
    下单记录（webx 自己的，非 12306 官方订单状态）。

    ⚠️ **不能只看最新一条**：每轮余票命中都会插一条 `queued`（或之后的 failed），
    只取最新一条会把之前的 `success` 盖掉 —— 于是已经出票的任务显示成「已结束/failed」，
    最要紧的「30 分钟内支付」提醒也一起消失。所以：
      - `state`：最新一条的状态，用于展示当前进展；
      - `has_success`：**是否存在任一 success 记录**，用于判定「已完成」；
      - 展示用的订单号/时间优先取那条 success。
    """
    rows = db.query(
        'SELECT status, message, train_number, train_date, created_at FROM order_log '
        'WHERE job_id IS ? ORDER BY id DESC LIMIT 1', (job_id,))
    latest = rows[0] if rows else {}
    ok_rows = db.query(
        'SELECT status, message, train_number, train_date, created_at FROM order_log '
        "WHERE job_id IS ? AND status='success' ORDER BY id DESC LIMIT 1", (job_id,))
    success = ok_rows[0] if ok_rows else {}
    shown = success or latest
    return {
        'state': str(latest.get('status') or ''),
        'has_success': bool(success),
        'message': shown.get('message') or '',
        'train': shown.get('train_number') or '',
        'at': shown.get('created_at') or '',
    }


def _job_view(job, db):
    hits = db.query('SELECT * FROM hit_log WHERE job_id=? ORDER BY id DESC LIMIT 20', (job['job_id'],))
    engine_jobs = _engine_jobs()
    active = bool(job.get('is_active'))
    acc_ready, acc_name = _account_ready(db, job.get('account_key'), _account_state())
    od = _order_info(db, job['job_id'])
    return {
        'job_id': job['job_id'],
        'job_name': job.get('job_name') or '',
        'account_key': job.get('account_key'),
        'account_name': acc_name,
        'account_ready': bool(acc_ready),
        'status': _job_status(job, active, engine_jobs.get(job.get('job_name'), False),
                              acc_ready, od['has_success']),
        # 订单状态（webx 自己的下单记录，非 12306 官方订单状态）
        'order_state': od['state'],
        'order_success': od['has_success'],
        'order_message': od['message'],
        'order_train': od['train'],
        'order_at': od['at'],
        # 引擎结束任务的时间与原因
        'finished_at': job.get('finished_at') or '',
        'finish_reason': job.get('finish_reason') or '',
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


@bp.route('/api/jobs')
def jobs_list():
    db = DataStore()
    views = [_job_view(j, db) for j in db.job_list()]
    return {'code': 0, 'msg': '', 'data': {'jobs': sort_job_views(views)}}


def sort_job_views(views):
    """
    任务列表排序：正在运行 > 账号未登录 > 待启动 > 已暂停 > 已完成 > 已结束。
    同状态内「新的在前」。

    用两次 sort 而不是一次复合 key —— Python 的 sort 是稳定的：
    先按创建时间倒序，再按状态升序，第二次不会打乱同状态内的时间序。
    """
    out = list(views)
    out.sort(key=lambda v: str(v.get('created_at') or ''), reverse=True)
    out.sort(key=lambda v: status_rank(v.get('status')))
    return out


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
