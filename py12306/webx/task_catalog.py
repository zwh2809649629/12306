# -*- coding: utf-8 -*-
"""Build and persist task-scoped train/stopover snapshots outside detail-page requests."""
import json
import queue
import threading
import uuid
from urllib.parse import urlencode

from py12306.webx.db import DataStore

_QUEUE = queue.Queue()
_LOCK = threading.Lock()
_WORKER = None


def enqueue_job_catalog(app, job_id):
    """Schedule one fresh catalog after a task is created or its query scope changes."""
    global _WORKER
    try:
        from py12306.app import Const
        if Const.IS_TEST:
            return
    except Exception:
        pass
    db = DataStore()
    if not db.job_get(job_id):
        return
    generation = uuid.uuid4().hex
    db.job_catalog_begin(job_id, generation)
    with _LOCK:
        _QUEUE.put((app, str(job_id), generation))
        if _WORKER is None or not _WORKER.is_alive():
            _WORKER = threading.Thread(target=_run, name='webx-job-catalog', daemon=True)
            _WORKER.start()


def enqueue_missing_catalogs(app):
    """Resume interrupted catalogs, seed legacy rows, and report cached empty results once."""
    db = DataStore()
    for job in db.job_list():
        catalog = db.job_catalog_get(job['job_id'])
        if catalog is None or catalog.get('state') in ('building', 'pending'):
            enqueue_job_catalog(app, job['job_id'])
            continue
        if catalog.get('state') not in ('ready', 'partial'):
            continue
        try:
            payload = json.loads(catalog.get('payload') or '[]')
        except Exception:
            payload = []
        # 旧版本目录没有保存车次级始发信息；重建一次后，目录会保存查询结果
        # 中的始发日期，刷新经停站时无需再次推断或试探日期。
        if payload and any(isinstance(item, dict) and (
            'start_date' not in item or 'start_station' not in item) for item in payload):
            enqueue_job_catalog(app, job['job_id'])
            continue
        if payload:
            continue
        exists = db.query(
            "SELECT id FROM job_event WHERE job_id=? AND kind='catalog_empty' LIMIT 1",
            (job['job_id'],))
        if exists:
            continue
        message = catalog.get('message') or (
            '条件筛选未找到有效车次')
        db.job_event_add(job['job_id'], 'catalog_empty', message)
        try:
            from py12306.log.common_log import CommonLog
            CommonLog.add_quick_log('[%s] 警告：%s' % (job.get('job_name') or job['job_id'], message)).flush()
        except Exception:
            pass


def refresh_job_stop(app, job_id, train_number, date):
    """Refresh one task-catalog train's stop data and persist the result."""
    from py12306.webx.server.routes_tickets import tickets, tickets_stops

    db = DataStore()
    if not db.job_get(job_id):
        return {'code': 1, 'msg': '任务不存在', 'data': None}
    catalog = db.job_catalog_get(job_id)
    if not catalog:
        return {'code': 1, 'msg': '任务车次缓存尚未生成，请稍后重试', 'data': None}
    try:
        payload = json.loads(catalog.get('payload') or '[]')
    except Exception:
        payload = []
    target = next((item for item in payload
                   if str(item.get('train_number') or '').upper() == str(train_number).upper()
                   and str(item.get('date') or '') == str(date)), None)
    if target is None:
        return {'code': 1, 'msg': '任务缓存中没有该车次和日期', 'data': None}
    train_no = str(target.get('train_no') or '').strip()
    if not train_no:
        return {'code': 1, 'msg': '该车次缺少 12306 内部车次号', 'data': None}

    query_date = str(target.get('start_date') or date)
    path = '/api/tickets/stops?' + urlencode({'train_no': train_no, 'date': query_date})
    result = _invoke_route(app, tickets_stops, path)
    item_updates = {}
    if result.get('code') != 0 and result.get('msg') == '未获取到经停站信息':
        left = str(target.get('from_station') or '').strip()
        arrive = str(target.get('to_station') or '').strip()
        if left and arrive:
            ticket_result, rows = _query_ticket_rows(
                app, tickets, left, arrive, target.get('date') or date, 'exact')
            if ticket_result.get('code') == 0:
                fresh = next((row for row in rows
                              if str(row.get('n') or '').upper() == str(train_number).upper()), None)
                if fresh:
                    train_no = str(fresh.get('no') or train_no).strip()
                    query_date = str(fresh.get('start_date') or target.get('date') or date)
                    item_updates = {
                        'train_no': train_no,
                        'start_date': query_date,
                        'start_station': str(fresh.get('start_station') or target.get('start_station') or ''),
                        'end_station': str(fresh.get('end_station') or target.get('end_station') or ''),
                    }
                    path = '/api/tickets/stops?' + urlencode({
                        'train_no': train_no,
                        'date': query_date,
                    })
                    result = _invoke_route(app, tickets_stops, path)
    if result.get('code') == 0 and result.get('data'):
        updated = db.job_catalog_update_stop(
            job_id, train_number, date, stops_data=result.get('data'), item_updates=item_updates)
        if updated is None:
            return {'code': 1, 'msg': '任务车次缓存已发生变化，请刷新详情后重试', 'data': None}
        return {'code': 0, 'msg': '经停站缓存已刷新',
                'data': {'item': updated, 'stops_data': result.get('data')}}

    message = str(result.get('msg') or '经停站获取失败')
    db.job_catalog_update_stop(job_id, train_number, date,
                               stops_error=message, item_updates=item_updates)
    return {'code': 1, 'msg': message, 'data': None}


def _run():
    while True:
        app, job_id, generation = _QUEUE.get()
        try:
            _build_and_save(app, job_id, generation)
        except Exception as exc:
            DataStore().job_catalog_set(job_id, generation, 'failed', [], str(exc))
        finally:
            _QUEUE.task_done()


