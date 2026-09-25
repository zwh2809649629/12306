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


def _acc_name(acc):
    """账号行里的 user_name；首次创建落的是 key 占位，视作「未知」"""
    name = str(acc.get('user_name') or '').strip()
    if not name or name == str(acc.get('key') or ''):
        return ''
    return name


def _force_engine_ready(key):
    """
    让引擎**立刻**认得刚写好的会话，而不是等它自己的心跳周期。

    背景（用户反馈「账号登录了但状态没立马更新」）：
    界面上的「在线」取自引擎内存 `UserJob.is_ready`，而它只在
    `check_heartbeat()` → `user_did_load()` 里被置 True。
    但 `check_heartbeat()` 开头有这么一条短路：

        if self.get_last_heartbeat() and (time_int() - self.get_last_heartbeat()) < USER_HEARTBEAT_INTERVAL:
            return True          # ← 直接返回，不会重新判定、也不置 is_ready

    `USER_HEARTBEAT_INTERVAL` 默认 **120 秒**。所以重新扫码/登录之后，
    只要上一次心跳还在窗口内，界面就会一直显示「离线」，最长要等 2 分钟才翻过来。

    这里主动：清掉心跳时间戳（解除上述短路）→ 让引擎读一次刚落盘的 cookie
    （`load_user()` → `did_loaded_user()` → `user_did_load()` → `is_ready = True`）。
    `did_loaded_user` 内部用的 `check_user_is_login()` / `can_access_passengers()`
    都已被 webx 钩子改成现代 12306 可用的判定，所以这一步是同步且立即生效的。
    引擎里还没有这个账号对象（全新账号尚未发布）时直接跳过 —— 发布流程会自己加载。
    """
    try:
        from py12306.user.user import User
        u = User().get_user(str(key))
        if u is None:
            return False
        try:
            u.set_last_heartbeat(0)
        except Exception:
            pass
        ok = bool(u.load_user())
        if ok:
            try:
                u.user_did_load()
            except Exception:
                pass
        return ok
    except Exception:
        return False


def _do_login_success(key, real_name=None):
    """登录成功收尾：db 标记 + 乘客预拉 + 发布会话。

    real_name 由调用方（qr_check / login_password）把登录过程中探到的真实用户名传进来。
    不能只信账号行的 user_name：扫码首次登录时该字段还是 key 占位，一旦拿它当用户名，
    cookie 会被存成 <key>.cookie 而引擎按 <key>.cookie 去 load 也「刚好」能对上，
    但真实 cookie 实际在 <真实名>.cookie → 引擎加载失败 → 账号永远离线、乘客永远是 0 人。
    """
    db = _db()
    acc = _get_acc(key)
    if not acc:
        return
    # 优先复用进程内的扫码会话（内存里已是登录态 / 已探到真实名），其次才是无状态新实例
    w = webx12306._QR_SESSIONS.get(str(key))
    if w is None:
        w = webx12306.Webx12306(key, user_name=_acc_name(acc))
    real_name = str(real_name or '').strip()
    if not real_name:
        real_name = str(w.user_name or '').strip() or _acc_name(acc)
    if not real_name:
        real_name = str(key)
    w.user_name = real_name
    passengers = w.fetch_passengers(real_name)
    if passengers:
        _save_pax_file(real_name, passengers)
    # 会话 cookies 非空才落盘，避免空会话把已有 cookie 覆盖掉
    try:
        if len(w.session.cookies) > 0:
            w.save_cookie()
    except Exception:
        pass
    db.account_update(key, {'user_name': real_name, 'login_ok': 1, 'active': 1})
    removed = _dedupe_by_name(key, real_name)
    ConfigSync.publish_accounts()
    _force_engine_ready(key)
    # 账号恢复不一定改变 QUERY_JOBS；若查询循环此前因账号失效退出，
    # 仅发布账号不会重新唤醒任务，因此显式做一次任务发布/循环自检。
    ConfigSync.publish_jobs()
    if removed:
        UserLog.add_quick_log('webx 账号去重: %s 与账号 %s 同名，已移除重复行'
                              % (real_name, '、'.join(removed))).flush()
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
        _do_login_success(key, user_name)
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
    _do_login_success(key, real_name or user_name)
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
    # 若还有其它账号行共用同一个 user_name，则 **不能** 删 <user_name>.cookie
    # （否则删掉一个重复行会把另一个还在用的账号一起踢下线）。
    # 重名账号由 _dedupe_by_name 在登录成功时收敛，这里只做兼容性保护。
    want = {str(name), _acc_name(acc)} - {''}
    shared = any(
        str(a.get('key')) != str(key) and str(a.get('user_name') or '') in want
        for a in _db().account_list())
    cands = {str(key)} if shared else ({str(key)} | want)
    for cand in cands - {''}:
        p = Config().USER_DATA_DIR + cand + '.cookie'
        try:
            if os.path.exists(p):
                os.remove(p)
        except Exception:
            pass


def _dedupe_by_name(key, real_name):
    """同一个 12306 账号只保留一行。

    账号行在「点扫码」时就先建了（此时还不知道用户名），登录成功才知道真实名，
    所以重复检测只能放在这里：把其它同名的重复行直接摘掉（用 db 删除，
    **不**走 _clear_cookie，否则会删掉幸存者赖以工作的 <real_name>.cookie）。
    不收敛的话：两行都会发布会话 → 两个 UserJob 抢同一个 cookie 文件 → 双双离线。
    """
    if not real_name:
        return []
    db = _db()
    removed = []
    for a in db.account_list():
        if str(a.get('key')) == str(key):
            continue
        if str(a.get('user_name') or '') == str(real_name):
            db.account_delete(a['key'])
            removed.append(str(a.get('key')))
    return removed


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
