# -*- coding: utf-8 -*-
"""
webx 引擎事件落库钩子（P3）

背景
----
py12306 引擎把「余票命中」「下单成功」只输出到日志文件（QueryLog / OrderLog），
`webx.db` 里的 `hit_log` / `order_log` 没有任何写入方，导致：
  - 总览「命中总数」恒为 0、任务「最近动态」恒为空
  - 「确认订单」页没有任何下单记录

做法
----
**不修改任何 py12306 原文件**（与 webx12306.py「零改动原文件」约定一致），
用包装（wrapper）方式挂到两个引擎方法上：

  Job.do_order(self, user)        → 命中：即将向 12306 提交订单 → hit_log + order_log(submitted)
  Order.order_did_success(self)   → 成功：12306 已返回订单号     → order_log(success) + 关闭「即时」任务

挂载点选择理由：`Job.do_order` 是引擎里**唯一**在「座位有效 + 票数有效 + 用户就绪」之后
才会走到的位置（见 Job.handle_seats 尾部），语义正好等于「命中」；
`Order.order_did_success` 只在拿到订单号时调用，语义正好等于「下单成功」。

安装
----
main_web.py 中 ConfigSync.startup() 之后调用 install()。幂等，重复调用只包装一次。
所有回调内部 try/except 兜底：钩子自身异常绝不能影响抢票主流程。
"""

ONE_SHOT_PREFIX = '[即时] '

# 引擎 Job.id（= md5(job_info_dict)）→ db job_id 的缓存。
# 引擎侧只有 job_name 和这个 md5；**必须用 md5 定位任务行**：
# 同名任务的 job_name 是一样的，按名字反查会全部落到「最新那一行」，
# 导致命中/计数/结束状态记到错的任务上（实测踩过）。
# 缓存 5 秒；不缓存 None（任务可能还没入库，下次应重试）。
_JOB_ID_BY_ENGINE = {}
_JOB_ID_CACHE_AT = 0.0
_JOB_ID_CACHE_TTL = 5.0

# {thread_id: job_name} —— 「当前线程正在下单的任务」。
# 下单链路里 `request_init_dc_page` 挂在 UserJob 上（拿不到 job_name），
# 而它前面一步 `submit_order_request` 挂在 Order 上（有 self.query_ins.job_name）。
# 两步同线程、同一账号串行 → 用线程局部把任务名递过去。
_ORDER_CTX = {}


def _set_cur_job(job):
    try:
        import threading
        _ORDER_CTX[threading.get_ident()] = getattr(job, 'job_name', '') or ''
    except Exception:
        pass


_TICKET_STATION_CTX = {}
_QUERY_ROUTE_JOB_CTX = {}
def _cur_job_name():
    try:
        import threading
        return _ORDER_CTX.get(threading.get_ident(), '') or ''
    except Exception:
        return ''


def _engine_job_index():
    """{Job.id: db job_id}；5 秒 TTL（任务行增删改都由网页触发，量很小）"""
    global _JOB_ID_BY_ENGINE, _JOB_ID_CACHE_AT
    import time
    now = time.time()
    if _JOB_ID_BY_ENGINE and (now - _JOB_ID_CACHE_AT) < _JOB_ID_CACHE_TTL:
        return _JOB_ID_BY_ENGINE
    try:
        from py12306.webx.sync import ConfigSync
        _JOB_ID_BY_ENGINE = ConfigSync.engine_job_index()
        _JOB_ID_CACHE_AT = now
    except Exception:
        pass
    return _JOB_ID_BY_ENGINE


def _job_id_for(job):
    """
    引擎侧自己 → db job_id。

    `job` 可以是 Job 实例、`{'job': Job}`、或 job_name 字符串：
      · 传 Job 实例 → 用 `job.id`（唯一）精确匹配；
      · 传名字 → 只能按名字回落（同名任务会有歧义，尽量别用）。
    """
    if job is None:
        return None
    if isinstance(job, str):
        engine_id, name = '', job
    else:
        engine_id = str(getattr(job, 'id', '') or '')
        name = str(getattr(job, 'job_name', '') or '')
    idx = _engine_job_index()
    if engine_id and engine_id in idx:
        return idx[engine_id]
    if engine_id:
        # 缓存没命中（可能刚建任务 / 刚改过配置）→ 立刻重建一次
        try:
            from py12306.webx.sync import ConfigSync
            global _JOB_ID_BY_ENGINE, _JOB_ID_CACHE_AT
            import time
            _JOB_ID_BY_ENGINE = ConfigSync.engine_job_index()
            _JOB_ID_CACHE_AT = time.time()
            if engine_id in _JOB_ID_BY_ENGINE:
                return _JOB_ID_BY_ENGINE[engine_id]
        except Exception:
            pass
        return None
    if not name:
        return None
    try:
        from py12306.webx.db import DataStore
        return DataStore().job_id_by_name(name)
    except Exception:
        return None


def _jn(obj):
    """日志前缀：带上任务名。

    详情页的「实时日志」是按任务名过滤日志文件的（`_job_logs`），
    而下单流程的日志原本不带任务名 → 排队/提交订单那些行**根本不会出现在任务详情里**。
    """
    try:
        name = getattr(obj, 'job_name', '') or ''
        if not name and getattr(obj, 'query_ins', None) is not None:
            name = getattr(obj.query_ins, 'job_name', '') or ''
    except Exception:
        name = ''
    if not name:
        name = _cur_job_name()
    return ('[%s] ' % name) if name else ''


def _evjob(job, kind, message=''):
    """记一条下单阶段事件（失败不影响主流程）

    job 可以是 Job 实例、`{'job': Job}`，或直接传任务名字符串（不推荐，同名会有歧义）。
    """
    try:
        job_id = _job_id_for(job)
        if not job_id:
            return
        from py12306.webx.db import DataStore
        DataStore().job_event_add(job_id, kind, message)
    except Exception:
        pass


def install():
    """安装引擎钩子；失败只记日志，不影响启动"""
    if getattr(install, '_installed', False):
        return False
    install._installed = True
    try:
        _hook_response_json()
        _hook_log_timestamps()
        _hook_job_do_order()
        _hook_order_success()
        _hook_save_user()
        _hook_request_device_id()
        _hook_qr_login()
        _hook_get_user_passengers()
        _hook_get_user_info()
        _hook_can_access_passengers()
        _hook_query_loop()
        _hook_scheduled_job_runner()
        _hook_query_count()
        _hook_job_destroy()
        _hook_job_init_data()
        _hook_job_check_passengers()
        _hook_job_refresh_station()
        _hook_station_filter()
        _hook_query_train_log()
        _hook_ticket_station_log()
        _hook_log_thread()
        _hook_wait_for_ready()
        _hook_get_passenger_for_members()
        _hook_order_flow_guard()
        try:
            from py12306.log.common_log import CommonLog
            CommonLog.add_quick_log(
                'webx 引擎钩子已安装: response.json(Dict 修复) / do_order / order_did_success / '
                'save_user(空会话守卫) / request_device_id(防递归) / qr_login(让位网页扫码) / '
                'get_user_passengers / get_user_info(登录态确认) / can_access_passengers(就绪探针) / '
                'train_log(车次行实际区间) / '
                'query_loop(启用任务后自动查询) / query_count(按任务计数) / '
                'job_destroy(结束状态落库) / station_filter(只抢指定车站，修同城站扩展误下单) / '
                'seat_log(命中日志记录实际出发站和终点站) / '
                'log_thread(查询循环日志落盘) / wait_ready(账号等待限频+自愈) / '
                'get_passenger_for_members(跳过僵尸账号对象) / '
                'order_flow(订单状态机+阶段事件+防重复提交)').flush()
        except Exception:
            pass
        return True
    except Exception as e:
        try:
            from py12306.log.common_log import CommonLog
            CommonLog.add_quick_log('webx 引擎钩子安装失败（不影响抢票）: %s' % e).flush()
        except Exception:
            pass
        return False


def _hook_log_timestamps():
    """统一给 BaseLog.flush() 输出的每个日志批次加毫秒时间戳。"""
    import datetime
    import threading

    from py12306.log.base import BaseLog
    from py12306.log.query_log import QueryLog
    from py12306.query.job import Job
    import py12306.log.query_log as query_log_module

    if getattr(BaseLog.flush, '_webx_timestamp_wrapped', False):
        return

    original_flush = BaseLog.flush.__func__
    flush_lock = threading.RLock()
    query_job_context = threading.local()

    if not getattr(Job.start, '_webx_query_log_context_wrapped', False):
        original_job_start = Job.start

        def job_start(self, *args, **kwargs):
            previous = getattr(query_job_context, 'job', None)
            query_job_context.job = self
            try:
                return original_job_start(self, *args, **kwargs)
            finally:
                if previous is None:
                    try:
                        del query_job_context.job
                    except AttributeError:
                        pass
                else:
                    query_job_context.job = previous

        job_start._webx_query_log_context_wrapped = True
        job_start._webx_original = original_job_start
        Job.start = job_start

    def flush(cls, *args, **kwargs):
        with flush_lock:
            instance = cls()
            logs = instance.get_logs()
            if logs:
                first = next((i for i, item in enumerate(logs)
                              if str(item or '').strip()), None)
                if first is not None:
                    stamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
                    logs[first] = '%s %s' % (stamp, logs[first])
            return original_flush(cls, *args, **kwargs)

    flush._webx_timestamp_wrapped = True
    flush._webx_original = original_flush
    BaseLog.flush = classmethod(flush)

    # QueryLog.print_job_start 以前自己附带秒级时间，统一时间戳后去掉重复时间。
    if not getattr(QueryLog.print_job_start, '_webx_timestamp_wrapped', False):
        def print_job_start(cls, job_name):
            instance = cls()
            job = getattr(query_job_context, 'job', None)
            query_count = None
            if job is not None:
                try:
                    from py12306.webx.db import DataStore
                    row = DataStore().job_get(_job_id_for(job))
                    if row:
                        query_count = int(row.get('query_count') or 0) + 1
                except Exception:
                    pass
                if query_count is None:
                    query_count = int(getattr(job, '_webx_query_count', 0) or 0) + 1
            if query_count is None:
                query_count = int(instance.data.get('query_count', 0)) + 1
                message = '>> 第 {query_count} 次查询 {job_name}'.format(
                    query_count=query_count, job_name=job_name)
            else:
                task_id = _job_id_for(job) if job is not None else None
                if task_id:
                    message = '>> {job_name} {task_id} 第 {query_count} 次查询。'.format(
                        job_name=job_name, task_id=task_id, query_count=query_count)
                else:
                    message = '>> 本任务第 {query_count} 次查询 {job_name}'.format(
                        query_count=query_count, job_name=job_name)
            instance.add_log(message)
            instance.refresh_data()
            if query_log_module.is_main_thread():
                instance.flush(publish=False)
            return instance

        print_job_start._webx_timestamp_wrapped = True
        QueryLog.print_job_start = classmethod(print_job_start)


# ---------------- 日志落盘：查询循环所在的线程必须被当成「主线程」 ----------------
#
# ★ 症状：抢票任务在累计查询（`query_count` 一直涨），但**日志里什么都没有**。
#
# 根因：引擎把日志分成「主线程」与「子线程」两套缓冲，只有主线程才会落盘：
#   py12306/log/base.py:      add_log()  → is_main_thread() ? self.logs : self.thread_logs[tid]
#   py12306/log/query_log.py: print_job_start() → if is_main_thread(): self.flush()
#   py12306/query/job.py:     Job.start() 每轮结束 → if is_main_thread(): QueryLog.flush()
# 而 `_hook_query_loop()` 为了「0 任务启动后新建任务也能查询」，把单线程的查询循环
# 放到 **daemon 线程** 里跑（`Query.start()` 原本跑在主线程）。
# 于是 `is_main_thread()` 为假 → `>> 第 N 次查询 …` / `出发日期 …` / `耗时 …` 全部
# 只堆在 `thread_logs[tid]` 里**永不落盘**（还顺带无界增长占内存）。
#
# 实测证据：`runtime/webx.log` 里最后一条 `>> 第 N 次查询` 停在 13:56:58，
# 而 `runtime/query/status.json` 的 `query_count` 在同一时刻之后仍从 6145 涨到 6676+。
#
# 修法：把 webx 查询循环线程「视为主线程」。不能只改 `func.is_main_thread` ——
# 各模块是 `from ... import is_main_thread` 绑定的，必须逐个模块替换同名全局。
# **不修改 py12306 原文件。**
#
# ⚠️ 副作用评估：`sleep_forever()` 也用 `is_main_thread()`，但全项目无人调用
# （只有 `sleep_forever_when_in_test()` 引用它，而后者也没人调用），故安全。
# 代价是 `self.logs` 会被查询线程与主线程共用（引擎单线程模式本来就是这种用法）。

