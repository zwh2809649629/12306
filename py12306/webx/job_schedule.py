# -*- coding: utf-8 -*-
"""WebX one-shot task start scheduler (China Standard Time, second precision)."""
import re
import threading
import time
from datetime import datetime, timedelta, timezone

from py12306.webx.db import DataStore

_CHINA_TZ = timezone(timedelta(hours=8), name='China Standard Time')
_LOCK = threading.RLock()
_WAKE = threading.Event()
_QUERY_WAKE = threading.Event()
_PENDING = {}
_CLAIMS = {}
_WORKERS = {}
_WORKER_CONTEXT = threading.local()
_STARTED = False


def normalize_start_at(value):
    """Return canonical YYYY-MM-DD HH:MM:SS; legacy minute values become :00."""
    value = str(value or '').strip().replace('T', ' ')
    if not value:
        return ''
    if re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}', value):
        fmt = '%Y-%m-%d %H:%M'
    elif re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}', value):
        fmt = '%Y-%m-%d %H:%M:%S'
    else:
        raise ValueError('开始时间格式应为 YYYY-MM-DD HH:MM:SS')
    try:
        parsed = datetime.strptime(value, fmt)
    except ValueError:
        raise ValueError('开始时间不是有效的日期时间')
    return parsed.strftime('%Y-%m-%d %H:%M:%S')


def start_at_datetime(value):
    value = normalize_start_at(value)
    if not value:
        return None
    return datetime.strptime(value, '%Y-%m-%d %H:%M:%S').replace(tzinfo=_CHINA_TZ)


def is_future_start(value, now=None):
    target = start_at_datetime(value)
    if target is None:
        return False
    return target > (now or datetime.now(_CHINA_TZ))


def notify_schedule_changed():
    """Wake the scheduler and the query dispatcher after any task/config change."""
    _WAKE.set()
    _QUERY_WAKE.set()


def wait_query_wake(timeout=1.0):
    _QUERY_WAKE.wait(max(0.0, float(timeout)))
    _QUERY_WAKE.clear()


def is_engine_job_claimed(engine_id):
    with _LOCK:
        return str(engine_id or '') in _CLAIMS


def current_worker_engine_id():
    return str(getattr(_WORKER_CONTEXT, 'engine_id', '') or '')


def _engine_id(job):
    from py12306.helpers.func import md5
    from py12306.webx.sync import ConfigSync
    return md5(ConfigSync.job_info_dict(job))


def _engine_jobs():
    try:
        from py12306.query.query import Query
        query = Query.__dict__.get('__it__')
        return {str(getattr(job, 'id', '') or ''): bool(getattr(job, 'is_alive', False))
                for job in (getattr(query, 'jobs', None) or [])} if query else {}
    except Exception:
        return {}


def _candidate_rows():
    db = DataStore()
    successful = {str(row.get('job_id') or '') for row in
                  db.query("SELECT DISTINCT job_id FROM order_log WHERE status='success'")}
    out = {}
    for job in db.job_list():
        job_id = str(job.get('job_id') or '')
        if not job_id or not job.get('is_active') or job.get('finished_at') or job_id in successful:
            continue
        try:
            start_at = normalize_start_at(job.get('start_at'))
            target = start_at_datetime(start_at)
            if not target:
                continue
            out[job_id] = {'job': job, 'start_at': start_at, 'target': target,
                           'engine_id': _engine_id(job)}
        except Exception:
            continue
    return out


def _refresh_pending():
    candidates = _candidate_rows()
    engine_jobs = _engine_jobs()
    now = datetime.now(_CHINA_TZ)
    with _LOCK:
        for job_id, old in list(_PENDING.items()):
            current = candidates.get(job_id)
            if not current or current['start_at'] != old['start_at']:
                _PENDING.pop(job_id, None)
        for job_id, item in candidates.items():
            # New future schedules are armed. An overdue schedule is recovered only
            # when startup did not already load its Job into the engine.
            overdue_unloaded = item['target'] <= now and not engine_jobs.get(item['engine_id'], False)
            if item['target'] > now or overdue_unloaded:
                current = _PENDING.get(job_id)
                if current and current['start_at'] == item['start_at']:
                    current['engine_id'] = item['engine_id']
                    current['target'] = item['target']
                else:
                    _PENDING[job_id] = {
                        'start_at': item['start_at'],
                        'target': item['target'],
                        'engine_id': item['engine_id'],
                        'retry_at': 0.0,
                    }


