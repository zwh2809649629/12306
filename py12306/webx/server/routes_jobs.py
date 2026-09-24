# -*- coding: utf-8 -*-
import json
import time

from flask import Blueprint, request

from py12306.webx.db import DataStore

# 引擎 Job.id → db job_id 索引缓存（见 _engine_index）
_ENGINE_INDEX = {}
_ENGINE_INDEX_AT = 0.0

bp = Blueprint('jobs', __name__)

# 12306 要求下单后 30 分钟内完成支付，超时订单会被取消。
# 窗口内 → `paying`（待支付，需要提醒）；窗口外 → `completed`（已完成，提示转灰）。
PAY_WINDOW_SECONDS = 30 * 60


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
    引擎内存里的任务实例 {Job.id: is_alive}。

    ⚠️ **必须按 Job.id 索引，不能按 job_name**：同名任务（用户很容易建两个
    「广州南→马踏·2026/10/01」）的 job_name 完全一样，按名字索引会让两个任务行
    共享同一个存活状态 → 一行显示「已暂停」另一行显示「运行中」，而日志只有任务名，
    用户就会看到「显示已暂停、后台还在跑」这种自相矛盾的现象。
    `Job.id = md5(job_info_dict)`，已加入唯一字段 `webx_id`（见 sync.job_info_dict），
    所以它是每个任务行唯一的。

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
        return {str(getattr(j, 'id', '') or ''): bool(getattr(j, 'is_alive', False))
                for j in (getattr(ins, 'jobs', None) or [])}
    except Exception:
        return {}


def _engine_index():
    """{Job.id: db job_id}（本模块缓存 5s；引擎未起时仍可用，纯 db 计算）"""
    global _ENGINE_INDEX, _ENGINE_INDEX_AT
    now = time.time()
    if _ENGINE_INDEX and (now - _ENGINE_INDEX_AT) < 5.0:
        return _ENGINE_INDEX
    try:
        from py12306.webx.sync import ConfigSync
        _ENGINE_INDEX = ConfigSync.engine_job_index()
        _ENGINE_INDEX_AT = now
    except Exception:
        pass
    return _ENGINE_INDEX


def _job_alive(job, engine_jobs=None):
    """该任务行在引擎里是否存活（按 Job.id 精确匹配）"""
    engine_jobs = _engine_jobs() if engine_jobs is None else engine_jobs
    if not engine_jobs:
        return False
    try:
        from py12306.helpers.func import md5
        from py12306.webx.sync import ConfigSync
        engine_id = md5(ConfigSync.job_info_dict(job))
    except Exception:
        return False
    return bool(engine_jobs.get(engine_id, False))


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


def _seconds_since(ts):
    """距给定 'YYYY-MM-DD HH:MM:SS' 的秒数；解析失败返回 None"""
    if not ts:
        return None
    try:
        return max(0.0, time.time() - time.mktime(time.strptime(str(ts)[:19], '%Y-%m-%d %H:%M:%S')))
    except Exception:
        return None


def _job_status(job, active, alive, acc_ready, order_success, paying):
    """
    任务状态（文案在前端 JOB_STATUS）。

    顺序很重要：
    1. **存在成功的下单记录** → `paying`（仍在 30 分钟支付窗口内）/ `completed`（已超时）。
       这是终态且时效性强，不能被其它状态掩盖。注意传进来的应是
       「是否存在任一 success 记录」，而不是「最新一条订单记录的状态」——
       后者会被后续的 queued/failed 覆盖。
    2. **用户主动暂停 → paused**：必须在 finished_at 之前判。
       因为暂停会从 QUERY_JOBS 摘除任务 → 引擎 `Job.destroy()` → 我们的钩子
       会写 finished_at，若先判 finished_at 就会把「已暂停」错显示成「已结束」。
    3. 引擎已结束（finished_at）→ finished。
    4. 开始时间仍在未来 → scheduled（任务已启用，但尚未进入查询）。
    5. 账号掉了 → blocked：引擎卡在 `wait_for_ready()`，一条查询都发不出去，
       **绝不能显示「运行中」**（用户就是这样「卡住没提示」）。
    6. 在内存且存活 → running。
    7. 其余 → pending（已启用但还未被引擎加载）。
    """
    if order_success:
        return 'paying' if paying else 'completed'
    if not active:
        return 'paused'
    if job.get('finished_at'):
        return 'finished'
    try:
        from py12306.webx.job_schedule import is_future_start
        if is_future_start(job.get('start_at')):
            return 'scheduled'
    except Exception:
        pass
    if not acc_ready:
        return 'blocked'
    if alive:
        return 'running'
    return 'pending'


