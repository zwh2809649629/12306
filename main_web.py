# -*- coding: utf-8 -*-
# webx 新管理台启动入口（独立于 main.py / 旧 Web）
#
# 用法：
#   python main_web.py          # 完整后台（含抢票 Cdn/User/Query）+ 管理台
#   python main_web.py -t       # 仅起管理台与预载，不跑抢票任务（测试）
#
# 配置说明：
#   配置来源 runtime/webx.json + runtime/webx.db（网页"系统设置"管理）；
#   env.py 完全不参与——本入口不加载、不依赖 env.py。
import sys

from py12306.app import *
from py12306.helpers.cdn import Cdn
from py12306.log.common_log import CommonLog
from py12306.query.query import Query
from py12306.user.user import User

from py12306.webx.config_store import ConfigStore
from py12306.webx.db import DataStore
from py12306.webx.sync import ConfigSync

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
    """webx 后台守护：查询次数按天累计（30s 轮询 QueryLog 差值）"""
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
            time.sleep(30)

    t = threading.Thread(target=daily_counter)
    t.setDaemon(True)
    t.start()


def main():
    load_argvs()
    _ensure_env_stub()
    CommonLog.print_welcome()
    App.run()
    CommonLog.print_configs()
    App.did_start()

    # webx 接管配置（webx.json + db → Config），覆盖 stub/env 的冷读值
    ConfigSync.startup()
    WebX.run()

    App.run_check()
    try:
        Query.check_before_run()
    except Exception as e:
        CommonLog.add_quick_log('webx Query.check_before_run 失败（12306 频控/网络原因，管理台仍可用）: %s' % e).flush()

    ####### 运行任务（失败不致命：管理台继续服务）
    try:
        Cdn.run()
    except Exception as e:
        CommonLog.add_quick_log('webx Cdn.run 失败: %s' % e).flush()
    try:
        User.run()
    except Exception as e:
        CommonLog.add_quick_log('webx User.run 失败: %s' % e).flush()
    try:
        Query.run()
    except Exception as e:
        CommonLog.add_quick_log('webx Query.run 失败（后台抢票不可用，管理台仍可查/改/建任务）: %s' % e).flush()
    _start_webx_daemons()
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