WEBX_LOG_THREAD_NAME = 'webx-query-loop'


def _hook_log_thread():
    import threading

    import py12306.helpers.func as func_mod

    if getattr(func_mod.is_main_thread, '_webx_wrapped', False):
        return
    original = func_mod.is_main_thread

    def is_main_thread():
        try:
            t = threading.current_thread()
            if getattr(t, '_webx_log_thread', False) or t.name == WEBX_LOG_THREAD_NAME:
                return True
        except Exception:
            pass
        return original()

    is_main_thread._webx_wrapped = True
    is_main_thread._webx_original = original

    # 逐模块替换（它们都是 from ... import 绑定的名字）
    mods = [func_mod]
    for name in ('py12306.log.base', 'py12306.log.query_log', 'py12306.query.job',
                 'py12306.web.web'):
        try:
            mod = __import__(name, fromlist=['*'])
            mods.append(mod)
        except Exception:
            pass
    for mod in mods:
        try:
            if hasattr(mod, 'is_main_thread'):
                mod.is_main_thread = is_main_thread
        except Exception:
            pass


# ---------------- 账号就绪等待：限频 + 自愈 ----------------
#
# ★ 症状：界面显示账号**已登录**，但日志每 3 秒刷一行「账号正在登录中，3 秒后自动重试」。
#
# 根因（实测确认，两个独立成因叠在一起）：
#  A. `UserJob.wait_for_ready()` 是**无界递归**：
#         if self.is_ready: return self
#         UserLog.add_quick_log(MESSAGE_WAIT_USER_INIT_COMPLETE).flush(); stay_second(3)
#         return self.wait_for_ready()
#     对象永远不 ready 时，调用它的线程就永久卡在这里，每 3 秒打一行。
#  B. `User.get_passenger_for_members()` 取的是 `self.users` 里**第一个** key 匹配项，
#     **不检查 is_alive / is_ready**；而 `UserJob.destroy()` 只把 is_alive 置 False、
#     不从 `User.users` 摘除 → 重新扫码/改账号后列表里会留着**僵尸对象**（is_ready 永远 False）。
#     于是「界面（读到的活对象）显示在线」+「日志（卡在僵尸对象上）显示正在登录中」同时成立。
#     （`ConfigSync._prune_dead_users()` 只在账号列表变化时才跑，救不了这个场景。）
#
# 修法：
#  1. 这里把 wait_for_ready 改成有界循环：先**尝试自愈**（读盘上的 cookie →
#     `load_user()` → `is_ready=True`），日志限频且带上账号名与原因；
#     遇到**已死对象**立即返回 None（调用方 `get_passenger_for_members` 的 `and` 会跳过它）。
#  2. `_hook_get_passenger_for_members()` 优先挑「活着且就绪」的对象，并顺手摘掉僵尸。
# **不修改 py12306 原文件。**

_WAIT_LOG_INTERVAL = 60          # 同一个账号的等待日志最短间隔（秒）
_WAIT_LAST_LOG = {}


def _hook_wait_for_ready():
    from py12306.user.job import UserJob

    if getattr(UserJob.wait_for_ready, '_webx_wrapped', False):
        return
    original = UserJob.wait_for_ready

    def wait_for_ready(self, *args, **kwargs):
        import time
        from py12306.log.user_log import UserLog
        if getattr(self, 'is_ready', False):
            return self

        key = str(getattr(self, 'key', '') or '')
        name = str(getattr(self, 'user_name', '') or key)
        healed = 0.0
        while not getattr(self, 'is_ready', False):
            # 僵尸对象（已 destroy）：绝不能再等，否则调用方永久卡死
            if not getattr(self, 'is_alive', True):
                now = time.time()
                if now - _WAIT_LAST_LOG.get('dead:' + key, 0) > _WAIT_LOG_INTERVAL:
                    _WAIT_LAST_LOG['dead:' + key] = now
                    UserLog.add_quick_log(
                        'webx 跳过已失效的账号对象: %s（引擎里还有可用对象，已改用它）' % name).flush()
                return None
            # 自愈：盘上有 cookie（网页扫码写过）就试着自己恢复，成功则立刻就绪
            now = time.time()
            if now - healed > _WAIT_LOG_INTERVAL:
                healed = now
                try:
                    if not getattr(self, 'is_first_time', lambda: True)() and self.load_user():
                        if getattr(self, 'is_ready', False):
                            return self
                except Exception:
                    pass
            if now - _WAIT_LAST_LOG.get(key, 0) > _WAIT_LOG_INTERVAL:
                _WAIT_LAST_LOG[key] = now
                UserLog.add_quick_log(
                    'webx 账号尚未就绪，正在等待: %s（每 %s 秒重试；若一直如此请到「账号管理」重新扫码）'
                    % (name, getattr(self, 'retry_time', 3))).flush()
            try:
                stay = float(getattr(self, 'retry_time', 3) or 3)
            except Exception:
                stay = 3
            time.sleep(stay)
        return self

    wait_for_ready._webx_wrapped = True
    wait_for_ready._webx_original = original
    UserJob.wait_for_ready = wait_for_ready


def _hook_get_passenger_for_members():
    """
    `User.get_passenger_for_members(members, account_key)` 的原实现：

        for user in self.users:
            if user.key == key and user.wait_for_ready():
                return user.get_passengers_by_members(members)

    它按**列表顺序**取第一个 key 匹配项，完全不看 is_alive / is_ready。
    `UserJob.destroy()` 只置 is_alive=False、不从 `User.users` 摘除 →
    旧账号对象（僵尸）会一直排在前面，于是这里永远卡在僵尸上（配合上面的无限递归，
    表现为每 3 秒刷「账号正在登录中」而界面依旧显示在线）。

    包装后：优先「活着且就绪」的对象 → 其次「活着的」→ 都没有就把僵尸摘掉再回落原实现。
    """
    from py12306.user.user import User

    if getattr(User.get_passenger_for_members, '_webx_wrapped', False):
        return
    original = User.get_passenger_for_members

    def get_passenger_for_members(cls, members, key):
        try:
            users = list(getattr(cls(), 'users', None) or [])
            mine = [u for u in users if str(getattr(u, 'key', '')) == str(key)]
            if mine:
                live = [u for u in mine if getattr(u, 'is_alive', True)]
                ready = [u for u in live if getattr(u, 'is_ready', False)]
                target = (ready or live or [None])[0]
                if target is not None:
                    got = target.wait_for_ready()
                    if got is not None:
                        return got.get_passengers_by_members(members)
                # 同名对象全是僵尸 → 摘掉，避免每次调用都重走一遍
                if not live:
                    keep = [u for u in users if u not in mine]
                    if len(keep) != len(users):
                        try:
                            cls().users[:] = keep
                        except Exception:
                            pass
        except Exception:
            pass
        return original(members, key)

    wrapped = classmethod(get_passenger_for_members)
    wrapped._webx_wrapped = True
    wrapped._webx_original = original
    User.get_passenger_for_members = wrapped


# ---------------- 查询循环：从 0 任务恢复时自动拉起 ----------------
#
# 原版 Query.start() 在单线程模式下遇到 self.jobs 为空会直接 break 并返回。

# 服务以 0 个任务启动后，网页新建/启用任务只会调 update_query_jobs()，
# 新 Job 虽然已加入内存，但已退出的 start() 不会自动重启，因而永远不发查询。
#
# 这里同时包装 start / update_query_jobs：
#   - start 用锁和运行标记保证同一时刻只有一个查询循环；
#   - 任务变更后若有可运行 Job 且循环已退出，用 daemon 线程重启；
#   - 刷新前摘掉已 destroy 的 Job，使“暂停后再启用”能重建实例。
# **不修改 py12306 原文件。**

def _hook_query_loop():
    import threading

    from py12306.app import Const
    from py12306.query.query import Query

    if getattr(Query.start, '_webx_wrapped', False):
        return

    original_start = Query.start
    original_update = Query.update_query_jobs
    state_lock = threading.Lock()

    def start(self, *args, **kwargs):
        with state_lock:
            if getattr(self, '_webx_query_loop_running', False):
                return None
            self._webx_query_loop_running = True
        try:
            from py12306.config import Config
            if Config().QUERY_JOB_THREAD_ENABLED:
                return original_start(self, *args, **kwargs)

            # Default engine mode is single-threaded. Dispatch ordinary jobs one round
            # at a time, while scheduler-owned jobs run in their own worker and are
            # omitted here. This avoids both duplicate execution and a busy loop when
            # only scheduled workers remain.
            from py12306.helpers.func import jobs_do
            from py12306.log.query_log import QueryLog
            from py12306.webx.job_schedule import is_engine_job_claimed, wait_query_wake
            QueryLog.init_data()
            while True:
                live = [job for job in (self.jobs or []) if getattr(job, 'is_alive', True)]
                if len(live) != len(self.jobs or []):
                    self.jobs[:] = live
                runnable = [job for job in live
                            if not is_engine_job_claimed(getattr(job, 'id', ''))]
                if runnable:
                    jobs_do(runnable, 'run')
                elif live:
                    if Const.IS_TEST:
                        return None
                    wait_query_wake(1.0)
                else:
                    return None
                if Const.IS_TEST:
                    return None
        finally:
            with state_lock:
                self._webx_query_loop_running = False

    def update_query_jobs(self, auto=False):
        if auto:
            try:
                self.jobs[:] = [job for job in (self.jobs or [])
                                if getattr(job, 'is_alive', True)]
            except Exception:
                pass

        result = original_update(self, auto=auto)

        if auto and not Const.IS_TEST:
            try:
                runnable = any(getattr(job, 'is_alive', True) for job in (self.jobs or []))
                running = bool(getattr(self, '_webx_query_loop_running', False))
                if runnable and not running:
                    th = threading.Thread(target=self.start, daemon=True,
                                          name=WEBX_LOG_THREAD_NAME)
                    # 标记为「日志主线程」：引擎只在主线程落盘（见 _hook_log_thread）
                    try:
                        th._webx_log_thread = True
                    except Exception:
                        pass
                    th.start()
            except Exception:
                pass
        return result

    start._webx_wrapped = True
    start._webx_original = original_start
    update_query_jobs._webx_wrapped = True
    update_query_jobs._webx_original = original_update
    Query.start = start
    Query.update_query_jobs = update_query_jobs


def _hook_scheduled_job_runner():
    from py12306.query.job import Job
    if getattr(Job.start, '_webx_schedule_wrapped', False):
        return
    original = Job.start

    def start(self, *args, **kwargs):
        try:
            from py12306.webx.job_schedule import current_worker_engine_id, is_engine_job_claimed
            engine_id = str(getattr(self, 'id', '') or '')
            if is_engine_job_claimed(engine_id) and current_worker_engine_id() != engine_id:
                return None
        except Exception:
            pass
        return original(self, *args, **kwargs)

    start._webx_schedule_wrapped = True
    start._webx_original = original
    Job.start = start


# ---------------- 任务结束：Query.Job.destroy ----------------
#
# 引擎会主动 destroy 任务：下单成功、排队成功但拿不到订单号（要求人工核对）、
# 以及乘客校验失败。之前只有日志（`查询任务 X 已结束`），DB 里没有任何痕迹，
# 于是页面只能显示「待启动」，与实际的「已完成 / 已结束」不符。
#
# 这里把结束状态与原因落库。**不修改 py12306 原文件。**
# 原因文案尽量可行动：区分「已购票」「待核对」「乘客校验失败」三种。