def _dispatch_due(entries):
    from py12306.config import Config
    from py12306.query.query import Query
    from py12306.webx.sync import ConfigSync

    # Query.__init__ may still be blocked on 12306 API discovery during startup.
    # Keep the due entry pending and retry once the initialized singleton exists.
    query = Query.__dict__.get('__it__')
    if query is None:
        return set()
    candidates = _candidate_rows()
    now = datetime.now(_CHINA_TZ)
    claimed = []
    already_claimed = set()
    with _LOCK:
        for job_id, scheduled_at in entries:
            item = candidates.get(job_id)
            if not item or item['start_at'] != scheduled_at or item['target'] > now:
                continue
            engine_id = item['engine_id']
            existing = _CLAIMS.get(engine_id)
            if existing:
                if (existing.get('job_id') == job_id and
                        existing.get('start_at') == scheduled_at):
                    already_claimed.add(job_id)
                continue
            token = object()
            _CLAIMS[engine_id] = {
                'job_id': job_id, 'start_at': scheduled_at, 'token': token,
            }
            claimed.append((job_id, scheduled_at, engine_id, token))

    started = set(already_claimed)
    if not claimed:
        return started

    try:
        # first=True updates Config without invoking the normal broad preflight path.
        # The due Job is refreshed below and preflighted by its own worker thread.
        ConfigSync.publish_jobs(first=True)
        query.query_jobs = Config().QUERY_JOBS
        query.refresh_jobs()
        by_id = {str(getattr(job, 'id', '') or ''): job
                 for job in (getattr(query, 'jobs', None) or [])}
        for job_id, scheduled_at, engine_id, token in claimed:
            job = by_id.get(engine_id)
            if job is None or not getattr(job, 'is_alive', False):
                _release_claim(engine_id, token)
                continue
            thread = threading.Thread(
                target=_run_scheduled_job,
                args=(job, job_id, engine_id, scheduled_at, token),
                name='webx-scheduled-' + job_id,
                daemon=True)
            with _LOCK:
                entry = _CLAIMS.get(engine_id)
                if entry and entry.get('token') is token:
                    _WORKERS[engine_id] = thread
            try:
                thread._webx_log_thread = True
                thread.start()
                started.add(job_id)
                try:
                    from py12306.log.common_log import CommonLog
                    CommonLog.add_quick_log('[%s] 定时启动触发（北京时间 %s）' %
                                            (job.get('job_name') or job_id, scheduled_at)).flush()
                except Exception:
                    pass
            except Exception:
                _release_claim(engine_id, token)
    except Exception as exc:
        for _, _, engine_id, token in claimed:
            _release_claim(engine_id, token)
        try:
            from py12306.log.common_log import CommonLog
            CommonLog.add_quick_log('webx 定时任务派发失败，将重试: %s' % exc).flush()
        except Exception:
            pass
    finally:
        _QUERY_WAKE.set()
    return started


def _worker_schedule_matches(job, job_id, scheduled_at):
    db = DataStore()
    row = db.job_get(job_id)
    if not row or not row.get('is_active') or row.get('finished_at'):
        return False
    try:
        current = normalize_start_at(row.get('start_at'))
    except Exception:
        return False
    # Clearing the timer after it has fired means “continue immediately”; do not
    # strand the already-running scheduled worker waiting for a query-loop restart.
    return current == scheduled_at or (not current and getattr(job, 'is_alive', False))


def _isolate_query_session(job):
    """Give a scheduled worker its own HTTP session instead of racing the shared Query session."""
    try:
        from copy import copy
        from py12306.helpers.request import Request
        original_query = job.query
        original_session = original_query.session
        worker_query = copy(original_query)
        worker_session = Request()
        worker_session.headers.update(original_session.headers)
        worker_session.cookies.update(original_session.cookies)
        worker_query.session = worker_session
        job.query = worker_query
        return worker_session
    except Exception:
        return None


