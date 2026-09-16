# -*- coding: utf-8 -*-
"""
webx 专用 12306 登录/乘客助手
镜像 user/job.py 的登录机制（RAIL 设备特征、uamtk/uamauthclient、滑动验证、扫码轮询），
但独立于 UserJob 的长循环与 Cluster 耦合，供 webx 管理台一次性调用。

关键兼容点：登录成功后把 cookie 写入与 UserJob 相同的路径
  runtime/user/<user_name>.cookie（pickle）
这样后台 UserJob.load_user() 可直接恢复会话，webx 登录与心跳完全互通，零改动原文件。
"""
import base64
import json
import os
import time

from py12306.config import Config
from py12306.helpers.func import time_int_ms
from py12306.helpers.api import (
    API_BASE_LOGIN, API_USER_PASSENGERS,
    API_USER_LOGIN_CHECK, API_AUTH_QRCODE_BASE64_DOWNLOAD, API_AUTH_QRCODE_CHECK,
    API_AUTH_UAMTK, API_AUTH_UAMAUTHCLIENT, API_GET_BROWSER_DEVICE_ID,
)

# 个人中心「乘车人管理」接口 —— 实测唯一能拿到乘客的入口
# （原 getPassengerDTOs 已 302 到 /otn/safeguard/init，initDc 已 302 到登录页）
API_PASSENGERS_QUERY = 'https://kyfw.12306.cn/otn/passengers/query'

_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
       '(KHTML, like Gecko) Chrome/94.0.4606.61 Safari/537.36')

# 扫码会话（进程内跨请求保留设备特征 + 登录态）
_QR_SESSIONS = {}


def _qr_session(key):
    if key not in _QR_SESSIONS:
        _QR_SESSIONS[key] = Webx12306(key)
    return _QR_SESSIONS[key]