def _current(job_id, generation):
    db = DataStore()
    row = db.job_catalog_get(job_id)
    return bool(row and row.get('generation') == generation and db.job_get(job_id))


def _time_minutes(value, fallback):
    try:
        if str(value).strip() == '24:00':
            return 24 * 60
        h, m = str(value).strip().split(':', 1)
        h, m = int(h), int(m)
        if 0 <= h <= 24 and 0 <= m < 60:
            return h * 60 + m
    except Exception:
        pass
    return fallback


def _within_period(departure, start, end):
    try:
        h, m = str(departure or '').split(':', 1)
        minute = int(h) * 60 + int(m)
        return start <= minute <= end
    except Exception:
        return False


def _invoke_route(app, route, path):
    with app.test_request_context(path):
        result = route()
    if isinstance(result, tuple):
        result = result[0]
    return result if isinstance(result, dict) else {}


def _query_ticket_rows(app, tickets_route, left, arrive, date, station_mode):
    params = {
        'left': left,
        'arrive': arrive,
        'date': str(date),
        'station_mode': station_mode,
    }
    result = _invoke_route(app, tickets_route, '/api/tickets?' + urlencode(params))
    rows = ((result.get('data') or {}).get('rows') or []
            if result.get('code') == 0 else [])
    return result, rows


def _build_and_save(app, job_id, generation):
    from py12306.webx.server.routes_tickets import tickets, tickets_stops

    db = DataStore()
    job = db.job_get(job_id)
    if not job or not _current(job_id, generation):
        return
    try:
        stations = json.loads(job.get('stations') or '[]')
        dates = json.loads(job.get('left_dates') or '[]')
        train_items = json.loads(job.get('train_items') or '[]')
        train_numbers = {str(n).strip().upper() for n in json.loads(job.get('train_numbers') or '[]') if str(n).strip()}
        except_numbers = {str(n).strip().upper() for n in json.loads(job.get('except_train_numbers') or '[]') if str(n).strip()}
    except Exception as exc:
        db.job_catalog_set(job_id, generation, 'failed', [], '任务查询条件格式异常: %s' % exc)
        return
    train_meta = {
        (str(item.get('date') or ''), str(item.get('train_number') or '').upper()): item
        for item in train_items if isinstance(item, dict)
    }

    start = _time_minutes(job.get('period_from'), 0)
    end = _time_minutes(job.get('period_to'), 24 * 60)
    mode = str(job.get('station_mode') or 'expand')
    rows_by_key = {}
    errors = []

    for pair in stations:
        left = str(pair.get('left') or '').strip()
        arrive = str(pair.get('arrive') or '').strip()
        if not left or not arrive:
            continue
        for date in dates:
            if not _current(job_id, generation):
                return
            result, rows = _query_ticket_rows(app, tickets, left, arrive, date, mode)
            if result.get('code') != 0:
                errors.append(str(result.get('msg') or '车票查询失败'))
                continue
            for row in rows:
                number = str(row.get('n') or '').strip().upper()
                if not number:
                    continue
                if train_numbers and number not in train_numbers:
                    continue
                if number in except_numbers:
                    continue
                if not _within_period(row.get('d'), start, end):
                    continue
                key = (str(date), number)
                if key in rows_by_key:
                    continue
                meta = train_meta.get(key, {})
                rows_by_key[key] = {
                    'train_number': number,
                    'date': str(date),
                    'train_no': str(row.get('no') or meta.get('train_no') or ''),
                    'from_station': str(row.get('f') or ''),
                    'to_station': str(row.get('to') or ''),
                    'departure': str(row.get('d') or ''),
                    'arrival': str(row.get('a') or ''),
                    'duration': row.get('m'),
                    'start_date': str(row.get('start_date') or meta.get('start_date') or date),
                    'start_station': str(row.get('start_station') or row.get('f') or ''),
                    'end_station': str(row.get('end_station') or row.get('to') or ''),
                    'stops_data': None,
                    'stops_error': '',
                }

    items = list(rows_by_key.values())
    items.sort(key=lambda x: (x['date'], x['departure'], x['train_number']))
    failures = 0
    for item in items:
        if not _current(job_id, generation):
            return
        train_no = item.get('train_no')
        if not train_no:
            item['stops_error'] = '查询结果缺少 12306 内部车次号'
            failures += 1
            continue
        path = '/api/tickets/stops?' + urlencode({
            'train_no': train_no,
            'date': item.get('start_date') or item['date'],
        })
        result = _invoke_route(app, tickets_stops, path)
        if result.get('code') == 0:
            item['stops_data'] = result.get('data') or None
        else:
            item['stops_error'] = str(result.get('msg') or '经停站获取失败')
            failures += 1

    if not _current(job_id, generation):
        return
    state = ('partial' if failures or errors else ('empty' if not items else 'ready'))
    messages = []
    if not items:
        messages.append('条件筛选未找到有效车次')
    if errors:
        messages.append('%d 组区间/日期查询未完整返回' % len(errors))
    if failures:
        messages.append('%d 个车次未取得经停站' % failures)
    message = '；'.join(messages)
    db.job_catalog_set(job_id, generation, state, items, message)
    if not items and _current(job_id, generation):
        warning = messages[0]
        prefix = '查询车次为空：'
        event_message = warning[len(prefix):] if warning.startswith(prefix) else warning
        db.job_event_add(job_id, 'catalog_empty', event_message)
        try:
            from py12306.log.common_log import CommonLog
            CommonLog.add_quick_log(
                '[%s] 警告：%s' % (job.get('job_name') or job_id, warning)).flush()
        except Exception:
            pass
