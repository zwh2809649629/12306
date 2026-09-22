# -*- coding: utf-8 -*-
"""
P2：设置保存
PUT/POST /api/settings
  body = 与 /api/settings 回显相同结构的 config（脱敏字段空字符串=保持原值）。
  语义：ConfigStore.apply_patch_secrets → update(落盘) → ConfigSync.apply_settings()。
  特例：web.password 非空时改管理台口令（db.login_user_set_password），成功后配置值清空。
"""
import re
import copy

from flask import Blueprint, request

from py12306.log.common_log import CommonLog
from py12306.webx.config_store import ConfigStore, _deep_merge
from py12306.webx.db import DataStore
from py12306.webx.sync import ConfigSync, _pbkdf2

bp = Blueprint('settings_write', __name__)

_PWD_RE = re.compile(r'^[\x20-\x7e]{6,64}$')


@bp.route('/api/settings', methods=['POST', 'PUT'])
def settings_save():
    body = request.get_json(force=True) or {}
    cfg = body.get('config') or body
    if not isinstance(cfg, dict) or not cfg:
        return {'code': 1, 'msg': '缺少 config 内容', 'data': None}
    store = ConfigStore()
    data = store.get()

    # 1) 管理台口令重置（web 段独立处理）
    web = cfg.get('web') or {}
    new_pwd = (web.get('password') or '').strip() if isinstance(web, dict) else ''
    if new_pwd and not _PWD_RE.match(new_pwd):
        return {'code': 1, 'msg': '新密码需为 6-64 位字符', 'data': None}
    web_clean = {k: v for k, v in web.items() if k not in ('password', 'username')} if isinstance(web, dict) else {}

    # 2) 深合并得到完整配置（web 段：仅保留前端明确给出的 key）
    patch = {k: v for k, v in cfg.items() if v is not None}
    if web_clean:
        merged_web = {k: v for k, v in (data.get('web') or {}).items()}
        merged_web.update(web_clean)
        patch['web'] = merged_web
    store.apply_patch_secrets(patch)

    # 3) 数值字段类型规整（前端偶发传字符串）
    def _f(d, key, dflt):
        try:
            return float(d.get(key) if d else dflt)
        except Exception:
            try: return float(dflt)
            except Exception: return 0.0
    def _i(d, key, dflt):
        try:
            return int(float(d.get(key) if d else dflt))
        except Exception:
            try: return int(float(dflt))
            except Exception: return 0
    def _interval(value, fallback):
        if isinstance(value, dict):
            old_min = fallback.get('min') if isinstance(fallback, dict) else float(fallback) / 2
            old_max = fallback.get('max') if isinstance(fallback, dict) else float(fallback)
            try: low = float(value.get('min', old_min))
            except Exception: low = float(old_min)
            try: high = float(value.get('max', old_max))
            except Exception: high = float(old_max)
        else:
            try:
                high = float(value)
                low = high / 2
            except Exception:
                if isinstance(fallback, dict):
                    low, high = float(fallback.get('min', 0.5)), float(fallback.get('max', 1))
                else:
                    high = float(fallback)
                    low = high / 2
        low = max(0.1, low)
        high = max(low, high)
        return {'min': low, 'max': high}
    cfg_q = data.get('query') or {}
    cfg_q['interval'] = _interval((patch.get('query') or {}).get('interval'), cfg_q.get('interval', 1))
    cfg_q['request_max_retry'] = _i(patch.get('query', {}), 'request_max_retry', cfg_q.get('request_max_retry', 5))
    cfg_q['thread_enabled'] = _i(patch.get('query', {}), 'thread_enabled', cfg_q.get('thread_enabled', 0))
    cfg_q['job_timeout'] = _f(patch.get('query', {}), 'job_timeout', cfg_q.get('job_timeout', 3))
    patch['query'] = cfg_q
    cfg_u = data.get('user') or {}
    cfg_u['heartbeat_interval'] = _i(patch.get('user', {}), 'heartbeat_interval', cfg_u.get('heartbeat_interval', 120))
    patch['user'] = cfg_u
    cfg_s = data.get('server') or {}
    cfg_s['port'] = _i(patch.get('server', {}), 'port', cfg_s.get('port', 8600))
    patch['server'] = cfg_s
    cfg_c = data.get('cluster') or {}
    cfg_c['redis_port'] = str(_i(patch.get('cluster', {}), 'redis_port', cfg_c.get('redis_port', 6379)))
    patch['cluster'] = cfg_c

    effective = copy.deepcopy(data)
    _deep_merge(effective, patch)

    def _on(value):
        return value is True or value == 1 or value == '1'

    notification = effective.get('notification') or {}
    required_notifications = {
        'voice_code': ('app_code', 'phone'),
        'dingtalk': ('webhook',),
        'telegram': ('bot_api_url',),
        'serverchan': ('key',),
        'pushbear': ('key',),
        'bark': ('push_url',),
        'email': ('sender', 'receiver', 'host', 'user', 'password'),
    }
    for name, fields in required_notifications.items():
        item = notification.get(name) or {}
        if _on(item.get('enabled')) and any(not str(item.get(field) or '').strip() for field in fields):
            return {'code': 1, 'msg': '通知渠道“%s”尚未填写完整配置，不能启用' % name, 'data': None}

    cdn = effective.get('cdn') or {}
    if _on(cdn.get('enabled')):
        try:
            if float(cdn.get('check_time_out')) <= 0:
                raise ValueError
        except (TypeError, ValueError):
            return {'code': 1, 'msg': '启用 CDN 前请设置大于 0 的检测超时', 'data': None}

    rail = effective.get('rail') or {}
    if _on(rail.get('cache_enabled')) and (not str(rail.get('device_id') or '').strip() or not str(rail.get('expiration') or '').strip()):
        return {'code': 1, 'msg': '启用 RAIL 设备缓存前请填写设备 ID 和过期值', 'data': None}

    # 4) 落盘 + 生效
    try:
        store.update(patch)
    except Exception as e:
        return {'code': 1, 'msg': '配置写盘失败: %s' % e, 'data': None}

    if new_pwd:
        import secrets
        db = DataStore()
        username = (data.get('web') or {}).get('username') or 'admin'
        salt = secrets.token_hex(16)
        db.login_user_set_password(username, salt, _pbkdf2(new_pwd, salt))
        store.update({'web': {'password': ''}})
        CommonLog.add_quick_log('webx 管理台密码已重置').flush()

    try:
        ConfigSync.apply_settings()
    except Exception as e:
        CommonLog.add_quick_log('webx 设置应用失败: %s' % e).flush()

    return {'code': 0, 'msg': '已保存并生效', 'data': {'password_reset': bool(new_pwd)}}
