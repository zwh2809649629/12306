# -*- coding: utf-8 -*-
import json
import os
import sqlite3
import threading
import time
import uuid

from py12306.config import Config
from py12306.helpers.func import singleton


def _now():
    return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())


def _today():
    return time.strftime('%Y-%m-%d', time.localtime())


@singleton
class DataStore:
    """
    webx 唯一数据源：runtime/webx.db（SQLite，stdlib）
    - WAL 模式 + check_same_thread=False + 全局 Lock
    - 表结构幂等（CREATE TABLE IF NOT EXISTS）
    """
    DB_FILE = None
    conn = None
    lock = None
    initialized = False

    # ---------------- 基础 ----------------
    def __init__(self):
        if self.initialized: return
        self.DB_FILE = Config().RUNTIME_DIR + 'webx.db'
        if not os.path.exists(Config().RUNTIME_DIR):
            os.makedirs(Config().RUNTIME_DIR, exist_ok=True)
        self.lock = threading.Lock()
        self.conn = sqlite3.connect(self.DB_FILE, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._init_schema()
        DataStore.initialized = True

    def _init_schema(self):
        with self.lock:
            cur = self.conn.cursor()
            cur.execute('PRAGMA journal_mode=WAL;')
            cur.executescript('''
                CREATE TABLE IF NOT EXISTS job (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL UNIQUE,
                    job_name TEXT,
                    account_key TEXT,
                    left_dates TEXT,            -- JSON Array[str]
                    stations TEXT,              -- JSON [{left,arrive}]
                    seats TEXT,                 -- JSON Array[str] 有序（引擎消费的是这个，已是展平的）
                    seat_tiers TEXT,            -- JSON Array[Array[str]] 优先级结构；**仅用于展示**
                                                -- （引擎只接受一维 seats，这里存二维仅为把分级配色带到详情页）
                    train_numbers TEXT,         -- JSON Array[str]
                    except_train_numbers TEXT,  -- JSON Array[str]
                    members TEXT,               -- JSON Array[str/int]
                    allow_less_member INTEGER DEFAULT 0,
                    period_from TEXT DEFAULT '00:00',
                    period_to TEXT DEFAULT '24:00',
                    interval_min REAL,
                    interval_max REAL,
                    start_at TEXT,              -- 北京时间定时启动 'YYYY-MM-DD HH:MM:SS'（旧分钟格式兼容）
                    query_mode TEXT DEFAULT 'range', -- train / range，仅用于管理台编辑回显
                    train_items TEXT,           -- JSON [{train_number,date,start_date,train_no}]
                    is_active INTEGER DEFAULT 1,
                    created_at TEXT,
                    updated_at TEXT,
                    last_hit_at TEXT,
                    hit_count INTEGER DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS account (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    key TEXT NOT NULL UNIQUE,
                    user_name TEXT,
                    password TEXT,
                    type TEXT DEFAULT 'qr',     -- qr / pwd
                    login_ok INTEGER DEFAULT 0, -- 扫码/密码登录成功标记（qr 成功前不 publish）
                    active INTEGER DEFAULT 1,
                    created_at TEXT
                );
                CREATE TABLE IF NOT EXISTS user_login (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    pass_hash TEXT,
                    salt TEXT,
                    created_at TEXT
                );
                CREATE TABLE IF NOT EXISTS order_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT,
                    account_key TEXT,
                    train_date TEXT,
                    train_number TEXT,
                    passengers TEXT,            -- JSON
                    seats TEXT,                 -- JSON
                    status TEXT,
                    message TEXT,
                    created_at TEXT
                );
                CREATE TABLE IF NOT EXISTS hit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT,
                    job_name TEXT,
                    train_number TEXT,
                    seat TEXT,
                    num TEXT,
                    left_date TEXT,
                    at TEXT
                );
                CREATE TABLE IF NOT EXISTS daily_query (
                    day TEXT PRIMARY KEY,
                    count INTEGER DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS kv (
                    key TEXT PRIMARY KEY,
                    value TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_hit_job ON hit_log(job_id);
                CREATE INDEX IF NOT EXISTS idx_order_job ON order_log(job_id);
                -- 下单各阶段事件（命中/受理/initDc/排队/确认/成单/失败），
                -- 用于详情页的阶段时序与「命中→下单」耗时统计。
                -- order_log 是就地更新（promote），拿不到各阶段时间，所以单独记一份。
                CREATE TABLE IF NOT EXISTS job_event (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT,
                    kind TEXT,
                    message TEXT,
                    at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_evt_job ON job_event(job_id);
                -- 任务范围内的车次及经停站快照；详情页仅读取，不直接请求 12306。
                CREATE TABLE IF NOT EXISTS job_train_catalog (
                    job_id TEXT PRIMARY KEY,
                    generation TEXT NOT NULL,
                    state TEXT NOT NULL,
                    payload TEXT,
                    train_count INTEGER DEFAULT 0,
                    message TEXT,
                    updated_at TEXT
                );
            ''')
            # 幂等迁移：早期库没有 start_at（CREATE TABLE IF NOT EXISTS 不会补列）。
            # 必须直接用 cur 查询：self.query() 会再取一次 self.lock，
            # 而 threading.Lock 不可重入 → 在持锁块内调用它必然死锁（启动就卡住）
            cols = {r['name'] for r in cur.execute('PRAGMA table_info(job)').fetchall()}
            catalog_cols = {r['name'] for r in cur.execute('PRAGMA table_info(job_train_catalog)').fetchall()}
            if 'train_count' not in catalog_cols:
                cur.execute('ALTER TABLE job_train_catalog ADD COLUMN train_count INTEGER DEFAULT 0')
            # Existing snapshots may have received the column with its default 0
            # during an earlier startup. Repair only rows whose payload proves non-empty.
            for row in cur.execute(
                    'SELECT job_id, payload FROM job_train_catalog WHERE train_count=0').fetchall():
                try:
                    items = json.loads(row['payload'] or '[]')
                    count = len(items) if isinstance(items, list) else 0
                except Exception:
                    count = 0
                if count:
                    cur.execute('UPDATE job_train_catalog SET train_count=? WHERE job_id=?',
                                (count, row['job_id']))
            if 'start_at' not in cols:
                cur.execute('ALTER TABLE job ADD COLUMN start_at TEXT')
            if 'seat_tiers' not in cols:
                cur.execute('ALTER TABLE job ADD COLUMN seat_tiers TEXT')
            # 引擎会主动 destroy 任务（下单成功 / 订单状态待核实 / 乘客校验失败）。
            # 不落库的话重启或任务被摘出内存后，页面只能显示「待启动」，
            # 与实际的「已完成 / 已结束」不符。
            if 'finished_at' not in cols:
                cur.execute('ALTER TABLE job ADD COLUMN finished_at TEXT')
            if 'finish_reason' not in cols:
                cur.execute('ALTER TABLE job ADD COLUMN finish_reason TEXT')
            # 按任务统计的查询次数（卡片要分别展示「已查询」与「命中」）
            if 'query_count' not in cols:
                cur.execute('ALTER TABLE job ADD COLUMN query_count INTEGER DEFAULT 0')
            # 站点匹配方式：expand=同城站扩展（城市名匹配该城市全部车站）/ exact=仅指定站名。
            # 12306 的查询结果里本来就会混入同城其它站（见 AGENTS.md §5.25），
            # 这一列决定「广州」到底算 1 个站还是 10 个站。
            if 'station_mode' not in cols:
                cur.execute("ALTER TABLE job ADD COLUMN station_mode TEXT DEFAULT 'expand'")
            if 'query_mode' not in cols:
                cur.execute("ALTER TABLE job ADD COLUMN query_mode TEXT DEFAULT 'range'")
            if 'train_items' not in cols:
                cur.execute("ALTER TABLE job ADD COLUMN train_items TEXT")
            # 迁移前没有模式字段：有车次白名单的历史任务按车次查询回显，
            # 无白名单的历史任务保持区间查询。用 kv 标记只执行一次，
            # 避免以后「区间查询 + 车次筛选」的任务被再次改成车次模式。
            migrated = cur.execute("SELECT value FROM kv WHERE key='job_query_mode_migrated'").fetchone()
            if not migrated:
                cur.execute("UPDATE job SET query_mode='train' "
                            "WHERE query_mode='range' AND train_numbers IS NOT NULL "
                            "AND train_numbers NOT IN ('', '[]')")
                cur.execute("INSERT OR REPLACE INTO kv(key, value) VALUES('job_query_mode_migrated', '1')")
            self.conn.commit()

    # ---------------- 通用 ----------------
    def query(self, sql, args=()):
        with self.lock:
            cur = self.conn.execute(sql, args)
            rows = [dict(r) for r in cur.fetchall()]
            return rows

    def execute(self, sql, args=()):
        with self.lock:
            cur = self.conn.execute(sql, args)
            self.conn.commit()
            return cur.lastrowid

    # ---------------- kv ----------------
    def kv_get(self, key, default=None):
        rows = self.query('SELECT value FROM kv WHERE key=?', (key,))
        return rows[0]['value'] if rows else default

    def kv_set(self, key, value):
        self.execute('INSERT INTO kv(key, value) VALUES(?, ?) '
                     'ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, str(value)))

    # ---------------- job ----------------
    def job_list(self):
        return self.query('SELECT * FROM job ORDER BY id')

    def job_get(self, job_id):
        rows = self.query('SELECT * FROM job WHERE job_id=?', (job_id,))
        return rows[0] if rows else None

    def job_create(self, data):
        data = dict(data)
        data.setdefault('job_id', uuid.uuid4().hex[:16])
        data['created_at'] = _now()
        data['updated_at'] = _now()
        cols = ['job_id', 'job_name', 'account_key', 'left_dates', 'stations', 'seats', 'seat_tiers',
                'train_numbers', 'except_train_numbers', 'members', 'allow_less_member',
                'period_from', 'period_to', 'interval_min', 'interval_max', 'start_at', 'query_mode', 'station_mode', 'train_items',
                'is_active', 'created_at', 'updated_at']
        vals = []
        for c in cols:
            v = data.get(c)
            vals.append(json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v)
        sql = 'INSERT INTO job(%s) VALUES(%s)' % (','.join(cols), ','.join('?' * len(cols)))
        self.execute(sql, vals)
        return data['job_id']

    def job_update(self, job_id, data):
        allowed = ['job_name', 'account_key', 'left_dates', 'stations', 'seats', 'seat_tiers',
                   'train_numbers', 'except_train_numbers', 'members', 'allow_less_member',
                   'period_from', 'period_to', 'interval_min', 'interval_max', 'start_at', 'query_mode', 'station_mode', 'train_items', 'is_active',
                   'finished_at', 'finish_reason',
                   'updated_at']
        sets, vals = [], []
        for k in allowed:
            if k in data:
                v = data[k]
                sets.append(k + '=?')
                vals.append(json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v)
        if not sets: return
        data['updated_at'] = _now()
        sets.append('updated_at=?')
        vals.append(_now())
        vals.append(job_id)
        self.execute('UPDATE job SET %s WHERE job_id=?' % ','.join(sets), vals)

    def job_delete(self, job_id):
        with self.lock:
            self.conn.execute('DELETE FROM job_train_catalog WHERE job_id=?', (job_id,))
            self.conn.execute('DELETE FROM job WHERE job_id=?', (job_id,))
            self.conn.commit()

    def job_catalog_begin(self, job_id, generation):
        self.execute(
            'INSERT INTO job_train_catalog(job_id, generation, state, payload, train_count, message, updated_at) '
            'VALUES(?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET '
            'generation=excluded.generation, state=excluded.state, payload=excluded.payload, '
            'train_count=excluded.train_count, message=excluded.message, updated_at=excluded.updated_at',
            (job_id, generation, 'building', '[]', 0, '', _now()))

    def job_catalog_get(self, job_id):
        rows = self.query('SELECT * FROM job_train_catalog WHERE job_id=?', (job_id,))
        return rows[0] if rows else None

    def job_catalog_set(self, job_id, generation, state, payload, message=''):
        self.execute(
            'UPDATE job_train_catalog SET state=?, payload=?, train_count=?, message=?, updated_at=? '
            'WHERE job_id=? AND generation=?',
            (state, json.dumps(payload or [], ensure_ascii=False), len(payload or []), str(message or ''),
             _now(), job_id, generation))

    def job_catalog_update_stop(self, job_id, train_number, date,
                                stops_data=None, stops_error='', item_updates=None):
        """Update one cached train's stop data without rebuilding the catalog."""
        with self.lock:
            row = self.conn.execute(
                'SELECT payload FROM job_train_catalog WHERE job_id=?', (job_id,)
            ).fetchone()
            if not row:
                return None
            try:
                items = json.loads(row['payload'] or '[]')
            except Exception:
                items = []
            if not isinstance(items, list):
                return None
            target = None
            for item in items:
                if (str(item.get('train_number') or '').upper() == str(train_number).upper()
                        and str(item.get('date') or '') == str(date)):
                    target = item
                    break
            if target is None:
                return None
            for key, value in (item_updates or {}).items():
                if key in ('train_no', 'start_date', 'start_station', 'end_station'):
                    target[key] = value
            if stops_data is not None:
                target['stops_data'] = stops_data
                target['stops_error'] = ''
            else:
                target['stops_error'] = str(stops_error or '经停站获取失败')
            self.conn.execute(
                'UPDATE job_train_catalog SET payload=?, train_count=?, updated_at=? '
                'WHERE job_id=?',
                (json.dumps(items, ensure_ascii=False), len(items), _now(), job_id))
            self.conn.commit()
            return dict(target)

    def job_toggle_active(self, job_id, active):
        # 重新启用时清掉「已结束」标记，否则任务会一直显示为已完成/已结束
        if active:
            self.execute('UPDATE job SET is_active=1, finished_at=NULL, finish_reason=NULL, '
                         'updated_at=? WHERE job_id=?', (_now(), job_id))
        else:
            self.execute('UPDATE job SET is_active=0, updated_at=? WHERE job_id=?', (_now(), job_id))

    def job_mark_finished(self, job_id, reason=''):
        """引擎 destroy 任务时落库（job_id 为 None 时按无关联任务忽略）"""
        if not job_id:
            return
        self.execute('UPDATE job SET finished_at=?, finish_reason=?, updated_at=? WHERE job_id=?',
                     (_now(), str(reason or ''), _now(), job_id))

    def job_clear_finished(self, job_id):
        self.execute('UPDATE job SET finished_at=NULL, finish_reason=NULL WHERE job_id=?', (job_id,))

    def job_record_hit(self, job_id, train_number, seat, num, left_date):
        self.execute('UPDATE job SET last_hit_at=?, hit_count=hit_count+1 WHERE job_id=?',
                     (_now(), job_id))

    def job_record_query(self, job_id):
        """每发出一条余票查询请求计数 +1（详情/卡片展示「已查询 N 次」）"""
        if not job_id:
            return
        self.execute('UPDATE job SET query_count=COALESCE(query_count, 0) + 1 WHERE job_id=?',
                     (job_id,))

    # ---------------- job_event（下单阶段时序）----------------
    def job_event_add(self, job_id, kind, message=''):
        """记一条下单阶段事件；job_id 为空（任务未入库）时直接忽略"""
        if not job_id:
            return
        self.execute('INSERT INTO job_event(job_id, kind, message, at) VALUES(?,?,?,?)',
                     (job_id, str(kind or ''), str(message or ''), _now()))

    def job_event_list(self, job_id, limit=200):
        return self.query('SELECT kind, message, at FROM job_event WHERE job_id IS ? '
                          'ORDER BY id DESC LIMIT ?', (job_id, limit))

    def job_id_by_name(self, job_name):
        """引擎侧只有 job_name，落库时反查 db job_id（查不到返回 None，允许无关联）"""
        if not job_name:
            return None
        rows = self.query('SELECT job_id FROM job WHERE job_name=? ORDER BY id DESC LIMIT 1', (job_name,))
        return rows[0]['job_id'] if rows else None

    def job_list_active_by_prefix(self, prefix):
        return self.query('SELECT * FROM job WHERE is_active=1 AND job_name LIKE ?',
                          (str(prefix) + '%',))

    # ---------------- account ----------------
    def account_list(self):
        return self.query('SELECT * FROM account ORDER BY id')

    def account_get(self, key):
        rows = self.query('SELECT * FROM account WHERE key=?', (key,))
        return rows[0] if rows else None

    def account_create(self, key, user_name, password='', acc_type='qr'):
        self.execute('INSERT INTO account(key, user_name, password, type, login_ok, active, created_at) '
                     'VALUES(?,?,?,?,?,1,?)', (key, user_name, password, acc_type, 0, _now()))
        return self.account_get(key)

    def account_update(self, key, data):
        allowed = ['user_name', 'password', 'type', 'login_ok', 'active']
        sets, vals = [], []
        for k in allowed:
            if k in data:
                sets.append(k + '=?')
                vals.append(data[k])
        if not sets: return
        vals.append(key)
        self.execute('UPDATE account SET %s WHERE key=?' % ','.join(sets), vals)

    def account_mark_login_ok(self, key):
        self.execute('UPDATE account SET login_ok=1 WHERE key=?', (key,))

    def account_delete(self, key):
        self.execute('DELETE FROM account WHERE key=?', (key,))

    # ---------------- user_login ----------------
    def login_user_list(self):
        return self.query('SELECT * FROM user_login')

    def login_user_get(self, username):
        rows = self.query('SELECT * FROM user_login WHERE username=?', (username,))
        return rows[0] if rows else None

    def login_user_create(self, username, salt, pass_hash):
        self.execute('INSERT INTO user_login(username, salt, pass_hash, created_at) VALUES(?,?,?,?)',
                     (username, salt, pass_hash, _now()))

    def login_user_set_password(self, username, salt, pass_hash):
        self.execute('UPDATE user_login SET salt=?, pass_hash=? WHERE username=?',
                     (salt, pass_hash, username))

    # ---------------- order_log ----------------
    def order_add(self, job_id, account_key, train_date, train_number, passengers, seats, status, message):
        self.execute('INSERT INTO order_log(job_id, account_key, train_date, train_number, '
                     'passengers, seats, status, message, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
                     (job_id, account_key, train_date, train_number,
                      json.dumps(passengers, ensure_ascii=False), json.dumps(seats, ensure_ascii=False),
                      status, message, _now()))

    def order_list(self, limit=100, job_id=None):
        if job_id:
            return self.query('SELECT * FROM order_log WHERE job_id=? ORDER BY id DESC LIMIT ?', (job_id, limit))
        return self.query('SELECT * FROM order_log ORDER BY id DESC LIMIT ?', (limit,))

    def order_list_with_job(self, limit=100, job_id=None):
        """下单记录 + 关联任务名（订单页/总览展示用）"""
        limit = max(1, min(int(limit or 100), 500))
        base = ('SELECT o.*, j.job_name FROM order_log o '
                'LEFT JOIN job j ON j.job_id = o.job_id ')
        if job_id:
            return self.query(base + 'WHERE o.job_id=? ORDER BY o.id DESC LIMIT ?', (job_id, limit))
        return self.query(base + 'ORDER BY o.id DESC LIMIT ?', (limit,))

    def order_get(self, order_id):
        rows = self.query('SELECT * FROM order_log WHERE id=?', (order_id,))
        return rows[0] if rows else None

    def order_update_status(self, order_id, status, message=None):
        if message is None:
            self.execute('UPDATE order_log SET status=? WHERE id=?', (status, order_id))
        else:
            self.execute('UPDATE order_log SET status=?, message=? WHERE id=?', (status, message, order_id))

    def order_promote(self, job_id, train_date, train_number, message):
        """把最近一条 submitted 记录升级为 success（避免同一单出现两条记录）；返回记录 id"""
        rows = self.query(
            "SELECT id FROM order_log WHERE job_id IS ? AND train_date=? AND train_number=? "
            "AND status='submitted' ORDER BY id DESC LIMIT 1", (job_id, train_date, train_number))
        if not rows:
            return None
        order_id = rows[0]['id']
        self.execute("UPDATE order_log SET status='success', message=? WHERE id=?", (message, order_id))
        return order_id

    def order_pending_count(self):
        return (self.query("SELECT COUNT(*) AS c FROM order_log WHERE status IN ('queued','submitted')")[0])['c']

    # ---------------- hit_log ----------------
    def hit_add(self, job_id, job_name, train_number, seat, num, left_date):
        self.execute('INSERT INTO hit_log(job_id, job_name, train_number, seat, num, left_date, at) '
                     'VALUES(?,?,?,?,?,?,?)', (job_id, job_name, train_number, seat, num, left_date, _now()))
        if job_id: self.job_record_hit(job_id, train_number, seat, num, left_date)

    def hit_list(self, job_id=None, limit=200):
        if job_id:
            return self.query('SELECT * FROM hit_log WHERE job_id=? ORDER BY id DESC LIMIT ?', (job_id, limit))
        return self.query('SELECT * FROM hit_log ORDER BY id DESC LIMIT ?', (limit,))

    def hit_count(self):
        return (self.query('SELECT COUNT(*) AS c FROM hit_log')[0])['c']

    # ---------------- daily_query ----------------
    def daily_incr(self, day, delta):
        if delta <= 0: return
        self.execute('INSERT INTO daily_query(day, count) VALUES(?, ?) '
                     'ON CONFLICT(day) DO UPDATE SET count=count+excluded.count', (day, delta))

    def daily_today(self):
        rows = self.query('SELECT count FROM daily_query WHERE day=?', (_today(),))
        return rows[0]['count'] if rows else 0

    def daily_series(self, days=7):
        """近 N 日 [{day, count}]（升序）"""
        out = []
        for i in range(days - 1, -1, -1):
            day = time.strftime('%Y-%m-%d', time.localtime(time.time() - i * 86400))
            rows = self.query('SELECT count FROM daily_query WHERE day=?', (day,))
            out.append({'day': day, 'count': rows[0]['count'] if rows else 0})
        return out