def _hook_query_count():
    """
    按任务统计「已查询次数」。

    `Job.query_by_date` 每调用一次 = 一条余票查询请求（引擎是
    `for station in stations: for date in left_dates` 两层循环），
    正好就是界面上「已查询」的含义。
    """
    from py12306.query.job import Job
    if getattr(Job.query_by_date, '_webx_wrapped', False):
        return
    original = Job.query_by_date

    def query_by_date(self, *args, **kwargs):
        try:
            self._webx_query_count = int(getattr(self, '_webx_query_count', 0) or 0) + 1
            from py12306.webx.db import DataStore
            DataStore().job_record_query(_job_id_for(self))
        except Exception:
            pass
        return original(self, *args, **kwargs)

    query_by_date._webx_wrapped = True
    query_by_date._webx_original = original
    Job.query_by_date = query_by_date


def _hook_job_destroy():
    from py12306.query.job import Job
    if getattr(Job.destroy, '_webx_wrapped', False):
        return
    original = Job.destroy
    def destroy(self):
        try:
            _record_job_finished(self)
        except Exception:
            pass
        return original(self)

    destroy._webx_wrapped = True
    destroy._webx_original = original
    Job.destroy = destroy


def _record_job_finished(job):
    """把「任务已被引擎结束」写进 job 表。

    ⚠️ 用 `Job.id`（唯一）定位任务行。早期用 job_name 反查，同名任务会全部落到
    「最新那一行」→ 结束状态记到错的任务上（界面就会出现「已暂停的那条被写成已结束」，
    或者两个同名任务中只有一个能拿到结束原因）。

    ⚠️ 必须跳过「用户主动暂停」：暂停会从 QUERY_JOBS 摘除任务 → 引擎
    `Query.refresh_jobs()` 对不在白名单里的 Job 调 `destroy()` → 如果这里无脑落
    finished_at，界面就会把「已暂停」显示成「已结束」。
    PATCH /api/jobs/<id> 是**先写 db 再 publish**，所以这里读到的 is_active 是可靠的。
    """
    from py12306.webx.db import DataStore
    db = DataStore()
    job_id = _job_id_for(job)
    if not job_id:
        return
    try:
        row = db.job_get(job_id) or {}
        if not row.get('is_active'):
            return          # 用户已暂停 → 不是「结束」，保留为 paused
        from py12306.webx.job_schedule import is_future_start
        if is_future_start(row.get('start_at')):
            return          # 任务被重新排到未来：移出查询列表不代表任务已结束
    except Exception:
        pass
    reason = '引擎已结束该任务'
    try:
        # ⚠️ 先看有没有 success：每轮命中都会插 queued/failed，
        # 只看最新一条会把出票那次成功盖掉，结束原因就写错了。
        ok = db.query("SELECT id FROM order_log WHERE job_id IS ? AND status='success' LIMIT 1",
                      (job_id,))
        if ok:
            reason = '已购票，任务自动结束'
        else:
            rows = db.query("SELECT status FROM order_log WHERE job_id IS ? ORDER BY id DESC LIMIT 1",
                            (job_id,))
            state = (rows[0]['status'] if rows else '') or ''
            reason = {
                'unknown': '订单已提交排队但未确认订单号，任务已停止待人工核对',
                'failed': '下单失败后任务结束',
            }.get(state, '引擎已结束该任务')
    except Exception:
        pass
    db.job_mark_finished(job_id, reason)


# ---------------- 站点过滤：只抢「用户指定的那对车站」 ----------------
#
# ★ 根因（实测确认，用户报「区间设了 深圳北 → 广州南，却下单了 深圳北 → 广州东」）：
#
# 12306 的余票查询会做**同城站扩展** —— 查「深圳北 → 广州南」实际返回 567 条，其中
#   到达站：广州南 208 / 广州东 132 / 新塘 87 / 广州 55 / 广州白云 42 / 广州北 38 / 番禺 3 / 花都 2
#   出发站：深圳北 277 / 福田 64 / 深圳 205 / 深圳东 16 / 深圳机场 5
# 而 `Job.is_trains_number_valid()` 只判「出发时段 + 车次白名单」，**完全没看站名**；
# `is_has_ticket()` 也只判 `canWebBuy == 'Y'` 且 `order_text == '预订'`。
# 于是「深圳北 → 广州东」(C8012) 完全符合条件 → 真的被下单（实测出了订单号）。
#
# 修法：包装 `Job.is_trains_number_valid`，在原有判断之上**再加一道站点校验** ——
# 行的**实际**到发站（`ticket_info[6]/[7]`）必须落在用户输入对应的站点集合里
# （规则见 `webx/stations.py`：具体站只匹配自己，城市名匹配该城市全部站）。
# 拿不到站名 / 站名无法解析时**放行**，避免把「站名写错」变成「一条也抢不到」的静默失败。
#
# 与原实现一致：回调内 try/except 兜底，异常绝不影响抢票主流程。

def _allowed_stations(requested, mode='expand'):
    """
    用户输入 → 允许的实际站名集合；无法判断时返回 None（= 不拦截）。

    `mode`：
      - `expand`（同城站扩展，默认）：城市按 12306 官方 city 归属扩展，具体站只匹配自己
      - `exact`（仅指定站名）  ：`广州` → 只算 `广州` 一个站；
        输入不是完整站名时返回 None（= 不拦截，避免静默变成「一条也抢不到」）
    """
    try:
        from py12306.webx import stations as st
        if mode == 'exact':
            return {requested} if st.is_exact_name(requested) else None
        hit = st.expand(requested)
        return set(hit) if hit else None
    except Exception:
        return None


def _refresh_job_query_mode(job):
    """Refresh query_mode from the unique WebX row without changing Job.id."""
    try:
        from py12306.webx.db import DataStore
        job_id = _job_id_for(job)
        row = DataStore().job_get(job_id) if job_id else None
        mode = str((row or {}).get('query_mode') or '').strip().lower()
        if mode in ('train', 'range'):
            job.webx_query_mode = mode
    except Exception:
        pass


def _job_station_mode(job):
    """
    任务级站点匹配方式（由 `_hook_job_init_data` 从 job_info_dict 挂到实例上）。
    ⚠️ 拿不到时兜底 `expand`（同城站扩展）：该字段是后加的，历史任务就是按这个语义
    跑过来的 —— 保持原行为，不要因为在旧对象上读不到就骤变成「仅指定站名」。
    """
    mode = str(getattr(job, 'webx_station_mode', '') or '').strip().lower()
    return mode if mode in ('expand', 'exact') else 'expand'


def _row_station_ok(job):
    """Filter actual ticket endpoints for both range and train query modes."""
    try:
        requested_left = getattr(job, 'left_station', '') or ''
        requested_arrive = getattr(job, 'arrive_station', '') or ''
        info = getattr(job, 'ticket_info', None)
        from py12306.webx import stations as st
        # 优先用行里的**原始电报码**（ticket_info[6]/[7]）自己解析站名：
        # 本地站点表缺新站，`job.get_info_of_left_station()` 在遇到未知码时
        # 会直接抛 AttributeError（实测余票响应里出现过本地表没有的 `PYA`）。
        actual_left = actual_arrive = None
        if info is not None:
            actual_left = st.name_of(info[6])
            actual_arrive = st.name_of(info[7])
            if not actual_left:
                _warn_station_unresolved(job, info[6], '出发', actual_left, actual_arrive)
            if not actual_arrive:
                _warn_station_unresolved(job, info[7], '到达', actual_left, actual_arrive)
        if not actual_left:
            actual_left = job.get_info_of_left_station()
        if not actual_arrive:
            actual_arrive = job.get_info_of_arrive_station()
    except Exception:
        return True, '', ''
    if not actual_left or not actual_arrive:
        return True, '', ''
    if not requested_left or not requested_arrive:
        return True, '', ''
    mode = _job_station_mode(job)
    ok_l = (_allowed_stations(requested_left, mode) or {actual_left})
    ok_r = (_allowed_stations(requested_arrive, mode) or {actual_arrive})
    return (actual_left in ok_l and actual_arrive in ok_r), actual_left, actual_arrive


def _note_station_skip(job, train_number, actual_left='', actual_arrive=''):
    """累计被过滤的车次行，并记录其实际上下车站。"""
    try:
        job._webx_station_skip_count = getattr(job, '_webx_station_skip_count', 0) + 1
        nums = getattr(job, '_webx_station_skip_trains', None)
        if nums is None:
            nums = job._webx_station_skip_trains = []
        route = '%s 至 %s' % (actual_left or '未知', actual_arrive or '未知')
        detail = '%s（%s）' % (train_number, route) if train_number else route
        if detail not in nums:
            nums.append(detail)
    except Exception:
        pass

def _warn_station_unresolved(job, code, side, actual_left='', actual_arrive=''):
    """Warn once when an actual ticket station code has no name mapping."""
    try:
        warned = getattr(job, '_webx_unresolved_station_codes', None)
        if warned is None:
            warned = job._webx_unresolved_station_codes = set()
        key = '%s:%s' % (side, code)
        if key in warned:
            return
        warned.add(key)
        train = _call(job, 'get_info_of_train_number') or '未知车次'
        route = '%s 至 %s' % (actual_left or '未知站', actual_arrive or '未知站')
        message = '%s车次 %s（%s）站点解析失败：%s站电报码 %s 未映射' % (_jn(job), train, route, side, code or '空')
        from py12306.log.common_log import CommonLog
        CommonLog.add_quick_log(message).flush()
        _evjob(job, 'warning', message)
    except Exception:
        pass

def _emit_station_skip_summary(job):
    """每个 Job 实例首次完成一批余票响应后，汇总打印一次站点过滤数。"""
    if getattr(job, '_webx_station_skip_logged', False):
        return
    count = int(getattr(job, '_webx_station_skip_count', 0) or 0)
    if count <= 0:
        return
    job._webx_station_skip_logged = True
    trains = getattr(job, '_webx_station_skip_trains', []) or []
    message = '已按站点过滤 %d 条非目标车站的车次' % count
    if trains:
        message += '（车次及实际区间：%s%s）' % ('、'.join(trains[:8]), '…' if len(trains) > 8 else '')
    try:
        from py12306.log.common_log import CommonLog
        CommonLog.add_quick_log('%s%s' % (_jn(job), message)).flush()
    except Exception:
        pass
    _evjob(job, 'skip', message)

def _webx_time_delta(value):
    """Parse HH:MM as hours and minutes; 24:00 naturally becomes one day."""
    from datetime import timedelta
    try:
        hour, minute = str(value or '').strip().split(':', 1)
        return timedelta(hours=int(hour), minutes=int(minute))
    except Exception:
        return None

def _hook_job_refresh_station():
    """Resolve new stations (e.g. 茂名南) through WebX's official station map."""
    from py12306.query.job import Job
    if getattr(Job.refresh_station, '_webx_station_resolve_wrapped', False):
        return
    original = Job.refresh_station

    def refresh_station(self, station, *args, **kwargs):
        left = str((station or {}).get('left') or '').strip()
        arrive = str((station or {}).get('arrive') or '').strip()
        try:
            from py12306.webx import stations as st
            left_code = st.code_of(left)
            arrive_code = st.code_of(arrive)
            if left_code and arrive_code:
                self.left_station = left
                self.arrive_station = arrive
                self.left_station_code = left_code
                self.arrive_station_code = arrive_code
                return None
        except Exception:
            pass
        return original(self, station, *args, **kwargs)

    refresh_station._webx_station_resolve_wrapped = True
    refresh_station._webx_original = original
    Job.refresh_station = refresh_station
    for method_name, index_name in (
            ('get_info_of_left_station', 'INDEX_LEFT_STATION'),
            ('get_info_of_arrive_station', 'INDEX_ARRIVE_STATION')):
        method = getattr(Job, method_name)
        if getattr(method, '_webx_station_name_wrapped', False):
            continue
        original_name = method

        def station_name(self, _method=original_name, _index_name=index_name):
            try:
                from py12306.webx import stations as st
                index = getattr(self, _index_name)
                name = st.name_of(self.ticket_info[index])
                if name:
                    return name
            except Exception:
                pass
            return _method(self)
        station_name._webx_station_name_wrapped = True
        station_name._webx_original = original_name
        setattr(Job, method_name, station_name)


