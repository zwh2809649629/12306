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


def install():
    """安装引擎钩子；失败只记日志，不影响启动"""
    if getattr(install, '_installed', False):
        return False
    install._installed = True
    try:
        _hook_response_json()
        _hook_job_do_order()
        _hook_order_success()
        _hook_save_user()
        _hook_request_device_id()
        _hook_qr_login()
        _hook_get_user_passengers()
        _hook_get_user_info()
        _hook_can_access_passengers()
        try:
            from py12306.log.common_log import CommonLog
            CommonLog.add_quick_log(
                'webx 引擎钩子已安装: response.json(Dict 修复) / do_order / order_did_success / '
                'save_user(空会话守卫) / request_device_id(防递归) / qr_login(让位网页扫码) / '
                'get_user_passengers / get_user_info(登录态确认) / can_access_passengers(就绪探针)').flush()
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
# → 账号彻底掉线（实测：`卓文颢.cookie` 被反复写成 0 个 cookie，长度 0 字节）。
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
        try:
            _record_hit(self, user)
        except Exception:
            pass
        return original(self, user)

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
    job_id = db.job_id_by_name(job.job_name)

    db.hit_add(job_id, getattr(job, 'job_name', '') or '', train_number, seat, rest, train_date)
    db.order_add(
        job_id=job_id,
        account_key=_account_key(user),
        train_date=train_date,
        train_number=train_number,
        passengers=_passenger_names(job),
        seats=[seat],
        status='submitted',
        message='已向 12306 提交下单请求（余票 %s）' % (rest or '未知'),
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
        return original(self)

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
    job_id = db.job_id_by_name(job.job_name)

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

    # 「即时下单」是一次性子任务：出票即停用 db 行，避免 refresh_jobs 复活后重复抢票
    job_name = getattr(job, 'job_name', '') or ''
    if job_id and job_name.startswith(ONE_SHOT_PREFIX):
        db.job_toggle_active(job_id, 0)


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