# 列表排序权重：运行中 / 待支付优先，其次账号阻塞与定时中，再到待启动和终态。
# 放在后端是为了让「抢票任务」与「总览」两处顺序天然一致。
_STATUS_RANK = {'running': 0, 'paying': 1, 'blocked': 2, 'scheduled': 3, 'pending': 4,
                'paused': 5, 'completed': 6, 'finished': 7}


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
    at = shown.get('created_at') or ''
    # 下单成功距现在多久 → 还在 30 分钟支付窗口内吗
    elapsed = _seconds_since(at) if success else None
    return {
        'state': str(latest.get('status') or ''),
        'has_success': bool(success),
        'paying': bool(success) and elapsed is not None and elapsed < PAY_WINDOW_SECONDS,
        'elapsed': int(elapsed) if elapsed is not None else None,
        'message': shown.get('message') or '',
        'train': shown.get('train_number') or '',
        'at': at,
    }


def _job_view(job, db):
    hits = db.query('SELECT * FROM hit_log WHERE job_id=? ORDER BY id DESC LIMIT 20', (job['job_id'],))
    engine_jobs = _engine_jobs()
    active = bool(job.get('is_active'))
    acc_ready, acc_name = _account_ready(db, job.get('account_key'), _account_state())
    od = _order_info(db, job['job_id'])
    catalog = db.job_catalog_get(job['job_id'])
    catalog_state = (catalog or {}).get('state') or 'missing'
    catalog_count = int((catalog or {}).get('train_count') or 0)
    try:
        from py12306.webx.job_schedule import normalize_start_at
        start_at = normalize_start_at(job.get('start_at'))
    except Exception:
        start_at = job.get('start_at') or ''
    return {
        'job_id': job['job_id'],
        'job_name': job.get('job_name') or '',
        'account_key': job.get('account_key'),
        'account_name': acc_name,
        'account_ready': bool(acc_ready),
        # 按 Job.id 判存活（同名任务必须能区分）；同时把「引擎里确实有实例」暴露出去，
        # 前端/排查时能看出「库说已暂停但引擎还在跑」这类不一致
        'engine_alive': _job_alive(job, engine_jobs),
        'status': _job_status(job, active, _job_alive(job, engine_jobs),
                              acc_ready, od['has_success'], od['paying']),
        # 订单状态（webx 自己的下单记录，非 12306 官方订单状态）
        'order_state': od['state'],
        'order_success': od['has_success'],
        'order_paying': od['paying'],
        'order_elapsed': od['elapsed'],
        'pay_window': PAY_WINDOW_SECONDS,
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
        'start_at': start_at,
        'query_mode': job.get('query_mode') or '',
        # 站点匹配方式：exact=仅指定站名（新建任务的默认）/ expand=同城站扩展（「广州」= 10 个站）。
        # 12306 的余票结果本来就会混入同城其它站（AGENTS.md §5.25），这里决定过滤的宽严。
        # ⚠️ 兜底值仍是 'expand'：列刚加时 ALTER TABLE 给历史行填的就是 'expand'，
        #    只会在行为真的读不到该列时才会走到（保持老任务原行为，不要静默改语义）。
        'station_mode': job.get('station_mode') or 'expand',
        'is_active': active,
        'created_at': job.get('created_at'),
        'updated_at': job.get('updated_at'),
        'last_hit_at': job.get('last_hit_at'),
        'hit_count': job.get('hit_count') or 0,
        # 按任务统计的查询次数（引擎每发一条余票查询请求 +1，见 engine_hooks._hook_query_count）
        'query_count': job.get('query_count') or 0,
        'catalog_state': catalog_state,
        'catalog_train_count': catalog_count,
        'catalog_empty': catalog_state in ('empty', 'partial', 'ready') and catalog_count == 0,
        'catalog_failed': catalog_state == 'failed',
        'catalog_message': (catalog or {}).get('message') or '',
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
    catalog = db.job_catalog_get(job_id)
    try:
        catalog_items = json.loads(catalog.get('payload') or '[]') if catalog else []
    except Exception:
        catalog_items = []
    view['train_catalog'] = {
        'state': catalog.get('state') if catalog else 'missing',
        'message': catalog.get('message') if catalog else '',
        'updated_at': catalog.get('updated_at') if catalog else '',
        'items': catalog_items,
    }
    # 命中时间线（最近 50）
    view['hit_timeline'] = db.query(
        'SELECT * FROM hit_log WHERE job_id=? ORDER BY id DESC LIMIT 50', (job_id,))
    # 下单阶段事件（命中 → 受理 → 确认页 → 校验 → 排队 → 确认 → 成单/失败）
    view['events'] = _job_events(db, job_id)
    # 量化指标（全部由已有数据推导，不新增统计口径）
    view['metrics'] = _job_metrics(view, db)
    # 该任务的日志片段
    view['logs'] = _job_logs(job.get('job_name'))
    # 账号信息
    acc = db.account_get(job.get('account_key')) or {}
    view['account'] = {'key': acc.get('key'), 'user_name': acc.get('user_name') or ''}
    return {'code': 0, 'msg': '', 'data': view}


def _diff_seconds(a, b):
    """两个 'YYYY-MM-DD HH:MM:SS' 之间的秒数（b - a）；解析失败返回 None"""
    if not a or not b:
        return None
    try:
        fa = time.mktime(time.strptime(str(a)[:19], '%Y-%m-%d %H:%M:%S'))
        fb = time.mktime(time.strptime(str(b)[:19], '%Y-%m-%d %H:%M:%S'))
        return max(0, int(round(fb - fa)))
    except Exception:
        return None


# 下单阶段事件的中文名（前端直接展示，避免前端再维护一份映射）
EVENT_LABELS = {
    'hit': '命中余票',
    'request': '提交下单请求',
    'initdc': '进入订单确认页',
    'check': '订单信息校验',
    'queue': '进入排队',
    'confirm': '排队确认',
    'success': '下单成功',
    'fail': '失败',
    # 站点过滤：12306 的同城站扩展会让「深圳北→广州南」的查询结果里混入
    # 「深圳北→广州东」等车次，引擎按用户输入过滤掉它们时记这条（见 engine_hooks._hook_station_filter）
    'skip': '站点过滤',
    'catalog_empty': '车次范围警告',
}


def _job_events(db, job_id, limit=80):
    """下单阶段事件，按时间正序返回（前端直接渲染成时序）"""
    try:
        rows = db.job_event_list(job_id, limit)
    except Exception:
        rows = []
    out = []
    for r in reversed(rows):        # job_event_list 是倒序（最新在前）
        kind = str(r.get('kind') or '')
        message = r.get('message') or ''
        prefix = '查询车次为空：'
        if kind == 'catalog_empty':
            message = '条件筛选未找到有效车次'
        out.append({
            'kind': kind,
            'label': EVENT_LABELS.get(kind, kind),
            'message': message,
            'at': r.get('at') or '',
        })
    return out


def _job_metrics(view, db):
    """
    详情页用的量化指标。

    `requests_per_round` = 区间数 × 日期数 —— 引擎就是 `for station in stations:
    for date in left_dates` 两层循环，每轮一条请求，正好是「一轮查询要发多少条」。
    `hit_to_*` 用 job_event 推：一次下单尝试的时间线是
    hit → request → initdc → check → queue → confirm → success，
    取最近一次成功（或受理）往前找紧邻的 hit 即可。
    """
    job_id = view.get('job_id')
    created = view.get('created_at')
    finished = view.get('finished_at')
    out = {
        'requests_per_round': len(view.get('stations') or []) * len(view.get('left_dates') or []),
        'query_count': int(view.get('query_count') or 0),
        'hit_count': int(view.get('hit_count') or 0),
        'hit_to_request': None,
        'hit_to_order': None,
        'since_last_hit': _seconds_since(view.get('last_hit_at')),
        'alive': (_diff_seconds(created, finished) if finished else _seconds_since(created)),
    }
    try:
        rows = db.query(
            "SELECT kind, at FROM job_event WHERE job_id IS ? "
            "AND kind IN ('hit','request','success') ORDER BY id DESC LIMIT 500", (job_id,))
    except Exception:
        rows = []
    rows = list(reversed(rows))      # 时间正序

    def _last(kind):
        for r in reversed(rows):
            if r.get('kind') == kind:
                return r
        return None

    def _hit_before(ts):
        best = None
        for r in rows:
            if r.get('kind') == 'hit' and str(r.get('at') or '') <= str(ts or ''):
                best = r
        return best

    for kind, key in (('success', 'hit_to_order'), ('request', 'hit_to_request')):
        target = _last(kind)
        if not target:
            continue
        hit = _hit_before(target.get('at'))
        if hit:
            out[key] = _diff_seconds(hit.get('at'), target.get('at'))
    return out


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
        out = [raw.rstrip('\n') for raw in lines if job_name in raw]
        return out[-limit:]
    except Exception:
        return []


@bp.route('/api/stations')
def stations():
    """
    站名联想。站名来源统一走 `webx.stations`（本地表 ∪ 12306 官方表）——
    本地 `data/stations.txt` 不含新开站（实测「湛江北」「茂名南」「番禺」都查不到），
    只用本地表时这些站在下拉里永远找不到、也没法在区间里填。
    """
    q = (request.args.get('q') or '').strip()
    if not q:
        return {'code': 0, 'msg': '', 'data': {'list': []}}
    from py12306.webx import stations as st
    # 拼音/电报码只有本地表有，先建一份索引（官方表只给 站名 + 电报码）
    pinyin_of, code_of = {}, {}
    try:
        from py12306.helpers.station import Station
        for info in Station().stations:
            nm = info.get('name') or ''
            if nm:
                pinyin_of[nm] = info.get('pinyin') or ''
                code_of[nm] = info.get('key') or ''
    except Exception:
        pass
    ql = q.lower()
    ranked = []
    for name in st.names():
        py = (pinyin_of.get(name) or '').lower()
        if name == q:
            score = 0
        elif name.startswith(q):
            score = 1
        elif py and py.startswith(ql):
            score = 2
        elif q in name:
            score = 3
        elif py and ql in py:
            score = 4
        elif q.upper() == (code_of.get(name) or '').upper():
            score = 5
        else:
            continue
        ranked.append((score, len(name), {'name': name, 'pinyin': pinyin_of.get(name, '')}))
    ranked.sort(key=lambda x: (x[0], x[1]))
    return {'code': 0, 'msg': '', 'data': {'list': [x[2] for x in ranked[:20]]}}


@bp.route('/api/stations/expand')
def stations_expand():
    """
    某个输入实际会匹配到哪些**车站**（规则与引擎侧 `webx/stations.py` 完全同源）。

    为什么需要它：12306 查询会做「同城站扩展」—— 查「深圳北 → 广州南」实际返回
    深圳北/福田/深圳 → 广州东/广州/新塘… 共 567 条结果，而引擎原先只按时段 + 车次白名单
    过滤、不校验行的实际到发站，于是真的把「深圳北 → 广州东」的票下了单。
    现在引擎侧按同一套规则过滤，这里把规则**展示给用户**，避免「我填了广州南，
    怎么广州东也算」这类意外（也顺手校验站名是否存在）。

    `mode=expand|exact`（默认 exact，与新建任务的默认一致）与任务的 `station_mode` 对应。
    """
    from py12306.webx import stations as st
    raw = request.args.get('q') or ''
    mode = (request.args.get('mode') or 'exact').strip().lower()
    if mode not in ('expand', 'exact'):
        mode = 'exact'
    items = [x for x in raw.split('|') if x.strip()]
    if not items:
        return {'code': 1, 'msg': '缺少 q 参数', 'data': None}
    return {'code': 0, 'msg': '', 'data': {
        'mode': mode,
        'list': [st.describe(x.strip(), mode) for x in items[:40]],
    }}


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