def _hook_station_filter():
    from py12306.query.job import Job
    if getattr(Job.is_trains_number_valid, '_webx_wrapped', False):
        return
    original = Job.is_trains_number_valid

    def is_trains_number_valid(self, *args, **kwargs):
        left_time = _webx_time_delta(self.get_info_of_train_left_time())
        if left_time is None:
            return original(self, *args, **kwargs)
        if left_time < self.from_time or left_time > self.to_time:
            return False
        train_number = self.get_info_of_train_number().upper()
        if self.except_train_numbers:
            if train_number in map(str.upper, self.except_train_numbers):
                return False
        elif self.allow_train_numbers:
            if train_number not in map(str.upper, self.allow_train_numbers):
                return False
        try:
            ok, actual_left, actual_arrive = _row_station_ok(self)
            if not ok:
                _note_station_skip(self, self.get_info_of_train_number(), actual_left, actual_arrive)
                return False
        except Exception:
            pass
        return True

    if not getattr(Job.handle_response, '_webx_station_summary_wrapped', False):
        original_handle_response = Job.handle_response

        def handle_response(self, *args, **kwargs):
            import threading
            thread_id = threading.get_ident()
            previous = _QUERY_ROUTE_JOB_CTX.get(thread_id)
            _QUERY_ROUTE_JOB_CTX[thread_id] = self
            try:
                _refresh_job_query_mode(self)
                return original_handle_response(self, *args, **kwargs)
            finally:
                if previous is None:
                    _QUERY_ROUTE_JOB_CTX.pop(thread_id, None)
                else:
                    _QUERY_ROUTE_JOB_CTX[thread_id] = previous
                try:
                    _emit_station_skip_summary(self)
                except Exception:
                    pass

        handle_response._webx_station_summary_wrapped = True
        handle_response._webx_original = original_handle_response
        Job.handle_response = handle_response

    is_trains_number_valid._webx_wrapped = True
    is_trains_number_valid._webx_original = original
    Job.is_trains_number_valid = is_trains_number_valid


def _hook_query_train_log():
    """Annotate per-train query lines with the response row's actual endpoints."""
    from py12306.log.query_log import QueryLog
    method = QueryLog.add_log
    original = getattr(method, '__func__', method)
    if getattr(original, '_webx_query_route_wrapped', False):
        return

    def print_init_jobs(cls, jobs):
        logger = cls()
        logger.add_log('# 发现 {} 个任务 #'.format(len(jobs)))
        for index, job in enumerate(jobs, 1):
            logger.add_log('================== 任务 {} =================='.format(index))
            task_id = _job_id_for(job) or getattr(job, 'id', '')
            logger.add_log('任务名称：{}'.format(job.job_name))
            logger.add_log('任务id：{}'.format(task_id))
            for station in job.stations:
                logger.add_log('出发站：{} 到达站：{}'.format(station.get('left'), station.get('arrive')))

            logger.add_log('乘车日期：{}'.format(job.left_dates))
            logger.add_log('坐席：{}'.format('，'.join(job.allow_seats)))
            logger.add_log('乘车人：{}'.format('，'.join(job.members)))
            if job.except_train_numbers:
                numbers = '排除 ' + '，'.join(job.except_train_numbers)
            else:
                numbers = '，'.join(job.allow_train_numbers if job.allow_train_numbers else ['不筛选'])
            route = job.stations[0] if len(job.stations) == 1 else None
            if route and job.allow_train_numbers:
                left = route.get('left') or ''
                arrive = route.get('arrive') or ''
                numbers = '，'.join('%s(%s 至 %s)' % (n, left, arrive) for n in job.allow_train_numbers)
            logger.add_log('筛选车次：{}'.format(numbers))
            logger.add_log('')
        logger.flush()
        return logger
    print_init_jobs._webx_query_route_wrapped = True
    QueryLog.print_init_jobs = classmethod(print_init_jobs)


    def add_log(cls, content='', *args, **kwargs):
        import threading
        job = _QUERY_ROUTE_JOB_CTX.get(threading.get_ident())
        if job:
            try:
                number = str(job.get_info_of_train_number() or '').strip()
                if number and str(content).strip() == number:
                    _, left, arrive = _row_station_ok(job)
                    if left or arrive:
                        content = '%s（%s 至 %s）' % (content, left or '未知', arrive or '未知')
            except Exception:
                pass
        return original(cls, content, *args, **kwargs)

    add_log._webx_query_route_wrapped = True
    add_log._webx_original = original
    QueryLog.add_log = classmethod(add_log)



def _hook_ticket_station_log():
    """Append actual ticket endpoints to the seat-hit log without touching native files."""
    from py12306.query.job import Job
    from py12306.log.query_log import QueryLog

    bound_log = QueryLog.print_ticket_seat_available
    original_log = getattr(bound_log, '__func__', bound_log)
    if not getattr(original_log, '_webx_station_log_wrapped', False):
        def print_ticket_seat_available(cls, left_date, train_number, seat_type, rest_num):
            import threading
            route = _TICKET_STATION_CTX.get(threading.get_ident())
            if not route or not (route[0] or route[1]):
                return original_log(cls, left_date, train_number, seat_type, rest_num)
            from_station, to_station = route
            try:
                logger = cls()
                logger.add_quick_log(
                    '[ 查询到座位可用 出发时间 {left_date} 车次 {train_number} '
                    '出发站 {from_station} 终点站 {to_station} '
                    '座位类型 {seat_type} 余票数量 {rest_num} ]'.format(
                        left_date=left_date, train_number=train_number,
                        from_station=from_station or '未知', to_station=to_station or '未知',
                        seat_type=seat_type, rest_num=rest_num))
                logger.flush()
                return logger
            except Exception:
                return original_log(cls, left_date, train_number, seat_type, rest_num)

        print_ticket_seat_available._webx_station_log_wrapped = True
        print_ticket_seat_available._webx_original = original_log
        QueryLog.print_ticket_seat_available = classmethod(print_ticket_seat_available)

    if getattr(Job.handle_seats, '_webx_station_log_wrapped', False):
        return
    original_handle_seats = Job.handle_seats

    def handle_seats(self, *args, **kwargs):
        import threading
        ticket_info = args[1] if len(args) > 1 else kwargs.get('ticket_info')
        route = ('', '')
        try:
            from py12306.webx import stations as st
            if ticket_info is not None and len(ticket_info) > 7:
                route = (st.name_of(ticket_info[6]) or '', st.name_of(ticket_info[7]) or '')
            if not route[0]:
                route = (self.get_info_of_left_station() or '', route[1])
            if not route[1]:
                route = (route[0], self.get_info_of_arrive_station() or '')
        except Exception:
            pass
        thread_id = threading.get_ident()
        previous = _TICKET_STATION_CTX.get(thread_id)
        _TICKET_STATION_CTX[thread_id] = route
        try:
            return original_handle_seats(self, *args, **kwargs)
        finally:
            if previous is None:
                _TICKET_STATION_CTX.pop(thread_id, None)
            else:
                _TICKET_STATION_CTX[thread_id] = previous

    handle_seats._webx_station_log_wrapped = True
    handle_seats._webx_original = original_handle_seats
    Job.handle_seats = handle_seats


def _hook_job_init_data():
    """
    把 webx 自有任务字段挂到引擎 Job 实例上。

    引擎的 `Job.init_data` 只读它认识的键，`webx_station_mode` 需挂到实例供区间查询过滤；
    `query_mode` 则按 webx_id 从数据库读取一次，与车次白名单、站点过滤联合生效，不改变 Job.id。
    """
    from py12306.query.job import Job
    if getattr(Job.init_data, '_webx_wrapped', False):
        return
    original = Job.init_data

    def init_data(self, info, *args, **kwargs):
        result = original(self, info, *args, **kwargs)
        try:
            period = info.get('period') if isinstance(info, dict) else None
            if isinstance(period, dict):
                for key, attr in (('from', 'from_time'), ('to', 'to_time')):
                    if key in period:
                        parsed = _webx_time_delta(period.get(key))
                        if parsed is not None:
                            setattr(self, attr, parsed)
            if isinstance(info, dict) and 'webx_station_mode' in info:
                self.webx_station_mode = info.get('webx_station_mode')
            self.webx_query_mode = 'range'
            if isinstance(info, dict) and info.get('webx_id'):
                try:
                    from py12306.webx.db import DataStore
                    row = DataStore().job_get(str(info.get('webx_id')))
                    mode = str((row or {}).get('query_mode') or '').strip().lower()
                    if mode in ('train', 'range'):
                        self.webx_query_mode = mode
                except Exception:
                    pass
            self._webx_station_skip_count = 0
            self._webx_station_skip_trains = []
            self._webx_station_skip_logged = False
        except Exception:
            pass
        return result

    init_data._webx_wrapped = True
    init_data._webx_original = original
    Job.init_data = init_data


def _hook_job_check_passengers():
    """Do not destroy a task just because its account is temporarily recovering."""
    from py12306.query.job import Job
    if getattr(Job.check_passengers, '_webx_account_wait_wrapped', False):
        return
    original = Job.check_passengers

    def check_passengers(self, *args, **kwargs):
        if getattr(self, 'passengers', None):
            return original(self, *args, **kwargs)
        try:
            from py12306.webx.job_schedule import _job_account_ready
            if not _job_account_ready(self):
                if not getattr(self, '_webx_account_wait_logged', False):
                    self._webx_account_wait_logged = True
                    from py12306.log.common_log import CommonLog
                    CommonLog.add_quick_log(
                        '%s账号未就绪，暂不结束任务，等待账号恢复后继续' % _jn(self)).flush()
                return False
        except Exception:
            return False
        self._webx_account_wait_logged = False
        return original(self, *args, **kwargs)

    check_passengers._webx_account_wait_wrapped = True
    check_passengers._webx_original = original

    Job.check_passengers = check_passengers


# ---------------- 下单状态机：诚实语义 + initDc 保护 + 防重 ----------------
#
# 原版把 submitOrderRequest(data='0') 记为“提交订单成功”，但这只是
# 下单流程的第一步。真正成单还需 initDc 令牌、校验乘客、排队和订单号。
# 当 initDc 302 到登录/错误页时，原版会跟随跳转后解析失败并静默返回，
# 随后每轮余票查询都再提交一次。
#
# 本适配仍使用原 requests_html 会话，不替换传输层（不引入 Playwright /
# 无头浏览器等额外依赖）：协议修正后的原会话是**唯一下单主路径**。
#   - 下单端点补齐浏览器语义的 Referer / Origin / Accept；
#   - initDc 禁止自动跟随 302，避免误访登录页清空会话；
#   - 按账号串行化下单，失败后固定退避，不重复轰炸 submitOrderRequest；
#   - 只有 Order.order_did_success（已获取订单号）才会记为 success。

_ORDER_RETRY_SECONDS = 30
_ORDER_FLOW_STATES = {}


def _order_flow_key(user):
    try:
        return str(getattr(user, 'key', None) or getattr(user, 'user_name', None) or '_default')
    except Exception:
        return '_default'


def _order_flow_state(user):
    import threading
    key = _order_flow_key(user)
    state = _ORDER_FLOW_STATES.get(key)
    if state is None:
        state = {'lock': threading.Lock(), 'next_try': 0.0, 'last_log': 0.0,
                 'last_error': ''}
        _ORDER_FLOW_STATES[key] = state
    return state


def _order_flow_fail(user, message):
    import time
    state = _order_flow_state(user)
    state['next_try'] = time.time() + _ORDER_RETRY_SECONDS
    state['last_error'] = str(message or '下单流程未完成')


# 排队阶段服务端明确拒单（未生成订单）时的结论标记。
# 这些原因意味着「这一轮没抢到」，不是「可能已下单」。
WAIT_REJECTED = 'rejected'


def _must_stop_job(order):
    """
    下单未拿到订单号时，是否需要**停用任务**以避免重复下单。

    只在「已提交排队确认」且「结果状态不明」时才需要停：
    那时服务端**可能已经占座**，重复提交会产生重复订单，只能人工去 12306 核对。

    ⚠️ 但「服务端明确拒单」（如「没有足够的票!」「排队人数现已超过余票数」）
    并不意味着可能已下单 —— 12306 一张票都没出，**继续下一轮查询才是正确的**。
    旧实现只看 `_webx_queue_confirmed`，于是把这些情况也当成状态不明
    把任务停掉（实测踩过：票没抢到，任务却「已结束」，不再查询）。
    """
    if not getattr(order, '_webx_queue_confirmed', False):
        return False
    return getattr(order, '_webx_wait_outcome', '') != WAIT_REJECTED


