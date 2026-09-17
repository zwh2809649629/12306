# -*- coding: utf-8 -*-
# webx 新管理台启动入口（独立于 main.py / 旧 Web）
#
# 用法：
#   python  main_web.py         # 前台（有控制台窗口，看得到输出）
#   pythonw main_web.py         # 后台（**完全没有窗口**，输出落 runtime/console.log）
#   python  main_web.py -t      # 仅起管理台与预载，不跑抢票任务（测试）
#
# 配置说明：
#   配置来源 runtime/webx.json + runtime/webx.db（网页"系统设置"管理）；
#   env.py 完全不参与——本入口不加载、不依赖 env.py。
import os
import sys


def _ensure_streams():
    """
    pythonw.exe（无控制台）下 sys.stdout / sys.stderr 为 None，
    而 werkzeug / click / 原版 py12306 的 print 都会往它们写 → 会抛异常。

    这里把为 None 的流兜底重定向到 runtime/console.log：
    - 不污染 runtime/webx.log（那份只留引擎/管理台的有意义日志，由 BaseLog 写）
    - 无窗口启动也能安全跑，出问题仍有地方看
    """
    here = os.path.dirname(os.path.abspath(__file__))
    runtime = os.path.join(here, 'runtime')
    try:
        os.makedirs(runtime, exist_ok=True)
    except Exception:
        return
    for name in ('stdout', 'stderr'):
        if getattr(sys, name, None) is None:
            try:
                setattr(sys, name, open(os.path.join(runtime, 'console.log'), 'a',
                                        encoding='utf-8', buffering=1))
            except Exception:
                pass


_ensure_streams()

from py12306.app import *
from py12306.helpers.cdn import Cdn
from py12306.log.common_log import CommonLog
from py12306.query.query import Query
from py12306.user.user import User

from py12306.webx.config_store import ConfigStore
from py12306.webx.db import DataStore
from py12306.webx.sync import ConfigSync


def install_engine_hooks():
    try:
        from py12306.webx.engine_hooks import install
        install()
    except Exception as e:
        CommonLog.add_quick_log('webx 引擎钩子加载失败（不影响抢票）: %s' % e).flush()


# ---------------- webx 服务封装 ----------------
class WebX:
    app = None
    thread = None

    @classmethod
    def create(cls):
        from py12306.webx.server.app import create_app
        cls.app = create_app()

    @classmethod
    def run(cls):
        self = cls()
        self.create()
        import threading
        settings = ConfigStore().get().get('server', {})
        port = int(settings.get('port') or 8600)
        host = settings.get('host') or '0.0.0.0'
        self.thread = threading.Thread(
            target=lambda: self.app.run(host=host, port=port, threaded=True, use_reloader=False))
        self.thread.setDaemon(True)
        self.thread.start()
        CommonLog.add_quick_log('webx 管理台已启动: http://%s:%s' % (host if host != '0.0.0.0' else 'localhost', port)).flush()


def _ensure_env_stub():
    """
    旧 Config 首次实例化需要 CONFIG_FILE 可读（getmtime）。为保证"完全不需要 env.py"，
    在 Config() 首次实例化前，默认把类属性 CONFIG_FILE 指向 webx 自管的空 stub；
    用户用 -c 显式指定外部配置时则使用用户文件。（不修改任何旧文件）
    """
    if _ARGV_CONFIG_FILE:
        Config.CONFIG_FILE = _ARGV_CONFIG_FILE
        return
    runtime = Config.RUNTIME_DIR  # 类属性，读取不触发实例化
    os.makedirs(runtime, exist_ok=True)
    stub = runtime + '.webx_env'
    if not os.path.exists(stub):
        with open(stub, 'w', encoding='utf-8') as f:
            f.write('# webx env stub (empty on purpose). webx 配置位于 runtime/webx.json\n')
    Config.CONFIG_FILE = stub


def _start_webx_daemons():
    """webx 后台守护：查询次数按天累计（30s 轮询 QueryLog 差值）。

    幂等：重复调用只起一个线程。

    ⚠️ 启动日志必须在**主线程**打，不能让守护线程自己也打一条：
    `py12306/log/base.py` 的 `BaseLog.quick_log` 是**类级共享 list 且无锁**，
    且 `empty_logs()` 里 `self.quick_log = []` 写在 `cls()` 出来的临时实例上
    （退化成实例属性，并没有清掉类级 list）。两个线程紧邻着并发 `add_quick_log(...).flush()`
    时，两边的 flush 会各自把同一份缓冲写一遍 → 日志整段重复。
    实测：守护线程自己打「已启动」时，本函数的两条日志在 startup 块里各出现两次；
    挪到主线程后不再重复。
    """
    if getattr(_start_webx_daemons, '_started', False):
        CommonLog.add_quick_log('webx 后台守护已在运行，跳过重复启动').flush()
        return
    _start_webx_daemons._started = True
    import threading

    def daily_counter():
        from py12306.log.query_log import QueryLog
        last = None
        while True:
            try:
                data = QueryLog().data or {}
                cur = data.get('query_count') or 0
                if last is not None and cur > last:
                    DataStore().daily_incr(time.strftime('%Y-%m-%d', time.localtime()), cur - last)
                last = cur
            except Exception:
                pass
            try:
                _reconcile_paused_jobs()
            except Exception:
                pass
            time.sleep(30)

    t = threading.Thread(target=daily_counter)
    t.setDaemon(True)
    t.start()
    # 只在主线程打一条（避免与守护线程并发 flush 造成日志重复）
    CommonLog.add_quick_log('webx 后台守护已启动: daily_query 按天累计（每 30s 轮询差值）').flush()


