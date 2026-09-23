# -*- coding: utf-8 -*-
import os

from flask import Flask, jsonify, request, send_from_directory

from py12306.config import Config
from py12306.webx.db import DataStore

STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'static')

# 无需登录即可访问的前缀/精确路径
PUBLIC_PATHS = {'/api/auth/login', '/api/auth/me', '/api/boot'}


def create_app():
    app = Flask(__name__, static_folder=None)

    # JWT secret 持久化到 db kv（重启不变）
    db = DataStore()
    secret = db.kv_get('jwt_secret')
    if not secret:
        import secrets
        secret = secrets.token_hex(32)
        db.kv_set('jwt_secret', secret)
    app.config.update(
        SECRET_KEY=secret,
        JWT_SECRET_KEY=secret,
        JWT_TOKEN_LOCATION=['headers'],
        JWT_HEADER_TYPE='Bearer',
        JWT_ACCESS_TOKEN_EXPIRES=False,  # 登录态由前端"7天保持"控制；服务端不过期
    )

    from py12306.webx.server.auth import auth_bp
    from py12306.webx.server.routes_dashboard import bp as dashboard_bp
    from py12306.webx.server.routes_jobs import bp as jobs_bp
    from py12306.webx.server.routes_accounts import bp as accounts_bp
    from py12306.webx.server.routes_settings import bp as settings_bp
    from py12306.webx.server.routes_logs import bp as logs_bp
    from py12306.webx.server.routes_tickets import bp as tickets_bp
    from py12306.webx.server.routes_jobs_write import bp as jobs_write_bp
    from py12306.webx.server.routes_settings_write import bp as settings_write_bp
    from py12306.webx.server.routes_accounts_write import bp as accounts_write_bp
    from py12306.webx.server.routes_orders import bp as orders_bp
    app.register_blueprint(auth_bp)
    app.register_blueprint(dashboard_bp)
    app.register_blueprint(jobs_bp)
    app.register_blueprint(accounts_bp)
    app.register_blueprint(settings_bp)
    app.register_blueprint(logs_bp)
    app.register_blueprint(tickets_bp)
    app.register_blueprint(jobs_write_bp)
    app.register_blueprint(settings_write_bp)
    app.register_blueprint(accounts_write_bp)
    app.register_blueprint(orders_bp)

    # 统一 JSON 响应
    def ok(data=None, msg=''):
        return jsonify({'code': 0, 'msg': msg, 'data': data})

    def fail(msg, code=1, http=200):
        return jsonify({'code': code, 'msg': msg, 'data': None}), http

    app.ok = ok
    app.fail = fail

    # 统一错误
    @app.errorhandler(Exception)
    def on_error(e):
        from werkzeug.exceptions import HTTPException
        if isinstance(e, HTTPException):
            return jsonify({'code': 1, 'msg': str(e), 'data': None}), e.code
        return jsonify({'code': 1, 'msg': 'server error: %s' % e, 'data': None}), 500

    # 鉴权：/api 除白名单外需 Bearer
    @app.before_request
    def guard():
        p = request.path
        if not p.startswith('/api'):
            return None
        if p in PUBLIC_PATHS:
            return None
        from py12306.webx.server.auth import check_auth
        user = check_auth()
        if not user:
            return app.fail('unauthorized', code=401, http=401)
        request.webx_user = user
        return None

    # 页面与静态资源
    @app.route('/')
    def index():
        return send_from_directory(STATIC_DIR, 'index.html')

    @app.route('/static/<path:p>')
    def static_files(p):
        return send_from_directory(STATIC_DIR, p)

    # 基础路由（boot）
    @app.route('/api/boot')
    def boot():
        data = ConfigStore_get_safe()
        return app.ok({
            'seats': list(Config.SEAT_TYPES.keys()),
            'seat_price_order': ['商务座', '一等座', '二等座', '软卧', '硬卧', '硬座', '无座', '特等座'],
            'server': {
                'port': data.get('server', {}).get('port', 8600),
                'host': data.get('server', {}).get('host', '0.0.0.0'),
            },
            'runtime_dir': Config().RUNTIME_DIR,
        })

    # 旧任务在功能部署前没有车次/经停站缓存；正常服务启动后后台补建一次。
    # 测试客户端不得因此发起外网车票/经停站请求。
    try:
        from py12306.app import Const
        if not Const.IS_TEST:
            from py12306.webx.task_catalog import enqueue_missing_catalogs
            enqueue_missing_catalogs(app)
    except Exception:
        pass

    return app


def ConfigStore_get_safe():
    try:
        from py12306.webx.config_store import ConfigStore
        return ConfigStore().get()
    except Exception:
        return {}