def _order_attempt_update(order, status, message):
    """更新本次最近的下单记录；仅改 queued/submitted，不覆盖 success。"""
    try:
        from py12306.webx.db import DataStore
        db = DataStore()
        job = getattr(order, 'query_ins', None)
        if job is None:
            return
        job_id = _job_id_for(job)
        train_number = _call(job, 'get_info_of_train_number')
        train_date = getattr(job, 'left_date', None) or _call(job, 'get_info_of_left_date')
        rows = db.query(
            "SELECT id FROM order_log WHERE job_id IS ? AND train_date=? AND train_number=? "
            "AND status IN ('queued','submitted') ORDER BY id DESC LIMIT 1",
            (job_id, train_date, train_number))
        if rows:
            db.order_update_status(rows[0]['id'], status, message)
    except Exception:
        pass


def _extract_js_object(html, variable):
    """从 script 中取 `var name = {...}` 的完整对象。

    不用 `.+` 正则：12306 的表单对象可以跨行且包含多层花括号。
    扫描时跳过字符串内的括号，避免在嵌套 JSON 处提前截断。
    """
    import re
    match = re.search(r'\b(?:var\s+)?%s\s*=\s*' % re.escape(variable), html or '')
    if not match:
        return None
    start = (html or '').find('{', match.end())
    if start < 0:
        return None
    depth = 0
    quote = None
    escaped = False
    for index in range(start, len(html)):
        ch = html[index]
        if quote:
            if escaped:
                escaped = False
            elif ch == '\\':
                escaped = True
            elif ch == quote:
                quote = None
            continue
        if ch in ('"', "'"):
            quote = ch
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return html[start:index + 1]
    return None


def _load_js_object(raw):
    import ast
    import json
    if not raw:
        raise ValueError('missing javascript object')
    try:
        return json.loads(raw)
    except Exception:
        pass
    try:
        # 单引号字符串、尾逗号等 Python literal 也能安全解析。
        value = ast.literal_eval(raw)
    except Exception:
        value = ast.literal_eval(_javascript_literal_to_python(raw))
    if not isinstance(value, dict):
        raise ValueError('javascript value is not an object')
    return value


def _javascript_literal_to_python(raw):
    """把 12306 页面里常见的 JavaScript object literal 转成可供
    `ast.literal_eval` 安全解析的字面量：处理未加引号的 key 以及
    true/false/null/undefined。转换时跳过引号内容，不会误改姓名或车次文本。
    """
    out = []
    index = 0
    length = len(raw)
    while index < length:
        ch = raw[index]
        if ch in ('"', "'"):
            quote = ch
            start = index
            index += 1
            escaped = False
            while index < length:
                current = raw[index]
                index += 1
                if escaped:
                    escaped = False
                elif current == '\\':
                    escaped = True
                elif current == quote:
                    break
            out.append(raw[start:index])
            continue
        if ch.isalpha() or ch in ('_', '$'):
            start = index
            index += 1
            while index < length and (raw[index].isalnum() or raw[index] in ('_', '$')):
                index += 1
            word = raw[start:index]
            before_at = start - 1
            while before_at >= 0 and raw[before_at].isspace():
                before_at -= 1
            before = raw[before_at:before_at + 1] if before_at >= 0 else ''
            cursor = index
            while cursor < length and raw[cursor].isspace():
                cursor += 1
            after = raw[cursor:cursor + 1]
            if after == ':' and before in ('{', ','):
                out.append(repr(word))
            else:
                out.append({'true': 'True', 'false': 'False', 'null': 'None',
                            'undefined': 'None'}.get(word, word))
            continue
        out.append(ch)
        index += 1
    return ''.join(out)


