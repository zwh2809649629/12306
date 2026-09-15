# -*- coding: utf-8 -*-
import os

from flask import Blueprint, Response, request

from py12306.config import Config

bp = Blueprint('logs', __name__)

# 级别粗筛关键字
LEVEL_KEYWORDS = {
    'error': ['错误', '失败', 'Error', 'error', 'Exception', '放弃', 'EXCEPTION'],
    'order': ['订单', 'Order', 'order', '下单', '支付', '出票'],
    'query': ['余票', '查询', 'query'],
    'user': ['账号', '用户', '登录', '心跳', 'cookie', 'Cookie'],
}


@bp.route('/api/logs')
def logs():
    path = Config().OUT_PUT_LOG_TO_FILE_PATH
    limit = int(request.args.get('limit') or 200)
    limit = max(1, min(limit, 2000))
    level = request.args.get('level') or ''
    q = (request.args.get('q') or '').strip()
    if not path or not os.path.exists(path):
        return {'code': 0, 'msg': '', 'data': {'lines': [], 'total': 0}}
    with open(path, encoding='utf-8', errors='replace') as f:
        lines = f.readlines()
    # 取尾部 limit
    total = len(lines)
    lines = lines[-limit:]
    if level in LEVEL_KEYWORDS:
        kws = LEVEL_KEYWORDS[level]
        lines = [x for x in lines if any(k in x for k in kws)]
    if q:
        lines = [x for x in lines if q in x]
    lines = [x.rstrip('\n') for x in lines]
    return {'code': 0, 'msg': '', 'data': {'lines': lines, 'total': total}}


@bp.route('/api/logs/download')
def logs_download():
    """下载最近 N 行日志文件（默认 5000）"""
    path = Config().OUT_PUT_LOG_TO_FILE_PATH
    n = int(request.args.get('n') or 5000)
    if not path or not os.path.exists(path):
        return {'code': 1, 'msg': '日志文件不存在', 'data': None}, 404
    with open(path, encoding='utf-8', errors='replace') as f:
        lines = f.readlines()
    content = ''.join(lines[-n:])
    fname = os.path.basename(path).replace('.log', '') + '_webx.log'
    return Response(content, mimetype='text/plain; charset=utf-8',
                    headers={'Content-Disposition': 'attachment; filename=' + fname})
