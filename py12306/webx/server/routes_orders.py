# -*- coding: utf-8 -*-
"""
P3：下单接口（确认订单页 → 立即预定）

GET  /api/orders?limit=&job_id=     下单记录（order_log + 关联任务名）
GET  /api/orders/<id>               单条下单记录
POST /api/orders                    立即预定：校验 → 建「即时」任务 → 立即生效 → 记录
POST /api/orders/<id>/cancel        撤销：停用关联任务 + 记录置为 cancelled

设计说明
--------
py12306 引擎只在 **Job 上下文** 里下单（Job.handle_seats 命中 → Order.order()，
见 py12306/query/job.py）。管理台没有第二条路可走，因此「立即预定」= 创建一个
窄范围的一次性任务：
    job_name = "[即时] G79 北京西 至 深圳北"（ONE_SHOT_PREFIX 标记）
    train_numbers = 指定车次   interval 0.5~1s   left_dates = 单个日期
出票成功后 engine_hooks 会把该任务停用（一次性），并回填 order_log。

引擎能力边界
------------
py12306 只做「有票直订」（Job.is_has_ticket 要求 order_text == '预订'），
**不支持候补登记**。因此本接口不提供 waiting 模式，避免给出做不到的承诺。
"""
import datetime
import json

from flask import Blueprint, current_app, request

from py12306.config import Config
from py12306.log.common_log import CommonLog
from py12306.webx import presale
from py12306.webx.db import DataStore
from py12306.webx.engine_hooks import ONE_SHOT_PREFIX
from py12306.webx.server.routes_accounts import load_passengers
from py12306.webx.sync import ConfigSync

bp = Blueprint('orders', __name__)

ORDER_INTERVAL = (0.5, 1)  # 即时任务查询间隔：越快越好


def _parse_dates(train_date):
    """日期校验：以 12306 真实预售期为准（见 webx/presale.py）"""
    d = presale.parse(train_date)
    if d is None:
        return None, '出发日期格式应为 YYYY-MM-DD'
    if not presale.is_open(train_date):
        return None, presale.too_early_msg(train_date)
    return d.strftime('%Y-%m-%d'), None


def _view(row):
    return {
        'id': row['id'],
        'job_id': row.get('job_id'),
        'job_name': row.get('job_name') or '',
        'account_key': row.get('account_key'),
        'train_date': row.get('train_date'),
        'train_number': row.get('train_number'),
        'passengers': _loads(row.get('passengers')),
        'seats': _loads(row.get('seats')),
        'status': row.get('status'),
        'message': row.get('message') or '',
        'created_at': row.get('created_at'),
    }


def _loads(value):
    try:
        out = json.loads(value) if value else []
        return out if isinstance(out, list) else []
    except Exception:
        return []


@bp.route('/api/orders')
def orders_list():
    db = DataStore()
    limit = request.args.get('limit') or 50
    job_id = request.args.get('job_id') or None
    try:
        limit = int(limit)
    except Exception:
        limit = 50
    rows = db.order_list_with_job(limit=limit, job_id=job_id)
    return {'code': 0, 'msg': '', 'data': {
        'orders': [_view(r) for r in rows],
        'pending': db.order_pending_count(),
    }}


@bp.route('/api/orders/<int:order_id>')
def order_detail(order_id):
    row = DataStore().order_get(order_id)
    if not row:
        return {'code': 1, 'msg': '下单记录不存在', 'data': None}, 404
    view = _view(row)
    job = DataStore().job_get(row.get('job_id')) if row.get('job_id') else None
    view['job'] = {'job_id': job['job_id'], 'job_name': job.get('job_name'),
                   'is_active': bool(job.get('is_active'))} if job else None
    return {'code': 0, 'msg': '', 'data': view}