def _reconcile_paused_jobs():
    """自愈：DB 里已暂停、引擎却还在跑的任务，重新摘掉。

    暂停走的是 PATCH（**先写 db 再 publish_jobs**）：正常情况下
    `Query.refresh_jobs()` 会对不在 QUERY_JOBS 里的 Job 调 `destroy()`。
    但引擎若正卡在长耗时的下单/排队链路里（`query_order_wait_time` 最长能轮询
    60 秒 × 3 秒 sleep），`is_alive=False` 要等该链路返回才被循环检查到；
    期间界面上已经是「已暂停」，日志却还在刷查询 —— 用户看到的就是
    「显示已暂停但后台还在运行」。

    这里每 30 秒对一次账：只要有「引擎里存活、但 db 已不是 active」的任务，
    就重新发布一次任务列表让引擎把它摘除，并记一条日志说明发生了什么。
    **只在真的不一致时才动作**，正常情况零开销。
    """
    from py12306.query.query import Query
    ins = Query.__dict__.get('__it__')
    if ins is None:
        return
    from py12306.helpers.func import md5
    from py12306.webx.sync import ConfigSync
    allowed = set()
    for job in DataStore().job_list():
        if not job.get('is_active'):
            continue
        try:
            allowed.add(md5(ConfigSync.job_info_dict(job)))
        except Exception:
            pass
    stale = [j for j in (getattr(ins, 'jobs', None) or [])
             if getattr(j, 'is_alive', True) and str(getattr(j, 'id', '')) not in allowed]
    if not stale:
        return
    names = sorted({str(getattr(j, 'job_name', '') or '') for j in stale})
    ConfigSync.publish_jobs()
    CommonLog.add_quick_log(
        'webx 对账：任务已暂停但引擎仍在运行，已重新摘除 → %s' % '、'.join(names)).flush()


def main():
    load_argvs()
    _ensure_env_stub()
    CommonLog.print_welcome()
    App.run()
    CommonLog.print_configs()
    App.did_start()

    # webx 接管配置（webx.json + db → Config），覆盖 stub/env 的冷读值
    ConfigSync.startup()
    # webx 引擎钩子：余票命中/下单成功 → webx.db（不修改 py12306 原文件，包装挂载）
    install_engine_hooks()
    WebX.run()

    App.run_check()

    ####### webx 后台守护（查询次数按天累计）必须在这里起：
    ####### `Query.run()` 内部是 `while True`（`Job.run()` 各自死循环）**永不返回**，
    ####### 原来把 _start_webx_daemons() 放在它后面 → 守护线程从未启动 →
    ####### 总览的「今日查询次数」恒为 0（累计却在涨）。实测踩过。
    _start_webx_daemons()

    ####### 先起账号心跳 / CDN：它们不依赖 12306 查询初始化
    ####### 原版 Query.get_query_api_type 是「无界递归 + 无超时请求」，12306 频控时会长时间阻塞，
    ####### 实测卡住后 User.run() 永不执行 → 扫码登录成功但账号一直显示「离线」。
    try:
        User.run()
    except Exception as e:
        CommonLog.add_quick_log('webx User.run 失败: %s' % e).flush()
    try:
        Cdn.run()
    except Exception as e:
        CommonLog.add_quick_log('webx Cdn.run 失败: %s' % e).flush()

    ####### 12306 查询初始化（频控时可能很慢），完成后再跑抢票任务
    CommonLog.add_quick_log('webx 正在初始化 12306 查询（频控时可能较慢，账号心跳已先启动）').flush()
    try:
        Query.check_before_run()
    except Exception as e:
        CommonLog.add_quick_log('webx Query.check_before_run 失败（12306 频控/网络原因，管理台仍可用）: %s' % e).flush()
    try:
        Query.run()
    except Exception as e:
        CommonLog.add_quick_log('webx Query.run 失败（后台抢票不可用，管理台仍可查/改/建任务）: %s' % e).flush()
    if not Const.IS_TEST:
        while True:
            time.sleep(10000)
    else:
        if Config().is_cluster_enabled(): stay_second(5)
        CommonLog.print_test_complete()


def test():
    Const.IS_TEST = True
    Config.OUT_PUT_LOG_TO_FILE_ENABLED = False


_ARGV_CONFIG_FILE = None


def load_argvs():
    global _ARGV_CONFIG_FILE
    if '--test' in sys.argv or '-t' in sys.argv:
        test()
    for flag in ('--config', '-c'):
        if flag in sys.argv:
            idx = sys.argv.index(flag)
            if idx + 1 < len(sys.argv):
                _ARGV_CONFIG_FILE = sys.argv[idx + 1]


if __name__ == '__main__':
    main()
