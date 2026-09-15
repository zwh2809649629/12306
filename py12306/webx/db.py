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
                    seats TEXT,                 -- JSON Array[str] 有序
                    train_numbers TEXT,         -- JSON Array[str]
                    except_train_numbers TEXT,  -- JSON Array[str]
                    members TEXT,               -- JSON Array[str/int]
                    allow_less_member INTEGER DEFAULT 0,
                    period_from TEXT DEFAULT '00:00',
                    period_to TEXT DEFAULT '24:00',
                    interval_min REAL,
                    interval_max REAL,
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
            ''')
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
        cols = ['job_id', 'job_name', 'account_key', 'left_dates', 'stations', 'seats',
                'train_numbers', 'except_train_numbers', 'members', 'allow_less_member',
                'period_from', 'period_to', 'interval_min', 'interval_max', 'is_active',
                'created_at', 'updated_at']
        vals = []
        for c in cols:
            v = data.get(c)
            vals.append(json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v)
        sql = 'INSERT INTO job(%s) VALUES(%s)' % (','.join(cols), ','.join('?' * len(cols)))
        self.execute(sql, vals)
        return data['job_id']

    def job_update(self, job_id, data):
        allowed = ['job_name', 'account_key', 'left_dates', 'stations', 'seats',
                   'train_numbers', 'except_train_numbers', 'members', 'allow_less_member',
                   'period_from', 'period_to', 'interval_min', 'interval_max', 'is_active',
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
        self.execute('DELETE FROM job WHERE job_id=?', (job_id,))

    def job_toggle_active(self, job_id, active):
        self.execute('UPDATE job SET is_active=?, updated_at=? WHERE job_id=?',
                     (1 if active else 0, _now(), job_id))

    def job_record_hit(self, job_id, train_number, seat, num, left_date):
        self.execute('UPDATE job SET last_hit_at=?, hit_count=hit_count+1 WHERE job_id=?',
                     (_now(), job_id))

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