def _hook_order_flow_guard():
    import re
    import time

    from py12306.helpers.api import (
        API_CHECK_ORDER_INFO, API_CONFIRM_SINGLE_FOR_QUEUE, API_GET_QUEUE_COUNT,
        API_INITDC_URL, API_QUERY_INIT_PAGE, API_QUERY_ORDER_WAIT_TIME,
        API_SUBMIT_ORDER_REQUEST,
    )
    from py12306.helpers.request import Request
    from py12306.log.order_log import OrderLog
    from py12306.order.order import Order
    from py12306.user.job import UserJob

    # 先修正原版第一步的误导文案。
    OrderLog.MESSAGE_SUBMIT_ORDER_REQUEST_SUCCESS = (
        '下单请求已受理，正在获取订单确认令牌（尚未生成订单）')

    order_urls = {
        API_SUBMIT_ORDER_REQUEST,
        API_INITDC_URL,
        API_CHECK_ORDER_INFO,
        API_GET_QUEUE_COUNT,
        API_CONFIRM_SINGLE_FOR_QUEUE,
        API_QUERY_ORDER_WAIT_TIME.split('?', 1)[0],
    }

    # 统一给原会话的下单请求补语义头，不改变传输层。
    if not getattr(Request.request, '_webx_order_headers', False):
        original_request = Request.request

        def request(self, method, url, **kwargs):
            base = str(url).split('?', 1)[0]
            if base in order_urls:
                headers = dict(kwargs.get('headers') or {})
                headers.setdefault('Origin', 'https://kyfw.12306.cn')
                headers.setdefault(
                    'Referer',
                    API_QUERY_INIT_PAGE if base in (API_SUBMIT_ORDER_REQUEST, API_INITDC_URL)
                    else API_INITDC_URL)
                if base == API_INITDC_URL:
                    headers.setdefault('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')
                else:
                    headers.setdefault('Accept', 'application/json, text/javascript, */*; q=0.01')
                    headers.setdefault('X-Requested-With', 'XMLHttpRequest')
                kwargs['headers'] = headers
            return original_request(self, method, url, **kwargs)

        request._webx_wrapped = True
        request._webx_original = original_request
        request._webx_order_headers = True
        Request.request = request

    # initDc 单独处理：不跟随重定向，不再静默失败。
    if not getattr(UserJob.request_init_dc_page, '_webx_wrapped', False):
        original_initdc = UserJob.request_init_dc_page

        def request_init_dc_page(self):
            response = self.session.post(
                API_INITDC_URL, {'_json_att': ''}, allow_redirects=False)
            status = int(getattr(response, 'status_code', 0) or 0)
            location = str((getattr(response, 'headers', {}) or {}).get('Location') or '')
            html = getattr(response, 'text', '') or ''
            if 300 <= status < 400:
                # 不做浏览器/无头回退：302 说明当前会话对下单端点无效
                # （典型是跳登录页或安全校验页），继续跟随只会把 otn 会话打坏。
                # 明确失败 + 退避，等下一轮余票查询时重新尝试。
                message = ('initDc 被 12306 重定向到 %s，未取得订单令牌'
                           % (location or '未知地址'))
                _order_flow_fail(self, message)
                _evjob(_cur_job_name(), 'fail', message)
                OrderLog.add_quick_log(
                    _jn(self) + 'webx 下单第二步失败：%s；%.0f 秒后再试'
                    % (message, _ORDER_RETRY_SECONDS)).flush()
                return False, False, html
            if status != 200:
                message = 'initDc HTTP %s，未取得订单令牌' % (status or '无响应')
                _order_flow_fail(self, message)
                _evjob(_cur_job_name(), 'fail', message)
                OrderLog.add_quick_log(
                    _jn(self) + 'webx 下单第二步失败：%s；%.0f 秒后再试'
                    % (message, _ORDER_RETRY_SECONDS)).flush()
                return False, False, html

            token = re.search(
                r"\bglobalRepeatSubmitToken\s*=\s*(['\"])(.*?)\1", html, re.S)
            form_raw = _extract_js_object(html, 'ticketInfoForPassengerForm')
            order_raw = _extract_js_object(html, 'orderRequestDTO')
            try:
                self.global_repeat_submit_token = token.group(2) if token else ''
                if not self.global_repeat_submit_token:
                    raise ValueError('missing token')
                self.ticket_info_for_passenger_form = _load_js_object(form_raw)
                nested_order = self.ticket_info_for_passenger_form.get('orderRequestDTO')
                self.order_request_dto = (nested_order if isinstance(nested_order, dict)
                                          else _load_js_object(order_raw))
            except Exception:
                ctype = str((getattr(response, 'headers', {}) or {}).get('Content-Type') or '')
                title_match = re.search(r'<title[^>]*>(.*?)</title>', html, re.I | re.S)
                title = re.sub(r'\s+', ' ', title_match.group(1)).strip() if title_match else '无标题'
                title = title[:80]
                flags = 'token=%s, form=%s, dto=%s' % (
                    'Y' if token else 'N', 'Y' if form_raw else 'N', 'Y' if order_raw else 'N')
                message = ('initDc 确认页不完整（%s，title=%s，len=%d，Content-Type=%s）'
                           % (flags, title, len(html), ctype or '未知'))
                _order_flow_fail(self, message)
                _evjob(_cur_job_name(), 'fail', message)
                OrderLog.add_quick_log(
                    _jn(self) + 'webx 下单第二步失败：%s；%.0f 秒后再试'
                    % (message, _ORDER_RETRY_SECONDS)).flush()
                return False, False, html

            state = _order_flow_state(self)
            state['next_try'] = 0.0
            state['last_error'] = ''
            slide_val = re.search(r"var if_check_slide_passcode.*='(\d?)'", html)
            is_slide = bool(slide_val and int(slide_val.group(1)) == 1)
            _evjob(_cur_job_name(), 'initdc', '取得订单确认令牌（检查订单信息、排队下单的前提）')
            OrderLog.add_quick_log(_jn(self) + 'webx 订单确认令牌获取成功（已进入订单确认页）').flush()
            return True, is_slide, html

        request_init_dc_page._webx_wrapped = True
        request_init_dc_page._webx_original = original_initdc
        UserJob.request_init_dc_page = request_init_dc_page

    # 提交请求受理后，更新 WebX 记录的准确阶段。
    if not getattr(Order.submit_order_request, '_webx_wrapped', False):
        original_submit = Order.submit_order_request

        def submit_order_request(self):
            import urllib.parse
            # 记下「本线程正在下单的任务」，供后续 initDc（挂在 UserJob 上）拼日志前缀
            _set_cur_job(getattr(self, 'query_ins', None))
            data = {
                'secretStr': urllib.parse.unquote(self.query_ins.get_info_of_secret_str()),
                'train_date': self.query_ins.left_date,
                'back_train_date': self.query_ins.left_date,
                'tour_flag': 'dc',
                'purpose_codes': 'ADULT',
                'query_from_station_name': self.query_ins.left_station,
                'query_to_station_name': self.query_ins.arrive_station,
                # 当前官方页面会提交该兼容字段。
                'undefined': '',
            }
            response = self.session.post(API_SUBMIT_ORDER_REQUEST, data)
            payload = response.json()
            accepted = bool(payload.get('status') is True or str(payload.get('data')) == '0')
            if accepted:
                OrderLog.add_quick_log(
                    _jn(self) + OrderLog.MESSAGE_SUBMIT_ORDER_REQUEST_SUCCESS).flush()
                _evjob(self.query_ins, 'request',
                       '12306 已受理下单请求：%s %s（%s）' % (
                           getattr(self.query_ins, 'left_date', '') or '',
                           _call(self.query_ins, 'get_info_of_train_number'),
                           getattr(self.query_ins, 'current_seat_name', '') or ''))
                _order_attempt_update(
                    self, 'submitted',
                    '12306 已受理下单请求，正在获取确认令牌（尚未生成订单）')
                return True
            error = payload.get('messages') or payload.get('validateMessages') or '网络错误'
            OrderLog.add_quick_log(_jn(self) + '提交订单请求失败，错误原因 %s' % error).flush()
            _evjob(self.query_ins, 'fail', '提交订单请求被拒: %s' % error)
            return False

        submit_order_request._webx_wrapped = True
        submit_order_request._webx_original = original_submit
        Order.submit_order_request = submit_order_request

    # 当前页面即使没有滑块也会提交空 sessionId/sig 与 scene。
    if not getattr(Order.check_order_info, '_webx_wrapped', False):
        original_check_order = Order.check_order_info

        def check_order_info(self, slide_info=None):
            slide_info = slide_info or {}
            data = {
                'cancel_flag': '2',
                'bed_level_order_num': '000000000000000000000000000000',
                'passengerTicketStr': self.passenger_ticket_str,
                'oldPassengerStr': self.old_passenger_str,
                'tour_flag': 'dc',
                'randCode': '',
                'whatsSelect': '1',
                'sessionId': slide_info.get('session_id', ''),
                'sig': slide_info.get('sig', ''),
                'scene': 'nc_login',
                '_json_att': '',
                'REPEAT_SUBMIT_TOKEN': self.user_ins.global_repeat_submit_token,
            }
            payload = self.session.post(API_CHECK_ORDER_INFO, data).json()
            response_data = payload.get('data') if isinstance(payload.get('data'), dict) else {}
            success = payload.get('status') is True and response_data.get('submitStatus') is True
            if success:
                OrderLog.add_quick_log(
                    _jn(self) + OrderLog.MESSAGE_CHECK_ORDER_INFO_SUCCESS).flush()
                _evjob(self.query_ins, 'check', '乘客与订单信息校验通过')
                self.is_need_auth_code = response_data.get('ifShowPassCode') != 'N'
                return True
            error = response_data.get('errMsg') or payload.get('messages') or '响应内容异常'
            OrderLog.add_quick_log(
                _jn(self) + OrderLog.MESSAGE_CHECK_ORDER_INFO_FAIL.format(error)).flush()
            _evjob(self.query_ins, 'fail', '订单信息校验失败: %s' % error)
            return False

        check_order_info._webx_wrapped = True
        check_order_info._webx_original = original_check_order
        Order.check_order_info = check_order_info

    # 当前 getQueueCount.data.ticket 是下一步 confirmSingleForQueue 使用的
    # leftTicketStr 凭据，不是「普通座数量,无座数量」。旧引擎按逗号拆分会误判无票。
    if not getattr(Order.get_queue_count, '_webx_wrapped', False):
        original_queue_count = Order.get_queue_count

        def get_queue_count(self):
            import datetime
            from py12306.helpers.api import API_GET_QUEUE_COUNT

            try:
                info = self.user_ins.ticket_info_for_passenger_form
                dto = info.get('queryLeftTicketRequestDTO') or {}
                date = datetime.datetime.strptime(self.query_ins.left_date, '%Y-%m-%d')
                weekdays = ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')
                months = ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                          'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec')
                data = {
                    'train_date': '%s %s %02d %04d 00:00:00 GMT+0800 (中国标准时间)' % (
                        weekdays[date.weekday()], months[date.month - 1], date.day, date.year),
                    'train_no': dto.get('train_no') or _call(self.query_ins, 'get_info_of_train_no'),
                    'stationTrainCode': (dto.get('station_train_code')
                                         or _call(self.query_ins, 'get_info_of_train_number')),
                    'seatType': self.query_ins.current_order_seat,
                    'fromStationTelecode': (dto.get('from_station_telecode')
                                            or dto.get('from_station')
                                            or getattr(self.query_ins, 'left_station_code', '')),
                    'toStationTelecode': (dto.get('to_station_telecode')
                                          or dto.get('to_station')
                                          or getattr(self.query_ins, 'arrive_station_code', '')),
                    'leftTicket': info.get('leftTicketStr') or '',
                    'purpose_codes': '00',
                    'train_location': (info.get('train_location')
                                       or _call(self.query_ins, 'get_info_of_train_location')),
                    '_json_att': '',
                    'REPEAT_SUBMIT_TOKEN': self.user_ins.global_repeat_submit_token,
                }
                result = self.session.post(API_GET_QUEUE_COUNT, data).json()
                if not result.get('status', False):
                    error = result.get('messages', result.get('validateMessages', '响应内容异常'))
                    _order_flow_fail(getattr(self, 'user_ins', None),
                                     '排队接口拒绝: %s' % error)
                    _evjob(self.query_ins, 'fail', '获取排队信息失败: %s' % error)
                    OrderLog.add_quick_log(
                        _jn(self) + '排队失败，错误原因 %s' % error).flush()
                    return False

                queue = result.get('data') or {}
                queue_ticket = str(queue.get('ticket') or '')
                if queue_ticket:
                    # 不打印该凭据，只传给下一步。
                    info['leftTicketStr'] = queue_ticket
                self._webx_queue_data = queue
                position = queue.get('count', queue.get('countT', '--'))
                _evjob(self.query_ins, 'queue', '已进入 12306 下单队列，前方 %s 人' % position)
                OrderLog.add_quick_log(
                    _jn(self) + '已进入下单队列，获取排队信息成功，当前队列人数 %s' % position).flush()
                return True
            except Exception as exc:
                message = '排队信息解析失败: %s' % exc
                _order_flow_fail(getattr(self, 'user_ins', None), message)
                _evjob(self.query_ins, 'fail', message)
                OrderLog.add_quick_log(_jn(self) + message).flush()
                return False

        get_queue_count._webx_wrapped = True
        get_queue_count._webx_original = original_queue_count
        Order.get_queue_count = get_queue_count

    # 确认排队：这条是**最高频的失败点**（实测热门车次几乎每轮都栽在
    # 「出票失败，错误原因 余票不足！」）。复刻一遍是为了拿到真实原因：
    # 原实现把原因只写进日志、不返回，调用方只能得到 False，
    # 于是界面/事件里只能显示笼统的「下单流程未完成」。
    if not getattr(Order.confirm_single_for_queue, '_webx_wrapped', False):
        original_confirm_queue = Order.confirm_single_for_queue

        def confirm_single_for_queue(self):
            from py12306.log.common_log import CommonLog

            info = getattr(self.user_ins, 'ticket_info_for_passenger_form', None) or {}
            data = {
                'passengerTicketStr': self.passenger_ticket_str,
                'oldPassengerStr': self.old_passenger_str,
                'randCode': '',
                'purpose_codes': info.get('purpose_codes'),
                'key_check_isChange': info.get('key_check_isChange'),
                'leftTicketStr': info.get('leftTicketStr'),
                'train_location': info.get('train_location'),
                'choose_seats': '',
                'seatDetailType': '000',
                'whatsSelect': '1',
                'roomType': '00',
                'dwAll': 'N',
                '_json_att': '',
                'REPEAT_SUBMIT_TOKEN': getattr(
                    self.user_ins, 'global_repeat_submit_token', ''),
            }
            if getattr(self, 'is_need_auth_code', False):
                # 目前好像是都不需要了，有问题再处理
                pass
            try:
                result = self.session.post(API_CONFIRM_SINGLE_FOR_QUEUE, data).json()
            except Exception as exc:
                self._webx_confirm_reason = '排队确认请求异常: %s' % exc
                OrderLog.add_quick_log(
                    '%s%s' % (_jn(self), self._webx_confirm_reason)).flush()
                return False

            if 'data' in result:
                if result.get('data.submitStatus'):     # 成功
                    # 从此刻起服务端可能已占座；后续状态不明时不得重复提交。
                    self._webx_queue_confirmed = True
                    self._webx_confirm_reason = ''
                    _evjob(self.query_ins, 'confirm',
                           '已提交排队确认（服务端可能已占座，待返回订单号）')
                    OrderLog.add_quick_log(
                        '%s%s' % (_jn(self),
                                  OrderLog.MESSAGE_CONFIRM_SINGLE_FOR_QUEUE_SUCCESS)).flush()
                    return True
                reason = result.get('data.errMsg') or '余票不足'
                OrderLog.add_quick_log(
                    '%s%s' % (_jn(self), OrderLog.MESSAGE_CONFIRM_SINGLE_FOR_QUEUE_ERROR.format(
                        result.get('data.errMsg', CommonLog.MESSAGE_RESPONSE_EMPTY_ERROR)))).flush()
            else:
                reason = result.get('messages') or result.get('validateMessages') or '排队确认被拒'
                OrderLog.add_quick_log(
                    '%s%s' % (_jn(self), OrderLog.MESSAGE_CONFIRM_SINGLE_FOR_QUEUE_FAIL.format(
                        result.get('messages', CommonLog.MESSAGE_RESPONSE_EMPTY_ERROR)))).flush()
            self._webx_confirm_reason = str(reason)
            _evjob(self.query_ins, 'fail', '排队确认失败：%s' % reason)
            return False

        confirm_single_for_queue._webx_wrapped = True
        confirm_single_for_queue._webx_original = original_confirm_queue
        Order.confirm_single_for_queue = confirm_single_for_queue

    # 排队轮询：必须区分「服务端明确拒单（未生成订单）」与「状态不明（可能已占座）」。
    #
    # 原实现两种结果都只返回 False，调用方**无法分辨**。而 `confirm_single_for_queue`
    # 一旦成功我们就置了 `_webx_queue_confirmed`，于是像
    # 「排队失败，错误原因 没有足够的票!」这种**明确没抢到票**的情况也被当成
    # 「可能已下单」→ 停用任务 + 记为 unknown
    # （实测：12306 一张票都没出，任务却被结束，不再继续下一轮查询下单）。
    #
    # 这里复刻一遍轮询分支（与原实现逐分支等价），额外把结论写进
    # `self._webx_wait_outcome`：'ordered' / 'rejected' / 'unknown'。
    # 顺带给这些日志补上任务名前缀 —— 它们原本不带任务名，
    # 详情页按任务名过滤日志时**根本看不到排队过程**。
    if not getattr(Order.query_order_wait_time, '_webx_wrapped', False):
        original_wait_time = Order.query_order_wait_time

        def query_order_wait_time(self):
            import random as _random
            import urllib.parse as _urlparse
            from py12306.helpers.func import stay_second
            from py12306.log.common_log import CommonLog

            self.current_queue_wait = self.max_queue_wait
            self.queue_num = 0
            # 默认「状态不明」——只有明确判明才降级为 rejected
            self._webx_wait_outcome = 'unknown'
            self._webx_wait_reason = ''
            while self.current_queue_wait:
                self.current_queue_wait -= self.wait_queue_interval
                self.queue_num += 1
                data = {
                    'random': str(_random.random())[2:],
                    'tourFlag': 'dc',
                    '_json_att': '',
                    'REPEAT_SUBMIT_TOKEN': getattr(
                        self.user_ins, 'global_repeat_submit_token', ''),
                }
                try:
                    result = self.session.get(
                        API_QUERY_ORDER_WAIT_TIME.format(_urlparse.urlencode(data))).json()
                except Exception as exc:
                    OrderLog.add_quick_log(
                        '%s排队状态查询异常: %s' % (_jn(self), exc)).flush()
                    return False

                if result.get('status') and 'data' in result:
                    result_data = result['data'] or {}
                    order_id = result_data.get('orderId')
                    if order_id:
                        self._webx_wait_outcome = 'ordered'
                        return order_id
                    if 'waitTime' in result_data:
                        wait_time = int(result_data.get('waitTime') or 0)
                        if wait_time == -1:
                            # 原实现这里注释「不应该走到这」：视为未知，不当作成功
                            return order_id
                        elif wait_time == -100:      # 重新获取订单号
                            pass
                        elif wait_time >= 0:         # 仍在排队，继续等
                            OrderLog.add_quick_log(
                                '%s' % _jn(self)
                                + OrderLog.MESSAGE_QUERY_ORDER_WAIT_TIME_WAITING.format(
                                    result_data.get('waitCount', 0), wait_time)).flush()
                        else:
                            # -2 失败 / -3 订单已撤销 → 服务端明确没成单
                            self._webx_wait_outcome = 'rejected'
                            self._webx_wait_reason = str(result_data.get('msg') or '')
                            OrderLog.add_quick_log(
                                '%s' % _jn(self)
                                + OrderLog.MESSAGE_QUERY_ORDER_WAIT_TIME_FAIL.format(
                                    result_data.get('msg'))).flush()
                            return False
                    elif result_data.get('msg'):
                        # 实测常见：「没有足够的票!」「排队人数现已超过余票数…」
                        # → 明确未成单，属于「这一轮没抢到」，应继续下一轮
                        self._webx_wait_outcome = 'rejected'
                        self._webx_wait_reason = str(result_data.get('msg') or '')
                        OrderLog.add_quick_log(
                            '%s' % _jn(self)
                            + OrderLog.MESSAGE_QUERY_ORDER_WAIT_TIME_FAIL.format(
                                result_data.get('msg',
                                                CommonLog.MESSAGE_RESPONSE_EMPTY_ERROR))).flush()
                        stay_second(self.retry_time)
                        return False
                elif result.get('messages') or result.get('validateMessages'):
                    self._webx_wait_outcome = 'rejected'
                    self._webx_wait_reason = str(
                        result.get('messages', result.get('validateMessages')) or '')
                    OrderLog.add_quick_log(
                        '%s' % _jn(self)
                        + OrderLog.MESSAGE_QUERY_ORDER_WAIT_TIME_FAIL.format(
                            result.get('messages', result.get('validateMessages')))).flush()
                    return False

                OrderLog.add_quick_log(
                    '%s' % _jn(self)
                    + OrderLog.MESSAGE_QUERY_ORDER_WAIT_TIME_INFO.format(self.queue_num)).flush()
                stay_second(self.wait_queue_interval)

            # 轮询超时：没拿到订单号，但服务端也没明确拒单 → 状态不明
            return False

        query_order_wait_time._webx_wrapped = True
        query_order_wait_time._webx_original = original_wait_time
        Order.query_order_wait_time = query_order_wait_time

    # 整条链路未获得订单号时，不让记录永久停在 submitted。
    if not getattr(Order.normal_order, '_webx_wrapped', False):
        original_normal = Order.normal_order

        def normal_order(self):
            try:
                result = original_normal(self)
            except Exception as exc:
                message = '下单链路异常: %s' % exc
                _order_flow_fail(getattr(self, 'user_ins', None), message)
                _evjob(self.query_ins, 'fail', message)
                OrderLog.add_quick_log(_jn(self) + message).flush()
                result = False
            if not result:
                # 「服务端明确拒单」不等于「状态不明」：
                # 前者（如「没有足够的票!」「排队人数现已超过余票数」）12306 **没有生成任何订单**，
                # 继续下一轮查询下单才是正确行为；只有真的无法确认订单号时，
                # 才需要停任务防重复下单（那时服务端**可能已经占座**）。
                # 判定见 `_must_stop_job`。
                if _must_stop_job(self):
                    message = ('订单已提交排队，但未能确认订单号；'
                               '任务已停止以避免重复下单，请到 12306 官方订单页核对')
                    _order_attempt_update(self, 'unknown', message)
                    try:
                        from py12306.webx.db import DataStore
                        db = DataStore()
                        job = getattr(self, 'query_ins', None)
                        job_id = _job_id_for(job)
                        if job_id:
                            db.job_toggle_active(job_id, 0)
                        if job is not None and getattr(job, 'is_alive', False):
                            job.destroy()
                    except Exception:
                        pass
                    OrderLog.add_quick_log(_jn(self) + message).flush()
                else:
                    # 优先用最具体的原因：排队轮询的拒单原因 > 排队确认的拒单原因 > 兜底
                    reason = (getattr(self, '_webx_wait_reason', '')
                              or getattr(self, '_webx_confirm_reason', ''))
                    if reason:
                        message = '本轮下单未成功：%s（任务继续查询，等待下一轮余票）' % reason
                    else:
                        state = _order_flow_state(getattr(self, 'user_ins', None))
                        message = state.get('last_error') or '下单流程未完成，12306 未返回订单号'
                    _evjob(self.query_ins, 'fail', message)
                    OrderLog.add_quick_log(_jn(self) + message).flush()
                    # ⚠️ **任何「未成单」都必须退避**，否则下一轮余票查询会立刻再提交一次下单请求。
                    # 实测（查询间隔 1s、余票一直挂着）会变成每 1~2 秒打一遍
                    # submitOrderRequest → initDc → confirmSingleForQueue，
                    # 直接触发 12306 的「由于您取消次数过多，今日将不能继续受理您的订票请求」。
                    # 排队确认失败（confirmSingleForQueue 返回 False）这条路径原本没人调
                    # `_order_flow_fail`，所以完全没有退避 —— 这里统一补上。
                    _order_flow_fail(getattr(self, 'user_ins', None), message)
                    _order_attempt_update(self, 'failed', message)
            return result

        normal_order._webx_wrapped = True
        normal_order._webx_original = original_normal
        Order.normal_order = normal_order


