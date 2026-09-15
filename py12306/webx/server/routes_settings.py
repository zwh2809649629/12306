# -*- coding: utf-8 -*-
import os

from flask import Blueprint, request

from py12306.config import Config
from py12306.webx.config_store import ConfigStore

bp = Blueprint('settings', __name__)


@bp.route('/api/settings')
def settings_get():
    store = ConfigStore()
    masked = store.get_masked()
    log_cfg = ConfigStore().get().get('log', {})
    masked['config']['log']['path_exists'] = bool(log_cfg.get('path') and os.path.exists(log_cfg['path']))
    return {'code': 0, 'msg': '', 'data': masked}
