# -*- coding: utf-8 -*-
import hashlib
import json
import secrets
import string

from py12306.config import Config
from py12306.helpers.func import singleton
from py12306.log.common_log import CommonLog
from py12306.webx.config_store import ConfigStore
from py12306.webx.db import DataStore


def _rand_password(length=12):
    """首启管理台默认口令：大小写 + 数字 + 符号"""
    letters = string.ascii_letters + string.digits + '!@#$%'
    return ''.join(secrets.choice(letters) for _ in range(length))


@singleton
class ConfigSync:
    """
    webx.json + webx.db → Config 单例 的桥接层（后台代码只读 Config）
    - 无文件监视、无漂移 guard（配置源唯一为 webx）
    - "保存即生效"：网页保存动作显式调 apply_settings/publish_accounts/publish_jobs，
      触发 Config.update_configs_from_remote 同款 auto 刷新入口，后台不重启即生效
    """

    # ---------------- 管理台登录 ----------------
    @classmethod
    def ensure_admin(cls):
        """user_login 空 → 建默认管理员；返回 (admin, 初始口令 or None)"""
        db = DataStore()
        if db.login_user_list():
            return 'admin', None
        admin = ConfigStore().get().get('web', {}).get('username') or 'admin'
        password = (ConfigStore().get().get('web') or {}).get('password') or _rand_password()
        salt = secrets.token_hex(16)
        db.login_user_create(admin, salt, _pbkdf2(password, salt))
        # 回写 webx.json（web.password 留空，口令只存 db 哈希）
        ConfigStore().update({'web': {'password': ''}})
        return admin, password

    # ---------------- 启动 ----------------
    @classmethod
    def startup(cls):
        """main_web.py：App.run() 之后、User.run()/Query.run() 之前调用
        first=True：仅写 Config 值（不实例化 User()/Query() 单例、不触发 auto 刷新），
        由随后的 User.run()/Query.run() 按已发布值初始化，避免启动期提前发起网络请求。"""
        admin, initial_pwd = cls.ensure_admin()
        cls.apply_settings(first=True)
        cls.publish_accounts(first=True)
        cls.publish_jobs(first=True)
        CommonLog.add_quick_log('webx 配置来源: runtime/webx.json + webx.db (env.py 不参与)').flush()
        CommonLog.add_quick_log('webx 管理台: 用户名 %s' % admin).flush()
        if initial_pwd:
            CommonLog.add_quick_log('webx 管理台初始密码: %s （请尽快在系统设置中修改）' % initial_pwd).flush()

    # ---------------- 设置（webx.json → Config）----------------
    @classmethod
    def _apply_map(cls, data):
        """webx.json 键 → Config 属性（对齐 config.py 现有常量名）；返回本次变更的 Config 键"""
        q = data.get('query', {})
        u = data.get('user', {})
        c = data.get('cdn', {})
        lg = data.get('log', {})
        ac = data.get('auth_code', {})
        r = data.get('rail', {})
        n = data.get('notification', {})
        vc = n.get('voice_code', {})
        cl = data.get('cluster', {})
        mapping = [
            ('QUERY_INTERVAL', q.get('interval', 1)),
            ('REQUEST_MAX_RETRY', q.get('request_max_retry', 5)),
            ('QUERY_JOB_THREAD_ENABLED', q.get('thread_enabled', 0)),
            ('USER_HEARTBEAT_INTERVAL', u.get('heartbeat_interval', 120)),
            ('CDN_ENABLED', c.get('enabled', 0)),
            ('CDN_CHECK_TIME_OUT', c.get('check_time_out', 1)),
            ('OUT_PUT_LOG_TO_FILE_ENABLED', lg.get('to_file', 0)),
            ('OUT_PUT_LOG_TO_FILE_PATH', lg.get('path') or 'runtime/12306.log'),
            ('AUTO_CODE_PLATFORM', ac.get('platform') or ''),
            ('API_USER_CODE_QCR_API', ac.get('api') or ''),
            ('AUTO_CODE_ACCOUNT', {'user': ac.get('account', {}).get('user', ''),
                                   'pwd': ac.get('account', {}).get('pwd', '')}),
            ('CACHE_RAIL_ID_ENABLED', r.get('cache_enabled', 0)),
            ('RAIL_EXPIRATION', r.get('expiration') or ''),
            ('RAIL_DEVICEID', r.get('device_id') or ''),
            ('NOTIFICATION_BY_VOICE_CODE', vc.get('enabled', 0)),
            ('NOTIFICATION_VOICE_CODE_TYPE', vc.get('type') or ''),
            ('NOTIFICATION_API_APP_CODE', vc.get('app_code') or ''),
            ('NOTIFICATION_VOICE_CODE_PHONE', vc.get('phone') or ''),
            ('DINGTALK_ENABLED', n.get('dingtalk', {}).get('enabled', 0)),
            ('DINGTALK_WEBHOOK', n.get('dingtalk', {}).get('webhook') or ''),
            ('TELEGRAM_ENABLED', n.get('telegram', {}).get('enabled', 0)),
            ('TELEGRAM_BOT_API_URL', n.get('telegram', {}).get('bot_api_url') or ''),
            ('SERVERCHAN_ENABLED', n.get('serverchan', {}).get('enabled', 0)),
            ('SERVERCHAN_KEY', n.get('serverchan', {}).get('key') or ''),
            ('PUSHBEAR_ENABLED', n.get('pushbear', {}).get('enabled', 0)),
            ('PUSHBEAR_KEY', n.get('pushbear', {}).get('key') or ''),
            ('BARK_ENABLED', n.get('bark', {}).get('enabled', 0)),
            ('BARK_PUSH_URL', n.get('bark', {}).get('push_url') or ''),
            ('EMAIL_ENABLED', n.get('email', {}).get('enabled', 0)),
            ('EMAIL_SENDER', n.get('email', {}).get('sender') or ''),
            ('EMAIL_RECEIVER', n.get('email', {}).get('receiver') or ''),
            ('EMAIL_SERVER_HOST', n.get('email', {}).get('host') or ''),
            ('EMAIL_SERVER_USER', n.get('email', {}).get('user') or ''),
            ('EMAIL_SERVER_PASSWORD', n.get('email', {}).get('password') or ''),
            ('CLUSTER_ENABLED', cl.get('enabled', 0)),
            ('NODE_IS_MASTER', cl.get('node_is_master', 1)),
            ('NODE_SLAVE_CAN_BE_MASTER', cl.get('node_slave_can_be_master', 1)),
            ('NODE_NAME', cl.get('node_name') or ''),
            ('REDIS_HOST', cl.get('redis_host') or ''),
            ('REDIS_PORT', str(cl.get('redis_port') or '6379')),
            ('REDIS_PASSWORD', cl.get('redis_password') or ''),
        ]
        changed = []
        for key, value in mapping:
            old = getattr(Config, key, None)
            if old != value:
                setattr(Config, key, value)
                changed.append(key)
        return changed

    @classmethod
    def apply_settings(cls, first=False):
        """webx.json → Config；first=True 仅 setattr（startup 时后台尚未起）"""
        data = ConfigStore().get()
        changed = cls._apply_map(data)
        # 同步进 Config.envs，使旧 watcher/save_to_remote 的去重与集群同步基于 webx 值
        for key in changed:
            _bump_envs(key)
        if first or not changed:
            return
        try:
            if 'QUERY_INTERVAL' in changed:
                from py12306.query.query import Query
                Query().update_query_interval(auto=True)
            if 'USER_HEARTBEAT_INTERVAL' in changed:
                from py12306.user.user import User
                User().update_interval(auto=True)
            if 'CDN_ENABLED' in changed:
                from py12306.helpers.cdn import Cdn
                Cdn().update_cdn_status(auto=True)
        except Exception as e:
            CommonLog.add_quick_log('webx 设置应用部分刷新失败: %s' % e).flush()

    # ---------------- 账号（db → Config）----------------
    @classmethod
    def _accounts_from_db(cls):
        out = []
        for acc in DataStore().account_list():
            if not acc.get('active'): continue
            if acc.get('type') == 'qr' and not acc.get('login_ok'):
                continue  # 扫码成功前不发布（防与 UserJob 心跳并发抢登录）
            out.append({'key': acc['key'], 'user_name': acc.get('user_name') or '',
                        'password': acc.get('password') or '', 'type': acc.get('type') or 'qr'})
        return out

    @staticmethod
    def _live_accounts(accounts):
        """
        只保留「引擎里确实存在 UserJob」的账号。
        引擎 User.refresh_users 遇到 old 里有、但 self.users 里没有的 key 时，
        会直接 get_user(key).init_data() → 'NoneType' object has no attribute 'init_data'，
        结果整批账号一个都刷不进去。过滤后这些 key 走「新增」分支（init_user + 线程），反而能自愈。
        """
        try:
            from py12306.user.user import User
            live = {getattr(u, 'key', None) for u in (User().users or [])}
        except Exception:
            return accounts
        return [a for a in (accounts or []) if a.get('key') in live]

    @staticmethod
    def _prune_dead_users():
        """
        引擎 User.users 只增不减：destroy() 只把 is_alive 置 False，不摘除列表项。
        而 User.get_user(key) 返回**第一个**匹配项 —— 重新扫码登录时 refresh_users 会
        init_user() 新建一个 UserJob，旧的僵尸项仍排在前面，于是
        get_passenger_for_members → wait_for_ready() 会在死对象上无限递归（每次 sleep 3s），
        表现为「下单一直卡住」。这里在发布前把 is_alive 为 False 的项就地摘掉。
        """
        try:
            from py12306.user.user import User
            u = User()
            users = u.users or []
            alive = [x for x in users if getattr(x, 'is_alive', True)]
            if len(alive) != len(users):
                users[:] = alive  # 原地修改，保持类属性引用不变
        except Exception:
            pass

    @classmethod
    def publish_accounts(cls, first=False, auto=None):
        new = cls._accounts_from_db()
        old = Config().USER_ACCOUNTS
        Config().USER_ACCOUNTS = new
        _bump_envs('USER_ACCOUNTS')
        if auto is None: auto = not first
        try:
            from py12306.user.user import User
        except Exception:
            return
        # User 是单例，__init__ 只跑一次：若它在 startup 之前已被创建
        # （管理台 WebX.run() 起 Flask 后，任意一次 /api/accounts、/api/dashboard 都会 User()），
        # user_accounts 会固化成 startup 时的值，之后 User.run() → init_users() 遍历的
        # 就是这个陈旧列表 → users 为空 → 账号永远「离线」。这里显式同步；
        # User.__init__ 只读配置、不发网络请求，可安全提前创建。
        User().user_accounts = new
        if not (auto and new != old):
            return
        cls._prune_dead_users()
        try:
            User().update_user_accounts(auto=auto, old=cls._live_accounts(old))
        except Exception as e:
            CommonLog.add_quick_log('webx 账号发布刷新失败: %s' % e).flush()

    # ---------------- 任务（db → Config）----------------
    @staticmethod
    def job_info_dict(job):
        """
        固定键序模板（对齐 Job.init_data 的消费字段）。
        md5=md5(json.dumps(dict)) 按插入序，键序固定 → Query.refresh_jobs 的 id 稳定。

        注意：DataStore.job_list() 返回的是 SQLite 原始行，其中
        left_dates / stations / seats / members / train_numbers / except_train_numbers
        都是 **JSON 文本**。必须 json.loads 后再交给引擎，否则 Job.init_data 会拿到字符串，
        在 `self.stations[0]['left']` 处抛 "string indices must be integers"
        （此前发布链路因此从未成功，任务只写进了 db 却没被引擎加载）。
        """
        return {
            'job_name': job.get('job_name') or '',
            'account_key': _safe_key(job.get('account_key')),
            'left_dates': _json_list(job.get('left_dates')),
            'stations': _json_list(job.get('stations')) or [{'left': '', 'arrive': ''}],
            'members': _json_list(job.get('members')),
            'allow_less_member': 1 if job.get('allow_less_member') else 0,
            'seats': _json_list(job.get('seats')),
            'train_numbers': _json_list(job.get('train_numbers')),
            'except_train_numbers': _json_list(job.get('except_train_numbers')),
            'period': {'from': job.get('period_from') or '00:00',
                       'to': job.get('period_to') or '24:00'},
        }

    @classmethod
    def _jobs_from_db(cls):
        out = []
        for job in DataStore().job_list():
            if not job.get('is_active'):
                continue  # 暂停的任务从 QUERY_JOBS 摘除（destroy 既有 Job）
            out.append(cls.job_info_dict(job))
        return out

    @classmethod
    def publish_jobs(cls, first=False, auto=None):
        new = cls._jobs_from_db()
        old = Config().QUERY_JOBS
        Config().QUERY_JOBS = new
        _bump_envs('QUERY_JOBS')
        if auto is None: auto = not first
        if auto and new != old:
            try:
                from py12306.query.query import Query
                Query().update_query_jobs(auto=True)
            except Exception as e:
                CommonLog.add_quick_log('webx 任务发布刷新失败: %s' % e).flush()


# ---------------- 工具 ----------------
def _bump_envs(key):
    """把 webx 当前值镜像进 Config.envs（去重替换），让 watcher 再跑时 envs 无 diff"""
    cfg = Config()
    if not isinstance(cfg.envs, list):
        cfg.envs = []
    cfg.envs = [[k, v] for (k, v) in cfg.envs if k != key]
    cfg.envs.append([key, getattr(cfg, key)])


def _safe_key(value):
    """account_key 以 str 存（Job.init_data 内会 str() 化：self.account_key = str(info.get('account_key'))）"""
    return value


def _json_list(value):
    """
    SQLite TEXT 列 → list。已是 list 时原样返回（幂等）。
    解析失败返回 []，避免脏数据让整条发布链路失败。
    """
    if isinstance(value, list):
        return value
    if not value:
        return []
    try:
        out = json.loads(value)
        return out if isinstance(out, list) else []
    except Exception:
        return []


def _pbkdf2(password, salt):
    return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 120000).hex()