class Webx12306:
    def __init__(self, key, user_name='', password=''):
        from py12306.helpers.request import Request
        self.key = str(key)
        self.user_name = user_name or ''
        self.password = password or ''
        self.session = Request()
        self.info = {'user_name': user_name}
        self.last_qr_seen = 0.0
        self.qr_uuid = None

    # ---------------- 基础 ----------------
    @staticmethod
    def _safe_json(resp):
        try:
            if getattr(resp, 'status_code', None) is None:
                return {}
            return resp.json()
        except Exception:
            return {}

    def cookie_path(self, user_name=None):
        name = user_name or self.user_name or self.key
        # 与 UserJob.get_cookie_path 完全一致：Config().USER_DATA_DIR + <name> + '.cookie'
        return Config().USER_DATA_DIR + name + '.cookie'

    def save_cookie(self):
        import pickle
        try:
            with open(self.cookie_path(), 'wb') as f:
                pickle.dump(self.session.cookies, f)
            return True
        except Exception:
            return False

    def load_cookie(self, user_name=None):
        import pickle
        p = self.cookie_path(user_name)
        if os.path.exists(p):
            try:
                with open(p, 'rb') as f:
                    self.session.cookies.update(pickle.load(f))
                return True
            except Exception:
                return False
        return False

    # ---------------- 设备特征（镜像 request_device_id / request_device_id2）----------------
    def request_device_id(self):
        expire_time = self.session.cookies.get('RAIL_EXPIRATION')
        if expire_time is not None:
            try:
                if int(expire_time) - time_int_ms() > 0:
                    return
            except Exception:
                pass
        self.session.headers.update({'User-Agent': _UA})
        try:
            resp = self.session.get(API_GET_BROWSER_DEVICE_ID)
        except Exception:
            return
        if getattr(resp, 'status_code', None) != 200:
            return
        try:
            if 'pjialin' not in API_GET_BROWSER_DEVICE_ID:
                result = json.loads(resp.text)
                resp2 = self.session.get(base64.b64decode(result['id']).decode())
                if resp2.text.find('callbackFunction') >= 0:
                    result = resp2.text[18:-2]
                result = json.loads(result)
            else:
                if resp.text.find('callbackFunction') >= 0:
                    result = json.loads(resp.text[18:-2])
                else:
                    result = json.loads(resp.text)
            if Config().is_cache_rail_id_enabled():
                self.session.cookies.update({
                    'RAIL_EXPIRATION': Config().RAIL_EXPIRATION,
                    'RAIL_DEVICEID': Config().RAIL_DEVICEID,
                })
            else:
                self.session.cookies.update({
                    'RAIL_EXPIRATION': result.get('exp'),
                    'RAIL_DEVICEID': result.get('dfp'),
                })
        except Exception:
            return

    # ---------------- 票据（镜像 auth_uamtk / auth_uamauthclient）----------------
    def _uamtk(self):
        for _ in range(max(1, Config().REQUEST_MAX_RETRY)):
            try:
                resp = self.session.post(API_AUTH_UAMTK.get('url'), {'appid': 'otn'}, headers={
                    'Referer': 'https://kyfw.12306.cn/otn/passport?redirect=/otn/login/userLogin',
                    'Origin': 'https://kyfw.12306.cn',
                    'User-Agent': _UA,
                })
                if self._safe_json(resp).get('newapptk'):
                    return self._safe_json(resp).get('newapptk')
            except Exception:
                pass
            time.sleep(0.3)
        return None

    def _uamauthclient(self, tk):
        for _ in range(max(1, Config().REQUEST_MAX_RETRY)):
            try:
                resp = self.session.post(API_AUTH_UAMAUTHCLIENT.get('url'), {'tk': tk})
                if self._safe_json(resp).get('username'):
                    return self._safe_json(resp).get('username')
            except Exception:
                pass
            time.sleep(0.3)
        return None

    def _post_login_finalize(self):
        """登录态建立后：取 uamtk → uamauthclient 拿真实用户名 → 存 cookie。

        真实用户名必须落库：引擎 UserJob.get_cookie_path() = USER_DATA_DIR + user_name + '.cookie'，
        账号行首次创建时 user_name 落的是 key 占位，若不回写，引擎会去找 <key>.cookie
        （该文件不存在，cookie 实际存成了 <真实名>.cookie），表现为「扫码成功但状态一直离线」。

        ⚠️ 收尾不要再请求 /otn/login/userLogin 或 API_USER_INFO：
        前者会 302 到登录页（可能清掉刚建立的 otn 会话），后者已下线（跳 12306 错误页）。
        """
        tk = self._uamtk()
        user_name = self._uamauthclient(tk) if tk else None
        self.user_name = user_name or self.user_name
        self.info['user_name'] = self.user_name
        self.save_cookie()
        if self.user_name and self.user_name != self.key:
            try:
                from py12306.webx.db import DataStore
                DataStore().account_update(self.key, {'user_name': self.user_name})
            except Exception:
                pass

    # ---------------- 账号密码登录（镜像 login2）----------------
    def login_password(self):
        """
        返回 (ok, user_name, msg)。
        首次登录若触发滑块，需已配置验证码识别（AuthCode / 钉钉信控）。
        """
        from py12306.helpers.auth_code import AuthCode
        from py12306.log.user_log import UserLog

        self.request_device_id()
        data = {'username': self.user_name, 'password': self.password}
        self.session.headers.update({'User-Agent': _UA})
        try:
            from py12306.order.order import Browser
            cookies, post_data = Browser().request_init_slide2(self.session, data)
            if not cookies or not post_data:
                return False, '', '滑块校验未完成，请稍后重试'
            for c in cookies:
                self.session.cookies.update({c['name']: c['value']})
            resp = self.session.post(API_BASE_LOGIN.get('url') + '?' + post_data)
        except Exception as e:
            return False, '', '登录请求异常: %s' % e
        result = self._safe_json(resp)
        code = result.get('result_code')
        if code == 0:
            self._post_login_finalize()
            UserLog.add_quick_log('账号 %s 登录成功' % self.user_name).flush()
            return True, self.user_name, ''
        msg = result.get('result_message') or result.get('message') or '登录失败'
        UserLog.add_quick_log('账号登录失败: %s' % msg).flush()
        return False, '', str(msg)

    # ---------------- 扫码登录（镜像 qr_login 的下载/轮询）----------------
    def qr_download(self):
        """返回 (ok, base64_png, msg)；uuid 存于 self.qr_uuid"""
        from py12306.log.user_log import UserLog
        self.request_device_id()
        try:
            resp = self.session.post(API_AUTH_QRCODE_BASE64_DOWNLOAD.get('url'), data={'appid': 'otn'})
            result = self._safe_json(resp)
        except Exception as e:
            return False, '', '二维码生成异常: %s' % e
        if result.get('result_code') == '0' and result.get('image'):
            self.qr_uuid = result.get('uuid')
            UserLog.add_quick_log('账号 %s 登录二维码已生成' % (self.user_name or self.key)).flush()
            return True, result.get('image'), ''
        return False, '', result.get('result_message') or '获取二维码失败'

    def qr_check(self, uuid):
        """
        轮询扫码状态。返回 (state, user_name)。
        state ∈ pending(已扫码待确认) | confirm(请确认) | success | expired | error
        """
        from py12306.log.user_log import UserLog
        data = {
            'RAIL_DEVICEID': self.session.cookies.get('RAIL_DEVICEID'),
            'RAIL_EXPIRATION': self.session.cookies.get('RAIL_EXPIRATION'),
            'uuid': uuid,
            'appid': 'otn',
        }
        try:
            resp = self.session.post(API_AUTH_QRCODE_CHECK.get('url'), data)
            result = self._safe_json(resp)
        except Exception:
            return 'error', ''
        try:
            code = int(result.get('result_code'))
        except Exception:
            return 'error', ''   # 非预期响应（多为 uuid 失效）
        if code == 0:
            self.last_qr_seen = time.time()
            return 'pending', ''
        if code == 1:
            if self.last_qr_seen and (time.time() - self.last_qr_seen) > 180:
                return 'expired', ''
            return 'confirm', ''
        if code == 2:
            self._post_login_finalize()
            UserLog.add_quick_log('账号 %s 扫码登录成功' % self.user_name).flush()
            return 'success', self.user_name
        if code == 3:
            return 'error', ''   # 二维码失效，前端重新生成
        return 'pending', ''

    # ---------------- 乘客 / 登录态 ----------------
    def is_login(self, user_name=None):
        self.load_cookie(user_name)
        try:
            resp = self.session.get(API_USER_LOGIN_CHECK)
            return self._safe_json(resp).get('data', {}).get('is_login') == 'Y'
        except Exception:
            return False

    @staticmethod
    def _pick_passengers(payload):
        """从各种响应结构里取乘客数组（12306 各接口字段名不一致）"""
        if not isinstance(payload, dict):
            return None
        data = payload.get('data')
        if isinstance(data, dict):
            for key in ('normal_passengers', 'datas', 'rows', 'list'):
                val = data.get(key)
                if isinstance(val, list) and val:
                    return val
        if isinstance(data, list) and data:
            return data
        return None

    def fetch_passengers(self, user_name=None):
        """
        取乘客列表。策略按「实测可用性」排序：
          1. 个人中心「乘车人管理」/otn/passengers/query  ← **实测唯一可用**（拿到 2 位乘客）
          2. 裸 getPassengerDTOs（旧兜底；实测已 302 到 /otn/safeguard/init）

        ⚠️ 不要调 initDc / /otn/login/userLogin / /otn/index/initMy12306：
        它们会 302 到登录页，拿着浏览器 cookie 去调反而会把 otn 会话清掉，
        导致随后的 /otn/passengers/query 前几次返回空（实测踩过）。
        """
        self.load_cookie(user_name)
        strategies = [
            ('passengers/query',
             lambda: self.session.post(API_PASSENGERS_QUERY,
                                       {'pageIndex': 1, 'pageSize': 100, '_json_att': ''})),
            ('getPassengerDTOs', lambda: self.session.post(API_USER_PASSENGERS)),
        ]
        self.last_passenger_probe = []
        for name, call in strategies:
            for _ in range(max(1, Config().REQUEST_MAX_RETRY)):
                try:
                    resp = call()
                    pax = self._pick_passengers(self._safe_json(resp))
                    self.last_passenger_probe.append((name, resp.status_code,
                                                      len(pax) if pax else 0))
                    if pax:
                        return pax
                except Exception:
                    pass
                time.sleep(0.3)
        return []