@bp.route('/api/orders', methods=['POST'])
def create_order():
    body = request.get_json(force=True) or {}
    db = DataStore()

    # ---- 账号 ----
    account_key = str(body.get('account_key') or '').strip()
    acc = db.account_get(account_key)
    if not acc:
        return {'code': 1, 'msg': '请选择有效的 12306 账号', 'data': None}
    if not acc.get('active') or not acc.get('login_ok'):
        return {'code': 1, 'msg': '账号未登录就绪，请先到「账号管理」完成登录', 'data': None}

    # ---- 日期 ----
    train_date, err = _parse_dates(body.get('train_date'))
    if err:
        return {'code': 1, 'msg': err, 'data': None}

    # ---- 区间 ----
    stations = []
    for s in (body.get('stations') or []):
        if isinstance(s, dict) and str(s.get('left') or '').strip() and str(s.get('arrive') or '').strip():
            stations.append({'left': str(s['left']).strip(), 'arrive': str(s['arrive']).strip()})
    if not stations:
        return {'code': 1, 'msg': '请至少提供一组出发/到达站', 'data': None}

    # ---- 车次（立即预定必须指定）----
    train_numbers = [str(t).strip().upper() for t in (body.get('train_numbers') or []) if str(t).strip()]
    if not train_numbers:
        return {'code': 1, 'msg': '立即预定需指定车次，请先在车票查询中勾选并选择席别', 'data': None}

    # ---- 席别 ----
    valid_seats = set(Config.SEAT_TYPES.keys())
    seats = [str(s).strip() for s in (body.get('seats') or []) if str(s).strip()]
    unknown = [s for s in seats if s not in valid_seats]
    if unknown:
        return {'code': 1, 'msg': '不支持的席别：%s（可选 %s）'
                % ('、'.join(unknown), '、'.join(valid_seats)), 'data': None}
    if not seats:
        return {'code': 1, 'msg': '请至少选择一种席别', 'data': None}

    # ---- 乘车人 ----
    members = [str(m).strip() for m in (body.get('members') or []) if str(m).strip()]
    if not members:
        return {'code': 1, 'msg': '请至少选择一位乘车人', 'data': None}
    # 立即预定必须从该账号已有乘客中挑选：解析不到就明确报错，
    # 否则会放行一个引擎侧永远匹配不到乘客、只会空转到 destroy 的任务。
    known = {p['name'] for p in load_passengers(account_key)}
    if not known:
        return {'code': 1, 'msg': '未获取到该账号的乘车人，请先到「账号管理」完成登录并同步乘客', 'data': None}
    missing = [m for m in members if m not in known]
    if missing:
        return {'code': 1, 'msg': '账号下不存在乘车人：%s（可到「账号管理」刷新乘客）'
                % '、'.join(missing), 'data': None}

    # ---- 建「即时」任务 ----
    seg = stations[0]
    name = ('%s%s %s 至 %s' % (ONE_SHOT_PREFIX, train_numbers[0], seg['left'], seg['arrive']))[:40]
    try:
        job_id = db.job_create({
            'job_name': name,
            'account_key': account_key,
            'left_dates': [train_date],
            'stations': stations,
            'seats': seats,
            'train_numbers': train_numbers,
            'except_train_numbers': [],
            'members': members,
            'allow_less_member': 1 if body.get('allow_less_member') else 0,
            'period_from': '00:00',
            'period_to': '24:00',
            'interval_min': ORDER_INTERVAL[0],
            'interval_max': ORDER_INTERVAL[1],
            'is_active': 1,
        })
    except Exception as e:
        return {'code': 1, 'msg': '创建下单任务失败: %s' % e, 'data': None}

    # 先落记录再发布，避免引擎抢在下单记录之前命中
    db.order_add(job_id=job_id, account_key=account_key, train_date=train_date,
                 train_number=train_numbers[0], passengers=members, seats=seats,
                 status='queued', message='已创建即时下单任务，等待余票')
    ConfigSync.publish_jobs()
    try:
        from py12306.webx.task_catalog import enqueue_job_catalog
        enqueue_job_catalog(current_app._get_current_object(), job_id)
    except Exception as e:
        CommonLog.add_quick_log('webx 即时任务车次详情缓存启动失败: %s' % e).flush()

    CommonLog.add_quick_log(
        'webx 立即预定: %s %s %s 至 %s 席别 %s 乘车人 %s'
        % (train_numbers[0], train_date, seg['left'], seg['arrive'],
           '、'.join(seats), '、'.join(members))).flush()

    return {'code': 0, 'msg': '已提交，命中余票后自动下单', 'data': {
        'job_id': job_id, 'job_name': name,
        'train_date': train_date, 'train_numbers': train_numbers, 'seats': seats,
    }}


@bp.route('/api/orders/<int:order_id>/cancel', methods=['POST'])
def cancel_order(order_id):
    db = DataStore()
    row = db.order_get(order_id)
    if not row:
        return {'code': 1, 'msg': '下单记录不存在', 'data': None}, 404
    status = row.get('status')
    if status == 'cancelled':
        return {'code': 0, 'msg': '已是取消状态', 'data': {'order_id': order_id}}
    if status == 'success':
        return {'code': 1, 'msg': '该单已出票，请到 12306「未完成订单」处理', 'data': None}

    stopped = False
    job_id = row.get('job_id')
    job = db.job_get(job_id) if job_id else None
    if job and job.get('is_active'):
        db.job_toggle_active(job_id, 0)
        ConfigSync.publish_jobs()
        stopped = True
    db.order_update_status(order_id, 'cancelled', '已取消')
    CommonLog.add_quick_log('webx 取消下单记录 #%s（任务 %s）' % (order_id, job_id or '无')).flush()
    return {'code': 0, 'msg': '已取消', 'data': {'order_id': order_id, 'job_stopped': stopped}}
