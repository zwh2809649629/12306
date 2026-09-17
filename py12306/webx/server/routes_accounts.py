# -*- coding: utf-8 -*-
import re

from flask import Blueprint, request

from py12306.config import Config
from py12306.webx.db import DataStore

bp = Blueprint('accounts', __name__)


def _mask(user_name):
    """手机号 138****6688 / 邮箱 a***@xx / 其他中间打码"""
    if not user_name:
        return ''
    s = str(user_name)
    m = re.match(r'^(\d{3})\d{4}(\d{4})$', s)
    if m:
        return m.group(1) + '****' + m.group(2)
    if '@' in s:
        local, _, domain = s.partition('@')
        if len(local) > 1:
            return local[0] + '*' * (len(local) - 1) + '@' + domain
    if len(s) <= 2:
        return s
    return s[0] + '*' * min(6, len(s) - 2) + s[-1]


@bp.route('/api/accounts')
def accounts_list():
    db = DataStore()
    # 运行态（UserJob）
    runtime = {}
    try:
        from py12306.user.user import User
        for u in User().users:
            runtime[str(u.key)] = {
                'online': bool(getattr(u, 'cookie', False) and getattr(u, 'is_ready', False)),
                'is_ready': bool(getattr(u, 'is_ready', False)),
                'last_heartbeat': getattr(u, 'last_heartbeat', None),
                'login_num': getattr(u, 'login_num', 0),
                'passenger_count': len(getattr(u, 'passengers', []) or []),
            }
    except Exception:
        pass
    out = []
    for a in db.account_list():
        key = str(a['key'])
        rt = runtime.get(key)
        # 引擎里还没有这个账号对象（刚点「添加账号」扫码成功、尚未发布到引擎，
        # 或服务刚起还没 init_users）→ 用 DB 里的「已验证登录」兜底，
        # 否则刚扫码成功的那一刻界面仍显示「离线」，看起来像登录没生效。
        # ⚠️ 只在**引擎没有该对象**时兜底：引擎有对象且 is_ready=False 说明会话真的失效，
        # 这时不能谎报「在线」，否则账号掉线会被静默掩盖。
        if rt is None:
            verified = bool(a.get('login_ok')) and bool(a.get('active'))
            rt = {
                'online': verified,
                'is_ready': verified,
                'last_heartbeat': None,
                'login_num': 0,
                'passenger_count': 0,
            }
        out.append({
            'key': a['key'],
            'user_name': _mask(a.get('user_name')),
            'type': a.get('type') or 'qr',
            'active': bool(a.get('active')),
            'login_ok': bool(a.get('login_ok')),
            'created_at': a.get('created_at'),
            'online': rt.get('online', False),
            'is_ready': rt.get('is_ready', False),
            'last_heartbeat': rt.get('last_heartbeat'),
            'login_num': rt.get('login_num', 0),
            'passenger_count': rt.get('passenger_count', 0),
        })
    return {'code': 0, 'msg': '', 'data': {'accounts': out}}


@bp.route('/api/accounts/<key>/passengers')
def account_passengers(key):
    db = DataStore()
    acc = db.account_get(key)
    if not acc:
        return {'code': 1, 'msg': '账号不存在', 'data': None}, 404
    return {'code': 0, 'msg': '', 'data': {'passengers': load_passengers(key)}}


def load_passengers(key):
    """
    账号乘客列表（已归一化，供新建任务/下单页/下单接口复用）。
    取数优先级：引擎内存 UserJob.passengers → runtime/user/<user_name>_passengers.json
    """
    acc = DataStore().account_get(key) or {}
    raw = None
    try:
        from py12306.user.user import User
        u = User().get_user(key)
        if u and getattr(u, 'passengers', None):
            raw = list(u.passengers)
    except Exception:
        raw = None
    if raw is None:
        import os
        import json
        user_name = acc.get('user_name') or ''
        if user_name:
            path = Config().USER_PASSENGERS_FILE % user_name
            if os.path.exists(path):
                try:
                    with open(path, encoding='utf-8') as f:
                        raw = json.load(f)
                except Exception:
                    raw = None
    return _normalize_passengers(raw or [])


def _normalize_passengers(raw):
    """
    12306 normal_passengers → 前端统一结构 {name, type, no, code, mobile}
    未归一化的原始乘客只有 passenger_name / passenger_id_no / passenger_type_name，
    直接回显会让前端把 name/no 渲染成 undefined，也会让任务 members 写坏。
    同时兼容已是归一化结构的数据（幂等）。
    """
    out = []
    for p in raw:
        if not isinstance(p, dict):
            continue
        name = p.get('name') or p.get('passenger_name') or ''
        if not name:
            continue
        out.append({
            'name': name,
            'type': p.get('type_text') or p.get('type') or p.get('passenger_type_name') or '',
            'type_code': p.get('passenger_type') or '',
            'no': p.get('no') or p.get('passenger_id_no') or '',
            'code': p.get('code') or '',
            'mobile': p.get('mobile') or p.get('mobile_no') or '',
        })
    return out
