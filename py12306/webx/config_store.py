# -*- coding: utf-8 -*-
import copy
import json
import os

from py12306.config import Config
from py12306.helpers.func import singleton

# webx.json 内置默认值（首启生成；env.py 不参与任何环节）
WEBX_DEFAULTS = {
    'version': 1,
    'server': {'port': 8600, 'host': '0.0.0.0'},
    'query': {'interval': 1, 'request_max_retry': 5, 'thread_enabled': 0, 'job_timeout': 3},
    'user': {'heartbeat_interval': 120},
    'cdn': {'enabled': 0, 'check_time_out': 1},
    'log': {'to_file': 1, 'path': 'runtime/webx.log'},
    'auth_code': {'platform': 'free', 'api': '', 'account': {'user': '', 'pwd': ''}},
    'rail': {'cache_enabled': 0, 'expiration': '', 'device_id': ''},
    'notification': {
        'voice_code': {'enabled': 0, 'type': 'dingxin', 'app_code': '', 'phone': ''},
        'dingtalk': {'enabled': 0, 'webhook': ''},
        'telegram': {'enabled': 0, 'bot_api_url': ''},
        'serverchan': {'enabled': 0, 'key': ''},
        'pushbear': {'enabled': 0, 'key': ''},
        'bark': {'enabled': 0, 'push_url': ''},
        'email': {'enabled': 0, 'sender': '', 'receiver': '', 'host': '', 'user': '', 'password': ''}
    },
    'cluster': {
        'enabled': 0, 'node_is_master': 1, 'node_slave_can_be_master': 1,
        'node_name': 'master', 'redis_host': 'localhost', 'redis_port': '6379', 'redis_password': ''
    },
    'web': {'username': 'admin', 'password': ''}
}

# 需要脱敏回显的密钥字段（json 点路径）
SECRET_FIELDS = [
    'auth_code.account.pwd',
    'auth_code.api',
    'notification.voice_code.app_code',
    'notification.dingtalk.webhook',
    'notification.telegram.bot_api_url',
    'notification.serverchan.key',
    'notification.pushbear.key',
    'notification.bark.push_url',
    'notification.email.password',
    'cluster.redis_password',
    'web.password',
]


def _dig(data, dotted):
    cur = data
    for part in dotted.split('.'):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def _dig_set(data, dotted, value):
    parts = dotted.split('.')
    cur = data
    for part in parts[:-1]:
        cur = cur.setdefault(part, {})
    cur[parts[-1]] = value


@singleton
class ConfigStore:
    """
    runtime/webx.json —— webx 唯一运行期配置源
    - 首启由 WEBX_DEFAULTS 生成（chmod 600）
    - 原子写：tmp + rename
    - 密钥脱敏：get_masked / POST 空串=不修改
    """
    FILE = None
    _data = None

    def __init__(self):
        if self._data is not None: return
        # RUNTIME_DIR 末尾带 /，直接拼接即可
        self.FILE = Config().RUNTIME_DIR + 'webx.json'
        if not os.path.exists(Config().RUNTIME_DIR):
            os.makedirs(Config().RUNTIME_DIR, exist_ok=True)
        if not os.path.exists(self.FILE):
            self.write(WEBX_DEFAULTS)
        self._data = self._read_raw()

    # ---------------- 读 ----------------
    def _read_raw(self):
        with open(self.FILE, encoding='utf-8') as f:
            return json.load(f)

    def get(self):
        return copy.deepcopy(self._data)

    def refresh(self):
        self._data = self._read_raw()
        return self._data

    # ---------------- 写 ----------------
    def write(self, data):
        tmp = self.FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.FILE)
        self._data = data
        return data

    def update(self, patch):
        """deep-merge patch 进当前配置并写盘；对嵌套 dict 逐层合并"""
        data = self._data
        _deep_merge(data, patch)
        return self.write(data)

    # ---------------- 脱敏 ----------------
    def get_masked(self):
        """回显用：密钥只回 configured + 尾4位"""
        data = copy.deepcopy(self._data)
        state = {}
        for field in SECRET_FIELDS:
            raw = _dig(self._data, field)
            entry = {'configured': bool(raw)}
            if raw:
                s = str(raw)
                entry['tail'] = s[-4:] if len(s) >= 4 else ''
            state[field] = entry
            _dig_set(data, field, '****' + entry.get('tail', '') if raw else '')
        return {'config': data, 'state': state}

    def apply_patch_secrets(self, patch):
        """POST 语义：密钥字段空字符串=不修改（用旧值覆盖回 patch）"""
        for field in SECRET_FIELDS:
            v = _dig(patch, field) if _dig(patch, field) is not None else None
            if v == '' :
                old = _dig(self._data, field)
                if old is not None:
                    _dig_set(patch, field, old)
        return patch


def _deep_merge(base, patch):
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _deep_merge(base[k], v)
        else:
            base[k] = v
