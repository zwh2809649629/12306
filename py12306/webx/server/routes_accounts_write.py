# -*- coding: utf-8 -*-
"""
P2：账号写接口（扫码 / 账号密码登录、登出、删除）
POST   /api/accounts                    {type:'qr'|'pwd', user_name?, password?} → {key}
GET    /api/accounts/<key>/qr/start     → {uuid, image(base64 png)}
GET    /api/accounts/<key>/qr/check     → {state: pending|confirm|success|expired|error, user_name?}
POST   /api/accounts/<key>/login        密码登录（凭据取账号行；可 body 覆盖）
POST   /api/accounts/<key>/logout       登出（停用 + 清会话，行保留可重新登录）
POST   /api/accounts/<key>/rescan       扫码账号重新登录
DELETE /api/accounts/<key>
"""
import json
import os
import uuid as uuidlib

from flask import Blueprint, request

from py12306.config import Config
from py12306.log.user_log import UserLog
from py12306.webx import webx12306
from py12306.webx.db import DataStore
from py12306.webx.sync import ConfigSync

bp = Blueprint('accounts_write', __name__)


def _db():
    return DataStore()


def _get_acc(key):
    acc = _db().account_get(str(key))
    if not acc:
        return None
    return acc


def _pax_file(user_name):
    return Config().USER_PASSENGERS_FILE % user_name


def _save_pax_file(user_name, passengers):
    try:
        with open(_pax_file(user_name), 'w', encoding='utf-8') as f:
            f.write(json.dumps(passengers, indent=4, ensure_ascii=False))
        return True
    except Exception:
        return False


def _do_login_success(key):
    """登录成功收尾：db 标记 + 乘客预拉 + 发布会话。"""
    db = _db()
    acc = _get_acc(key)
    if not acc:
        return
    w = webx12306.Webx12306(key, user_name=acc.get('user_name') or '')
    real_name = w.user_name or acc.get('user_name') or key
    passengers = w.fetch_passengers(real_name)
    if passengers:
        _save_pax_file(real_name, passengers)
    db.account_update(key, {'user_name': real_name, 'login_ok': 1, 'active': 1})
    ConfigSync.publish_accounts()
    UserLog.add_quick_log('webx 账号就绪: %s（乘客 %d 人）' % (real_name, len(passengers or []))).flush()


@bp.route('/api/accounts', methods=['POST'])
def account_create():
    body = request.get_json(force=True) or {}
    acc_type = body.get('type') or 'qr'
    if acc_type not in ('qr', 'pwd'):
        return {'code': 1, 'msg': 'type 需为 qr 或 pwd', 'data': None}
    user_name = str(body.get('user_name') or '').strip()
    password = str(body.get('password') or '')
    if acc_type == 'pwd' and not user_name:
        return {'code': 1, 'msg': '请输入手机号 / 用户名', 'data': None}
    key = uuidlib.uuid4().hex[:12]
    _db().account_create(key, user_name or '', password, acc_type)
    return {'code': 0, 'msg': '已创建', 'data': {'key': key}}


@bp.route('/api/accounts/<key>/qr/start', methods=['GET'])
def account_qr_start(key):
    acc = _get_acc(key)
    if not acc:
        return {'code': 1, 'msg': '账号不存在', 'data': None}, 404
    if (acc.get('type') or 'qr') != 'qr':
        return {'code': 1, 'msg': '该账号为密码登录，请刷新页面选择扫码方式', 'data': None}
    w = webx12306._qr_session(key)
    ok, image, msg = w.qr_download()
    if not ok:
        return {'code': 1, 'msg': msg, 'data': None}
    return {'code': 0, 'msg': '', 'data': {'uuid': w.qr_uuid or '', 'image': image}}