def _job_account_ready(job):
    """Whether the task account currently has a live, passenger-ready object."""
    try:
        from py12306.user.user import User
        instance = User.__dict__.get('__it__')
        key = str(getattr(job, 'account_key', '') or '')
        users = getattr(instance, 'users', None) or []
        return any(str(getattr(user, 'key', '')) == key and
                   getattr(user, 'is_alive', True) and getattr(user, 'is_ready', False) for user in users)
    except Exception:
        return False


def _run_scheduled_job(job, job_id, engine_id, scheduled_at, token):
    _WORKER_CONTEXT.engine_id = engine_id
    worker_session = _isolate_query_session(job)
    try:
        while (getattr(job, 'is_alive', False) and
               _worker_schedule_matches(job, job_id, scheduled_at) and
               not getattr(job, 'passengers', None)):
            if not _job_account_ready(job):
                time.sleep(3.0)
                continue
            try:
                # Passenger readiness may wait for account recovery, but it cannot
                # block the scheduler or the ordinary query loop.
                job.check_passengers()
            except Exception as exc:
                _log_worker_error(job, job_id, exc)
                if getattr(job, 'is_alive', False):
                    time.sleep(1.0)
        while (getattr(job, 'is_alive', False) and
               _worker_schedule_matches(job, job_id, scheduled_at)):
            try:
                job.run()
            except Exception as exc:
                _log_worker_error(job, job_id, exc)
                if getattr(job, 'is_alive', False) and _worker_schedule_matches(job, job_id, scheduled_at):
                    time.sleep(1.0)
    finally:
        try:
            if worker_session:
                worker_session.close()
        except Exception:
            pass
        _WORKER_CONTEXT.engine_id = ''
        _release_claim(engine_id, token)
        _QUERY_WAKE.set()


def _log_worker_error(job, job_id, exc):
    try:
        from py12306.log.common_log import CommonLog
        CommonLog.add_quick_log('[%s] 定时任务执行异常: %s' %
                                (getattr(job, 'job_name', job_id), exc)).flush()
    except Exception:
        pass


def _release_claim(engine_id, token):
    with _LOCK:
        current = _CLAIMS.get(str(engine_id or ''))
        if current and current.get('token') is token:
            _CLAIMS.pop(str(engine_id), None)
            _WORKERS.pop(str(engine_id), None)


def _scheduler_loop():
    while True:
        try:
            _refresh_pending()
            now = datetime.now(_CHINA_TZ)
            mono = time.monotonic()
            with _LOCK:
                due = [(job_id, item['start_at'])
                       for job_id, item in _PENDING.items()
                       if item['target'] <= now and item['retry_at'] <= mono]
                if not due:
                    waits = [max(0.0, (item['target'] - now).total_seconds())
                             for item in _PENDING.values() if item['target'] > now]
                    waits += [max(0.0, item['retry_at'] - mono)
                              for item in _PENDING.values() if item['retry_at'] > mono]
                    timeout = min(waits + [30.0])
            if due:
                started = _dispatch_due(due)
                with _LOCK:
                    for job_id, scheduled_at in due:
                        current = _PENDING.get(job_id)
                        if not current or current['start_at'] != scheduled_at:
                            continue
                        if job_id in started:
                            _PENDING.pop(job_id, None)
                        else:
                            current['retry_at'] = time.monotonic() + 1.0
                continue
            woke = _WAKE.wait(timeout)
            if woke:
                _WAKE.clear()
        except Exception:
            # A scheduler error must never take down the query engine.
            _WAKE.wait(1.0)
            _WAKE.clear()


def start_scheduler():
    global _STARTED
    try:
        from py12306.app import Const
        if Const.IS_TEST:
            return False
    except Exception:
        pass
    with _LOCK:
        if _STARTED:
            _WAKE.set()
            return False
        _STARTED = True
        thread = threading.Thread(target=_scheduler_loop, name='webx-task-scheduler', daemon=True)
        thread.start()
    _WAKE.set()
    return True
