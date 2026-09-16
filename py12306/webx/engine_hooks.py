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
        _hook_query_loop()
        _hook_order_flow_guard()
        try:
            from py12306.log.common_log import CommonLog
            CommonLog.add_quick_log(
                'webx 引擎钩子已安装: response.json(Dict 修复) / do_order / order_did_success / '
                'save_user(空会话守卫) / request_device_id(防递归) / qr_login(让位网页扫码) / '
                'get_user_passengers / get_user_info(登录态确认) / can_access_passengers(就绪探针) / '
                'query_loop(启用任务后自动查询) / '
                'order_flow(订单状态机+防重复提交)').flush()
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
            return original_start(self, *args, **kwargs)
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
                    threading.Thread(target=self.start, daemon=True,
                                     name='webx-query-loop').start()
            except Exception:
                pass
        return result

    start._webx_wrapped = True
    start._webx_original = original_start
    update_query_jobs._webx_wrapped = True
    update_query_jobs._webx_original = original_update
    Query.start = start
    Query.update_query_jobs = update_query_jobs


# ---------------- 下单状态机：诚实语义 + initDc 保护 + 防重 ----------------
#
# 原版把 submitOrderRequest(data='0') 记为“提交订单成功”，但这只是
# 下单流程的第一步。真正成单还需 initDc 令牌、校验乘客、排队和订单号。
# 当 initDc 302 到登录/错误页时，原版会跟随跳转后解析失败并静默返回，
# 随后每轮余票查询都再提交一次。
#
# 本适配仍使用原 requests_html 会话，不替换 TLS 实现：
#   - 下单端点补齐浏览器语义的 Referer / Origin / Accept；
#   - initDc 禁止自动跟随 302，避免误访登录页清空会话；
#   - 按账号串行化下单，失败后固定退避，不重复轰炸 submitOrderRequest；
#   - 只有 Order.order_did_success（已获取订单号）才会记为 success。

_ORDER_RETRY_SECONDS = 30
_ORDER_FLOW_STATES = {}
# 协议字段修正后先以共享 requests_html 会话为唯一主路径。
# Chromium 实现保留为人工诊断开关，默认不自动启用。
_ORDER_BROWSER_FALLBACK_ENABLED = False


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


