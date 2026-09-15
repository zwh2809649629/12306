# -*- coding: utf-8 -*-
import jwt

from flask import Blueprint, jsonify, request

from py12306.config import Config
from py12306.webx.db import DataStore
from py12306.webx.sync import _pbkdf2

auth_bp = Blueprint('auth', __name__)


def _secret():
    return DataStore().kv_get('jwt_secret')


def issue_token(username):
    return jwt.encode({'username': username}, _secret(), algorithm='HS256')


def check_auth():
    """从 Authorization: Bearer <token> 解析用户名；无效返回 None"""
    header = request.headers.get('Authorization', '')
    if not header.startswith('Bearer '):
        return None
    token = header[7:].strip()
    try:
        payload = jwt.decode(token, _secret(), algorithms=['HS256'])
        return payload.get('username')
    except Exception:
        return None


@auth_bp.route('/api/auth/login', methods=['POST'])
def login():
    body = request.get_json(force=True) or {}
    username = (body.get('username') or '').strip()
    password = body.get('password') or ''
    row = DataStore().login_user_get(username)
    if not row or _pbkdf2(password, row['salt']) != row['pass_hash']:
        return jsonify({'code': 1, 'msg': '用户名或密码错误', 'data': None}), 401
    return jsonify({'code': 0, 'msg': '', 'data': {
        'token': issue_token(username),
        'username': username,
    }})


@auth_bp.route('/api/auth/me')
def me():
    username = check_auth()
    if not username:
        return jsonify({'code': 401, 'msg': 'unauthorized', 'data': None}), 401
    return jsonify({'code': 0, 'msg': '', 'data': {'username': username}})


@auth_bp.route('/api/auth/change_password', methods=['POST'])
def change_password():
    username = check_auth()
    if not username:
        return jsonify({'code': 401, 'msg': 'unauthorized', 'data': None}), 401
    body = request.get_json(force=True) or {}
    old = body.get('old_password') or ''
    new = body.get('password') or ''
    if len(new) < 6:
        return jsonify({'code': 1, 'msg': '新密码至少 6 位', 'data': None})
    import secrets
    db = DataStore()
    row = db.login_user_get(username)
    if _pbkdf2(old, row['salt']) != row['pass_hash']:
        return jsonify({'code': 1, 'msg': '原密码错误', 'data': None})
    salt = secrets.token_hex(16)
    db.login_user_set_password(username, salt, _pbkdf2(new, salt))
    return jsonify({'code': 0, 'msg': '密码已修改', 'data': None})