# ---------------- 扫码归属：UserJob.qr_login ----------------
#
# webx 管理台的账号由**网页**扫码（`Webx12306`），引擎那套 `qr_login()` 必须让位。
# 不拦的话：cookie 文件缺失/失效时 `handle_login() → qr_login()` 会进入
#   `while True:` 轮询（每 300s 重新下载 PNG 并用 os.startfile 弹窗 + 试着发邮件），
# **该账号的心跳线程被永久占住** → 之后哪怕网页扫码成功、cookie 已落盘，
# 引擎也永远走不到 `check_heartbeat()` → 账号一直不 ready（实测踩过）。
#
# 修法：webx 数据库里存在的账号，直接跳过引擎自带扫码，返回 False。
# `check_heartbeat()` 于是每 `check_interval`(5s) 重试一次，
# 网页扫码写入有效 cookie 后，下一次重试即可 `did_loaded_user()` 成功 → 就绪。
# **不修改 py12306 原文件。**

def _hook_qr_login():
    from py12306.user.job import UserJob
    if getattr(UserJob.qr_login, '_webx_wrapped', False):
        return
    original = UserJob.qr_login

    def qr_login(self):
        from py12306.log.user_log import UserLog
        try:
            from py12306.webx.db import DataStore
            if DataStore().account_get(str(self.key)):
                UserLog.add_quick_log('webx 跳过引擎自带扫码登录: %s'
                                      '（请用管理台「添加账号 / 重新扫码」出码）'
                                      % getattr(self, 'user_name', '')).flush()
                return False
        except Exception:
            pass
        return original(self)

    qr_login._webx_wrapped = True
    qr_login._webx_original = original
    UserJob.qr_login = qr_login


# ---------------- 响应 JSON：恢复「点号取值」能力（最关键的一条）----------------
#
# 引擎到处用 `result.get('data.is_login')` / `result.get('data.normal_passengers')`
# 这类**点号路径**取值，这要求 `response.json()` 返回 `py12306.app.Dict`
# （`Dict.get` 才会把 'a.b' 拆成两层找）。
# 该能力原本由 `Request._handle_response → expand_class(response, 'json', Request.json)` 提供，
# 但在当前 `requests_html` 版本下 **`_handle_response` 并不生效**：
#     实测 `r.json.__qualname__ == 'Response.json'`、`hasattr(r,'old_json') == False`
#     → `type(r.json()) == <class 'dict'>`（普通 dict）
#     → `dict.get('data.is_login')` 按**字面键** 'data.is_login' 查找 → 永远 None
# 后果（全部实测确认）：
#     check_user_is_login() → None == 'Y' → False
#     get_user_info()       → result.get('data.userDTO.loginUserDTO') → None
#     can_access_passengers → result.get('data.normal_passengers')   → None
#   → 永远「用户状态已过期，正在重新登录」、账号永远离线、乘客永远 0 人。
#
# 修法：包一层 `Request.request`，保证每个响应对象都挂上 `Request.json`
# （手动 expand_class 后 `type == Dict`、`get('data.is_login') == 'Y'`，已验证）。
# **不修改 py12306 原文件。**

def _hook_response_json():
    from py12306.helpers.func import expand_class
    from py12306.helpers.request import Request
    if getattr(Request.request, '_webx_wrapped', False):
        return
    original = Request.request

    def request(self, *args, **kwargs):
        response = original(self, *args, **kwargs)
        try:
            if response is not None and 'json' not in getattr(response, '__dict__', {}):
                expand_class(response, 'json', Request.json)
        except Exception:
            pass
        return response

    request._webx_wrapped = True
    request._webx_original = original
    Request.request = request


# ---------------- 会话落盘守卫：UserJob.save_user ----------------
#
# `save_user()` 无条件把 `self.session.cookies` pickle 到
# `runtime/user/<user_name>.cookie`。而引擎里一堆失败路径也会走到它
# （check_user_is_login / get_user_info / 就绪探针 …），此时 session 可能已被
# `init_data()` 换成了**空的新 Request**，于是刚登录成功的会话文件被覆盖成空 jar
# → 账号彻底掉线（实测：该账号的 cookie 文件被反复写成 0 个 cookie，长度 0 字节）。
#
# 守卫：空会话绝不落盘，并把调用点（文件:行）打出来便于定位。
# **不修改 py12306 原文件。**

def _hook_save_user():
    from py12306.user.job import UserJob
    if getattr(UserJob.save_user, '_webx_wrapped', False):
        return
    original = UserJob.save_user

    def save_user(self):
        from py12306.log.user_log import UserLog
        try:
            empty = len(getattr(self, 'session').cookies) == 0
        except Exception:
            empty = True
        if empty:
            import traceback
            caller = ''
            try:
                frames = traceback.extract_stack()
                if len(frames) >= 2:
                    f = frames[-2]
                    caller = '%s:%d' % (f.filename.rsplit('\\', 1)[-1], f.lineno)
            except Exception:
                pass
            UserLog.add_quick_log('webx 拦截空会话落盘: %s（会话无 cookie，跳过 save_user，调用点 %s）'
                                  % (getattr(self, 'user_name', ''), caller)).flush()
            return None
        return original(self)

    save_user._webx_wrapped = True
    save_user._webx_original = original
    UserJob.save_user = save_user


# ---------------- 浏览器特征：Query/UserJob.request_device_id ----------------
#
# `API_GET_BROWSER_DEVICE_ID` 指向的第三方签发服务 `12306-rail-id-v2.pjialin.com` **已下线**
# （ConnectTimeout）。而引擎两个实现都是「请求失败 → 递归调用自身」：
#     Query.request_device_id:      if status != 200: return self.request_device_id()
#     Query.request_device_id2:     except:            return self.request_device_id2()
# 没有 base case → 1000 层后 RecursionError（日志 `maximum recursion depth exceeded`），
# 并且期间不断向 kyfw.12306.cn 发请求 → 把 IP 打到限流，
# 连带让同时进行的 `/otn/login/conf` 取不到 `is_login='Y'` → 账号被判「已过期」。
#
# 实测：12306 已**不再使用 RAIL_DEVICEID**（真实浏览器访问 leftTicket/init 也不下发），
# 余票接口不带该 cookie 也能正常返回。所以未配置本地缓存时直接跳过即可。
# 若用户在「系统设置」里配了 rail 缓存，则仍走原实现（不发 HTTP）。
# **不修改 py12306 原文件。**

def _hook_request_device_id():
    from py12306.config import Config
    from py12306.query.query import Query
    from py12306.user.job import UserJob

    def make_wrapper(method):
        def wrapped(self, *args, **kwargs):
            if Config().is_cache_rail_id_enabled():
                return method(self, *args, **kwargs)
            return None

        wrapped._webx_wrapped = True
        wrapped._webx_original = method
        return wrapped

    for cls, name in ((Query, 'request_device_id'), (Query, 'request_device_id2'),
                      (UserJob, 'request_device_id'), (UserJob, 'request_device_id2')):
        method = getattr(cls, name, None)
        if method is None or getattr(method, '_webx_wrapped', False):
            continue
        setattr(cls, name, make_wrapper(method))


# ---------------- 乘客数据：UserJob.get_user_passengers / 就绪探针 ----------------
#
# ⚠️ 「必须存**原始** 12306 字段」的天坑：
# `UserJob.get_passengers_by_members(members)` 是按下述**原始字段名**取值的：
#     array_dict_find_by_key_value(self.passengers, 'passenger_name', member)
#     new_member = {'name': passenger.get('passenger_name'),
#                   'type': passenger.get('passenger_type'),
#                   'enc_str': passenger.get('allEncStr'), ...}
# 即 `self.passengers` 必须保持 12306 `normal_passengers` 的原样结构；
# 一旦先归一化成 {name,type,id_card,enc_str}，引擎就找不到乘客 → 日志
# 「乘客信息校验失败，在账号 X 中未找到该乘客: Y」→ `check_passengers()` 调 `destroy()`
# → 任务刚建好就「已结束」（踩过）。归一化只用于 web 界面（routes_accounts 自己做）。
#
# 另：`get_user_passengers()` 在 self.passengers 为空时是「失败→递归调用自身」且无 base case
# （打的是已 302 的 getPassengerDTOs）→ 会 RecursionError。这里一并兜底。