def _order_attempt_update(order, status, message):
    """更新本次最近的下单记录；仅改 queued/submitted，不覆盖 success。"""
    try:
        from py12306.webx.db import DataStore
        db = DataStore()
        job = getattr(order, 'query_ins', None)
        if job is None:
            return
        job_id = db.job_id_by_name(getattr(job, 'job_name', '') or '')
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
                target = location or '未知地址'
                if _ORDER_BROWSER_FALLBACK_ENABLED:
                    OrderLog.add_quick_log(
                        'webx initDc 被重定向到 %s，尝试 Chromium 同源回退' % target).flush()
                    browser_ok, browser_html, browser_url, browser_error = _browser_initdc(
                        self.session, API_INITDC_URL, API_QUERY_INIT_PAGE)
                    if browser_ok:
                        html = browser_html
                        status = 200
                        OrderLog.add_quick_log('webx Chromium initDc 回退返回 200，继续解析确认页').flush()
                    else:
                        message = ('initDc 被 12306 重定向到 %s；Chromium 回退失败: %s（final=%s）'
                                   % (target, browser_error or '未知错误', browser_url or '无'))
                        _order_flow_fail(self, message)
                        OrderLog.add_quick_log(
                            'webx 下单第二步失败：%s；%.0f 秒后再试'
                            % (message, _ORDER_RETRY_SECONDS)).flush()
                        return False, False, html
                else:
                    message = ('initDc 被 12306 重定向到 %s，未取得订单令牌'
                               % target)
                    _order_flow_fail(self, message)
                    OrderLog.add_quick_log(
                        'webx 下单第二步失败：%s；%.0f 秒后再试'
                        % (message, _ORDER_RETRY_SECONDS)).flush()
                    return False, False, html
            if status != 200:
                message = 'initDc HTTP %s，未取得订单令牌' % (status or '无响应')
                _order_flow_fail(self, message)
                OrderLog.add_quick_log(
                    'webx 下单第二步失败：%s；%.0f 秒后再试'
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
                OrderLog.add_quick_log(
                    'webx 下单第二步失败：%s；%.0f 秒后再试'
                    % (message, _ORDER_RETRY_SECONDS)).flush()
                return False, False, html

            state = _order_flow_state(self)
            state['next_try'] = 0.0
            state['last_error'] = ''
            slide_val = re.search(r"var if_check_slide_passcode.*='(\d?)'", html)
            is_slide = bool(slide_val and int(slide_val.group(1)) == 1)
            OrderLog.add_quick_log('webx 订单确认令牌获取成功').flush()
            return True, is_slide, html

        request_init_dc_page._webx_wrapped = True
        request_init_dc_page._webx_original = original_initdc
        UserJob.request_init_dc_page = request_init_dc_page

    # 提交请求受理后，更新 WebX 记录的准确阶段。
    if not getattr(Order.submit_order_request, '_webx_wrapped', False):
        original_submit = Order.submit_order_request

        def submit_order_request(self):
            import urllib.parse
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
                OrderLog.add_quick_log(OrderLog.MESSAGE_SUBMIT_ORDER_REQUEST_SUCCESS).flush()
                _order_attempt_update(
                    self, 'submitted',
                    '12306 已受理下单请求，正在获取确认令牌（尚未生成订单）')
                return True
            error = payload.get('messages') or payload.get('validateMessages') or '网络错误'
            OrderLog.add_quick_log('提交订单请求失败，错误原因 %s' % error).flush()
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
                OrderLog.add_quick_log(OrderLog.MESSAGE_CHECK_ORDER_INFO_SUCCESS).flush()
                self.is_need_auth_code = response_data.get('ifShowPassCode') != 'N'
                return True
            error = response_data.get('errMsg') or payload.get('messages') or '响应内容异常'
            OrderLog.add_quick_log(OrderLog.MESSAGE_CHECK_ORDER_INFO_FAIL.format(error)).flush()
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
                    OrderLog.add_quick_log('排队失败，错误原因 %s' % error).flush()
                    return False

                queue = result.get('data') or {}
                queue_ticket = str(queue.get('ticket') or '')
                if queue_ticket:
                    # 不打印该凭据，只传给下一步。
                    info['leftTicketStr'] = queue_ticket
                self._webx_queue_data = queue
                position = queue.get('count', queue.get('countT', '--'))
                OrderLog.add_quick_log('获取排队信息成功，当前队列人数 %s' % position).flush()
                return True
            except Exception as exc:
                message = '排队信息解析失败: %s' % exc
                _order_flow_fail(getattr(self, 'user_ins', None), message)
                OrderLog.add_quick_log(message).flush()
                return False

        get_queue_count._webx_wrapped = True
        get_queue_count._webx_original = original_queue_count
        Order.get_queue_count = get_queue_count

    if not getattr(Order.confirm_single_for_queue, '_webx_wrapped', False):
        original_confirm_queue = Order.confirm_single_for_queue

        def confirm_single_for_queue(self):
            result = original_confirm_queue(self)
            if result:
                # 从此刻起服务端可能已占座；后续状态不明时不得重复提交。
                self._webx_queue_confirmed = True
            return result

        confirm_single_for_queue._webx_wrapped = True
        confirm_single_for_queue._webx_original = original_confirm_queue
        Order.confirm_single_for_queue = confirm_single_for_queue

    # 整条链路未获得订单号时，不让记录永久停在 submitted。
    if not getattr(Order.normal_order, '_webx_wrapped', False):
        original_normal = Order.normal_order

        def normal_order(self):
            try:
                result = original_normal(self)
            except Exception as exc:
                message = '下单链路异常: %s' % exc
                _order_flow_fail(getattr(self, 'user_ins', None), message)
                OrderLog.add_quick_log(message).flush()
                result = False
            if not result:
                if getattr(self, '_webx_queue_confirmed', False):
                    message = ('订单已提交排队，但未能确认订单号；'
                               '任务已停止以避免重复下单，请到 12306 官方订单页核对')
                    _order_attempt_update(self, 'unknown', message)
                    try:
                        from py12306.webx.db import DataStore
                        db = DataStore()
                        job = getattr(self, 'query_ins', None)
                        job_id = db.job_id_by_name(getattr(job, 'job_name', '') or '')
                        if job_id:
                            db.job_toggle_active(job_id, 0)
                        if job is not None and getattr(job, 'is_alive', False):
                            job.destroy()
                    except Exception:
                        pass
                    OrderLog.add_quick_log(message).flush()
                else:
                    state = _order_flow_state(getattr(self, 'user_ins', None))
                    message = state.get('last_error') or '下单流程未完成，12306 未返回订单号'
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
                    'webx 下单退避中，还需 %.0f 秒（%s）'
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
    job_id = db.job_id_by_name(job.job_name)

    db.hit_add(job_id, getattr(job, 'job_name', '') or '', train_number, seat, rest, train_date)
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
