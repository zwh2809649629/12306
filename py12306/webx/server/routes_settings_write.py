# -*- coding: utf-8 -*-
"""
P2：设置保存
PUT/POST /api/settings
  body = 与 /api/settings 回显相同结构的 config（脱敏字段空字符串=保持原值）。
  语义：ConfigStore.apply_patch_secrets → update(落盘) → ConfigSync.apply_settings()。
  特例：web.password 非空时改管理台口令（db.login_user_set_password），成功后配置值清空。
"""
import re

from flask import Blueprint, request

from py12306.log.common_log import CommonLog
from py12306.webx.config_store import ConfigStore
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
    cfg_q = data.get('query') or {}
    cfg_q['interval'] = _f(patch.get('query', {}), 'interval', cfg_q.get('interval', 1))
    cfg_q['request_max_retry'] = _i(patch.get('query', {}), 'request_max_retry', cfg_q.get('request_max_retry', 5))
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
