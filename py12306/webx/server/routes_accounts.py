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
        rt = runtime.get(key, {})
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
    try:
        from py12306.user.user import User
        u = User().get_user(key)
        if u and getattr(u, 'passengers', None):
            return {'code': 0, 'msg': '', 'data': {'passengers': list(u.passengers)}}
    except Exception:
        pass
    # 兜底：读 runtime/user/<user_name>_passengers.json
    import os
    import json
    user_name = acc.get('user_name') or ''
    if user_name:
        path = Config().USER_PASSENGERS_FILE % user_name
        if os.path.exists(path):
            try:
                with open(path, encoding='utf-8') as f:
                    return {'code': 0, 'msg': '', 'data': {'passengers': json.load(f)}}
            except Exception:
                pass
    return {'code': 0, 'msg': '', 'data': {'passengers': []}}