def _hook_get_user_passengers():
    from py12306.user.job import UserJob
    if getattr(UserJob.get_user_passengers, '_webx_wrapped', False):
        return
    original = UserJob.get_user_passengers

    def get_user_passengers(self):
        if self.passengers:
            return self.passengers
        try:
            import json

            from py12306.config import Config
            from py12306.webx.webx12306 import Webx12306
            w = Webx12306(self.key, user_name=getattr(self, 'user_name', '') or '')
            try:
                w.session.cookies.update(getattr(self, 'session', None).cookies)
            except Exception:
                pass
            pax = w.fetch_passengers()          # 原样保存，不要归一化
            if pax:
                self.passengers = pax
                try:
                    with open(Config().USER_PASSENGERS_FILE % self.user_name, 'w',
                              encoding='utf-8') as f:
                        json.dump(pax, f, indent=4, ensure_ascii=False)
                except Exception:
                    pass
                return self.passengers
        except Exception:
            pass
        return original(self)

    get_user_passengers._webx_wrapped = True
    get_user_passengers._webx_original = original
    UserJob.get_user_passengers = get_user_passengers


# ---------------- 登录态判定：UserJob.get_user_info ----------------
#
# 引擎判「用户状态已过期」的完整链路是：
#   did_loaded_user()/check_heartbeat → check_user_is_login()
#       → 读 /otn/login/conf 的 data.is_login（实测正常，未登录为 'N'）
#       → is_login=='Y' 时 **返回 self.get_user_info()**
#   get_user_info() 打的是 API_USER_INFO = /otn/modifyUser/initQueryUserInfoApi，
#   **该端点已下线**（实测 302 到 www.12306.cn/mormhweb/logFiles/error.html）→ 返回 False
#   → check_user_is_login() 返回 False → 短路的 `and` 让 can_access_passengers() 压根不会被调用
#   → 日志「用户状态已过期，正在重新登录」→ 账号永远离线。
#
# 这里包一层：先按「能读到乘客列表 = 会话确定有效」判定，失败再回落到原实现。
# **不修改 py12306 原文件。**

def _hook_get_user_info():
    from py12306.user.job import UserJob
    if getattr(UserJob.get_user_info, '_webx_wrapped', False):
        return
    original = UserJob.get_user_info

    def get_user_info(self):
        from py12306.log.user_log import UserLog
        try:
            from py12306.webx.webx12306 import Webx12306
            w = Webx12306(self.key, user_name=getattr(self, 'user_name', '') or '')
            try:
                w.session.cookies.update(getattr(self, 'session', None).cookies)
            except Exception:
                pass
            pax = w.fetch_passengers()
            if pax:
                # ⚠️ 原样存回：引擎 get_passengers_by_members 要用原始字段名
                # (passenger_name / passenger_type / allEncStr) 匹配乘车人，
                # 归一化成 {name,type,...} 会让「任务乘客校验」全部失败。
                self.passengers = pax
                # 原 get_user_info 会顺带回填 user_name（供 print_welcome_user 等使用），
                # 但 API_USER_INFO 已下线，这里补上，避免日志出现「欢迎回来， #」
                if getattr(self, 'user_name', None):
                    self.update_user_info({'user_name': self.user_name})
                self.save_user()
                self.set_last_heartbeat()
                UserLog.add_quick_log('webx 登录态确认: %s（乘客 %d 人，%s）'
                                      % (getattr(self, 'user_name', ''), len(pax),
                                         w.last_passenger_probe)).flush()
                return True
        except Exception as e:
            UserLog.add_quick_log('webx 登录态确认异常（回落原逻辑）: %s' % e).flush()
        return original(self)

    get_user_info._webx_wrapped = True
    get_user_info._webx_original = original
    UserJob.get_user_info = get_user_info


# ---------------- 就绪判定：UserJob.can_access_passengers ----------------
#
# 引擎的心跳逻辑是：
#   check_heartbeat(): if is_first_time() or not check_user_is_login() or not can_access_passengers():
#                         if not load_user() and not handle_login(): return
# 其中 can_access_passengers() 用「裸调 getPassengerDTOs」当就绪探针。
# 现代 12306 的 getPassengerDTOs 必须带 REPEAT_SUBMIT_TOKEN（来自 initDc），
# 单发会被 302 到 /otn/passport?redirect=/otn/safeguard/init，
# 于是引擎永远认为会话过期 → 反复重新登录 → 管理台一直显示「离线」、乘客永远 0 人。
#
# 这里包一层：先走现代姿势，再退回「已登录」判定。**不修改 py12306 原文件。**

def _hook_can_access_passengers():
    from py12306.user.job import UserJob
    if getattr(UserJob.can_access_passengers, '_webx_wrapped', False):
        return
    original = UserJob.can_access_passengers

    def can_access_passengers(self):
        from py12306.log.user_log import UserLog
        try:
            from py12306.webx.webx12306 import Webx12306
            w = Webx12306(self.key, user_name=getattr(self, 'user_name', '') or '')
            # 复用引擎会话 cookie（load_user 已灌进 self.session）
            try:
                w.session.cookies.update(getattr(self, 'session', None).cookies)
            except Exception:
                pass
            pax = w.fetch_passengers()
            if pax:
                self.passengers = pax      # 原样（原始字段名）
                UserLog.add_quick_log('webx 就绪探针: %s 乘客 %d 人（%s）'
                                      % (getattr(self, 'user_name', ''), len(pax),
                                         w.last_passenger_probe)).flush()
                return True
            # 拿不到乘客 ≠ 会话失效：再单独确认登录态，避免把账号误判为过期而反复重登
            if w.is_login():
                UserLog.add_quick_log('webx 就绪探针: %s 已登录但乘客接口不可用（%s），'
                                      '按就绪处理' % (getattr(self, 'user_name', ''),
                                                  w.last_passenger_probe)).flush()
                return True
        except Exception as e:
            UserLog.add_quick_log('webx 就绪探针异常（回落原逻辑）: %s' % e).flush()
        return original(self)

    can_access_passengers._webx_wrapped = True
    can_access_passengers._webx_original = original
    UserJob.can_access_passengers = can_access_passengers


# ---------------- 命中：Job.do_order ----------------

def _hook_job_do_order():
    from py12306.query.job import Job
    if getattr(Job.do_order, '_webx_wrapped', False):
        return
    original = Job.do_order

    def do_order(self, user):
        import time
        from py12306.log.order_log import OrderLog
        from py12306.user.user import User

        # handle_seats 取到的 user 可能在扫码重登期间已被替换。
        # 原 Job.do_order -> check_passengers -> wait_for_ready 会在旧对象上
        # 无界递归，即使新对象已 ready 也不会切换。
        current_user = User.get_user(str(getattr(self, 'account_key', '')))
        if (current_user is None or current_user is not user
                or not getattr(current_user, 'is_alive', True)
                or not getattr(current_user, 'is_ready', False)):
            return False

        # 无座的提交编码随车型不同：G/D/C 使用 O，普速使用 1。
        if getattr(self, 'current_seat_name', '') == '无座':
            train_number = str(_call(self, 'get_info_of_train_number') or '').upper()
            self.current_order_seat = 'O' if train_number.startswith(('G', 'D', 'C')) else '1'

        state = _order_flow_state(current_user)
        remaining = max(0.0, float(state.get('next_try') or 0) - time.time())
        if remaining > 0:
            # 最多每 5 秒打一条，避免余票每秒命中时淹没日志。
            if time.time() - float(state.get('last_log') or 0) >= 5:
                state['last_log'] = time.time()
                OrderLog.add_quick_log(
                    _jn(self) + 'webx 下单退避中，还需 %.0f 秒（%s）'
                    % (remaining, state.get('last_error') or '上次下单未完成')).flush()
            return False
        if not state['lock'].acquire(blocking=False):
            return False
        state['last_error'] = ''
        try:
            try:
                _record_hit(self, current_user)
            except Exception:
                pass
            return original(self, current_user)
        finally:
            state['lock'].release()

    do_order._webx_wrapped = True
    do_order._webx_original = original
    Job.do_order = do_order


def _record_hit(job, user):
    from py12306.webx.db import DataStore
    db = DataStore()
    train_number = _call(job, 'get_info_of_train_number')
    train_date = getattr(job, 'left_date', None) or _call(job, 'get_info_of_left_date')
    seat = getattr(job, 'current_seat_name', '') or ''
    rest = _rest_num(job)
    # 用 Job.id（唯一）而不是 job_name：同名任务会被归到同一个任务行上
    job_id = _job_id_for(job)

    db.hit_add(job_id, getattr(job, 'job_name', '') or '', train_number, seat, rest, train_date)
    _evjob(job, 'hit', '命中余票：%s %s（%s）余票 %s' % (
        train_date or '', train_number or '', seat or '—', rest or '未知'))
    db.order_add(
        job_id=job_id,
        account_key=_account_key(user),
        train_date=train_date,
        train_number=train_number,
        passengers=_passenger_names(job),
        seats=[seat],
        status='queued',
        message='已命中余票，准备提交下单请求（余票 %s，尚未生成订单）'
                % (rest or '未知'),
    )


# ---------------- 成功：Order.order_did_success ----------------

def _hook_order_success():
    from py12306.order.order import Order
    if getattr(Order.order_did_success, '_webx_wrapped', False):
        return
    original = Order.order_did_success

    def order_did_success(self):
        try:
            _record_success(self)
        except Exception:
            pass
        try:
            return original(self)
        except Exception as exc:
            # 订单号已经确认成功；通知/站名展示异常不能把成功订单改写成链路失败。
            try:
                from py12306.log.order_log import OrderLog
                OrderLog.add_quick_log(_jn(self) + '订单已成功，成功通知异常：%s' % exc).flush()
            except Exception:
                pass
            return True

    order_did_success._webx_wrapped = True
    order_did_success._webx_original = original
    Order.order_did_success = order_did_success


def _record_success(order):
    from py12306.webx.db import DataStore
    db = DataStore()
    job = getattr(order, 'query_ins', None)
    user = getattr(order, 'user_ins', None)
    if job is None:
        return
    order_id = str(getattr(order, 'order_id', '') or '')
    train_number = _call(job, 'get_info_of_train_number')
    train_date = getattr(job, 'left_date', None) or _call(job, 'get_info_of_left_date')
    seat = getattr(job, 'current_seat_name', '') or ''
    message = '订单号 %s，请 30 分钟内登录 12306 完成支付' % (order_id or '未知')
    job_id = _job_id_for(job)
    _evjob(job, 'success', '下单成功：订单号 %s（%s %s %s）' % (
        order_id or '未知', train_date or '', train_number or '', seat or '—'))

    promoted = db.order_promote(job_id, train_date, train_number, message)
    if not promoted:
        # 提交阶段没记上（例：引擎重启后直接出票）→ 补一条成功记录
        db.order_add(
            job_id=job_id,
            account_key=_account_key(user),
            train_date=train_date,
            train_number=train_number,
            passengers=_passenger_names(job),
            seats=[seat],
            status='success',
            message=message,
        )

    # ⚠️ 出票成功后必须把任务**停用**（对**所有**任务，不只 [即时] 那种）。
    # 引擎那边确实会 `Event().job_destroy()` 掉当前 Job 对象，但那只让 `is_alive=False`、
    # 循环退出；db 行的 is_active 若还是 1，它仍留在 `QUERY_JOBS` 里 →
    # 下一次 `publish_jobs()` / 引擎刷新就会**重建 Job 继续查询**
    # （用户看到的现象：列表显示「已完成」，日志却还在刷查询）。
    # 这里落库停用 + 立刻发布，让引擎把该任务从 QUERY_JOBS 摘除。
    if job_id:
        try:
            db.job_toggle_active(job_id, 0)
            db.job_mark_finished(job_id, '已购票，任务自动结束')
            from py12306.webx.sync import ConfigSync
            ConfigSync.publish_jobs()
        except Exception:
            pass


# ---------------- 工具 ----------------

def _call(obj, method, default=''):
    try:
        return getattr(obj, method)()
    except Exception:
        return default


def _rest_num(job):
    try:
        return job.ticket_info[job.current_seat]
    except Exception:
        return ''


def _account_key(user):
    return getattr(user, 'key', None) if user is not None else None


def _passenger_names(job):
    out = []
    for p in (getattr(job, 'passengers', None) or []):
        if isinstance(p, dict):
            name = p.get('name') or p.get('passenger_name')
        else:
            name = str(p or '')
        if name:
            out.append(str(name))
    return out