@bp.route('/api/accounts/<key>/qr/check', methods=['GET'])
def account_qr_check(key):
    acc = _get_acc(key)
    if not acc:
        return {'code': 1, 'msg': '账号不存在', 'data': None}, 404
    if (acc.get('type') or 'qr') != 'qr':
        return {'code': 1, 'msg': '该账号不是扫码登录', 'data': None}
    w = webx12306._qr_session(key)
    uuid_ = request.args.get('uuid') or w.qr_uuid or ''
    if not uuid_:
        return {'code': 1, 'msg': '二维码未生成，请先生成', 'data': None}
    state, user_name = w.qr_check(uuid_)
    out = {'state': state}
    if state == 'success':
        _do_login_success(key)
        out['user_name'] = user_name
    return {'code': 0, 'msg': '', 'data': out}


@bp.route('/api/accounts/<key>/login', methods=['POST'])
def account_login(key):
    acc = _get_acc(key)
    if not acc:
        return {'code': 1, 'msg': '账号不存在', 'data': None}, 404
    if (acc.get('type') or 'pwd') != 'pwd':
        return {'code': 1, 'msg': '该账号为扫码登录，请使用扫码方式', 'data': None}
    body = request.get_json(force=True) or {}
    user_name = str(body.get('user_name') or '').strip() or acc.get('user_name') or ''
    password = str(body.get('password') or '') or acc.get('password') or ''
    if not user_name or not password:
        return {'code': 1, 'msg': '用户名或密码缺失', 'data': None}
    w = webx12306.Webx12306(key, user_name=user_name, password=password)
    ok, real_name, msg = w.login_password()
    if not ok:
        return {'code': 1, 'msg': msg or '登录失败', 'data': None}
    _db().account_update(key, {'user_name': real_name or user_name, 'password': password})
    _do_login_success(key)
    return {'code': 0, 'msg': '登录成功', 'data': {'user_name': real_name or user_name}}


def _kill_user(key):
    try:
        from py12306.user.user import User
        u = User().get_user(str(key))
        if u:
            u.is_alive = False
    except Exception:
        pass


def _clear_cookie(key):
    acc = _get_acc(key)
    if not acc:
        return
    name = acc.get('user_name') or key
    for cand in (name, key):
        p = Config().USER_DATA_DIR + str(cand) + '.cookie'
        try:
            if os.path.exists(p):
                os.remove(p)
        except Exception:
            pass


@bp.route('/api/accounts/<key>/logout', methods=['POST'])
def account_logout(key):
    acc = _get_acc(key)
    if not acc:
        return {'code': 1, 'msg': '账号不存在', 'data': None}, 404
    _db().account_update(key, {'active': 0, 'login_ok': 0})
    _clear_cookie(key)
    _kill_user(key)
    ConfigSync.publish_accounts()
    UserLog.add_quick_log('webx 账号已登出: %s' % (acc.get('user_name') or key)).flush()
    return {'code': 0, 'msg': '已登出', 'data': None}


@bp.route('/api/accounts/<key>/rescan', methods=['POST'])
def account_rescan(key):
    acc = _get_acc(key)
    if not acc:
        return {'code': 1, 'msg': '账号不存在', 'data': None}, 404
    if (acc.get('type') or 'qr') != 'qr':
        return {'code': 1, 'msg': '该账号为密码登录，请直接重新登录', 'data': None}
    _db().account_update(key, {'active': 0, 'login_ok': 0})
    _clear_cookie(key)
    _kill_user(key)
    ConfigSync.publish_accounts()
    return {'code': 0, 'msg': '已重置，请重新扫码', 'data': None}


@bp.route('/api/accounts/<key>', methods=['DELETE'])
def account_delete(key):
    acc = _get_acc(key)
    if not acc:
        return {'code': 1, 'msg': '账号不存在', 'data': None}, 404
    _clear_cookie(key)
    _kill_user(key)
    _db().account_delete(key)
    ConfigSync.publish_accounts()
    UserLog.add_quick_log('webx 账号已删除: %s' % (acc.get('user_name') or key)).flush()
    return {'code': 0, 'msg': '已删除', 'data': None}
