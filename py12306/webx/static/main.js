/* py12306 购票助手管理台 — webx SPA (P1: 只读) */
(function () {
'use strict';

var $ = function (id) { return document.getElementById(id); };
var TOKEN_KEY = 'webx_token';
var USERNAME_KEY = 'webx_username';
var booted = false;
var SEATS_CN = ['商务座', '一等座', '二等座', '软卧', '硬卧', '硬座', '无座', '特等座'];

/* ---------- 基础工具 ---------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function token() { return localStorage.getItem(TOKEN_KEY) || ''; }
function api(path, options) {
  options = options || {};
  var headers = options.headers || {};
  if (token()) headers['Authorization'] = 'Bearer ' + token();
  if (options.body && typeof options.body !== 'string') headers['Content-Type'] = 'application/json';
  return fetch(path, { method: options.method || (options.body ? 'POST' : 'GET'), headers: headers, body: options.body || undefined })
    .then(function (r) {
      if (r.status === 401) { showLogin(); throw new Error('unauthorized'); }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || j.code !== 0) { var e = new Error(j.msg || ('HTTP ' + r.status)); e.noToast = path.indexOf('/api/tickets') === 0; throw e; }
        return j.data;
      });
    });
}
function toast(msg, type, ms) {
  var box = $('toast');
  var el = document.createElement('div');
  el.className = 't ' + (type || '');
  el.textContent = msg;
  box.appendChild(el);
  requestAnimationFrame(function () { el.classList.add('show'); });
  setTimeout(function () {
    el.classList.remove('show');
    setTimeout(function () { el.remove(); }, 300);
  }, ms || 2600);
}
function P2() { toast('该写接口将在下一批（P2）实现，当前为只读', '', 2800); }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function fmtDur(m) {
  if (m == null) return '—';
  var h = Math.floor(m / 60), mm = m % 60;
  return h ? h + ' 小时 ' + (mm ? mm + ' 分' : '') : mm + ' 分钟';
}
function shortDate(d) { return d.slice(5); }

/* ---------- 席别票价（与原型一致） ---------- */
function seatPrice(leg, k) {
  var high = leg.tn === '高铁' || leg.tn === '动车';
  var rates = high ? { business: 3.1, first: 1.65, second: .82 }
                   : { hardSleeper: .43, hardSeat: .21, noSeat: .21 };
  var minutes = leg.m;
  if (minutes == null) {
    var d = +leg.d.slice(0, 2) * 60 + +leg.d.slice(3, 5);
    var a = +leg.a.slice(0, 2) * 60 + +leg.a.slice(3, 5);
    minutes = a - d; if (minutes < 0) minutes += 1440;
  }
  var r = rates[k]; if (!r) return null;
  return Math.max(12, Math.round(minutes * r));
}
function seatCell(leg, k) {
  var v = leg.s ? leg.s[k] : undefined;
  var price = seatPrice(leg, k);
  var cls = 'seat', inner;
  if (v == null || v === '' || v === '无') inner = '<strong class="none">无</strong>';
  else if (v === '有') inner = '<strong>有</strong>';
  else if (v === '候补') inner = '<strong class="wait">候补</strong>';
  else inner = '<strong>' + esc(v) + '</strong>';
  if (price) inner += '<small class="seat-price">约 ¥' + price + '</small>';
  return '<td class="' + cls + '" data-seat="' + k + '">' + inner + '</td>';
}
function seatNum(leg, k) {
  var v = leg.s ? leg.s[k] : '';
  var num = parseInt(String(v || ''), 10);
  if (isNaN(num)) return v === '有' ? 1 : 0;
  return num;
}
function rowHtml(leg) {
  var i = MON.rows.indexOf(leg);
  var rowCls = 'ticket-row' + (leg.bookable ? ' hit' : '');
  return '<tr class="' + rowCls + '" data-i="' + i + '">' +
    '<td style="text-align:center"><input class="row-check" type="checkbox" data-i="' + i + '"' + (MON.sel[i] ? ' checked' : '') + '></td>' +
    '<td class="train"><b>' + esc(leg.n) + '</b><small>' + esc(leg.tn) + (leg.bookable ? ' · 可订' : '') + '</small></td>' +
    '<td class="station"><b>' + esc(leg.f) + '</b></td>' +
    '<td class="station"><b>' + esc(leg.to) + '</b></td>' +
    '<td class="time"><b>' + esc(leg.d) + '</b></td>' +
    '<td class="time"><b>' + esc(leg.a) + '</b></td>' +
    '<td class="duration">' + fmtDur(leg.m) + '</td>' +
    seatCell(leg, 'business') + seatCell(leg, 'first') + seatCell(leg, 'second') + seatCell(leg, 'hardSleeper') + seatCell(leg, 'hardSeat') + seatCell(leg, 'noSeat') +
    '<td class="actions"><button class="btn btn-outline" data-act="book">预定</button><button class="btn btn-ghost" data-act="prefill">预填任务</button></td></tr>';
}

/* ---------- 登录态 ---------- */
function showLogin() {
  localStorage.removeItem(TOKEN_KEY);
  $('login-screen').classList.remove('hidden');
  $('app').classList.add('hidden');
  stopAllPolling();
}
function showApp(username) {
  $('login-screen').classList.add('hidden');
  $('app').classList.remove('hidden');
  var av = (username || 'A').slice(0, 1).toUpperCase();
  $('sideUser').textContent = username;
  $('sideAv').textContent = av;
  $('topAv').textContent = av;
  if (!booted) { booted = true; bootApp(); }
  startPolling();
}
function doLogin() {
  var u = $('loginUser').value.trim(), p = $('loginPwd').value;
  $('loginErr').textContent = '';
  $('loginBtn').disabled = true;
  api('/api/auth/login', { body: JSON.stringify({ username: u, password: p }) })
    .then(function (d) {
      localStorage.setItem(TOKEN_KEY, d.token);
      localStorage.setItem(USERNAME_KEY, d.username);
      showApp(d.username);
    })
    .catch(function (e) { $('loginErr').textContent = e.message || '登录失败'; })
    .finally(function () { $('loginBtn').disabled = false; });
}

/* ---------- Boot ---------- */
function bootApp() {
  api('/api/boot').then(function (d) {
    APP.seats = d.seats || [];
    APP.server = d.server || {};
  }).catch(function () { });
  loadDashboard(); loadCluster(); loadDates(); loadAccountsForNew();
  setInterval(function () {
    var t = new Date();
    $('topTime').textContent = t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate()) + ' ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds());
  }, 1000);
}
function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function loadCluster() {
  api('/api/cluster').then(function (d) {
    if (!d.enabled) {
      $('clusterPill').textContent = '集群 未开启';
      return;
    }
    $('clusterPill').textContent = '集群 ' + (d.nodes.length || 0) + ' 节点';
    var isMaster = /master/i.test(d.node_name || '');
    $('nodeState').textContent = isMaster ? 'Master' : '运行中';
    $('nodeName').textContent = d.node_name || '—';
  }).catch(function () { });
}

/* ---------- 轮询管理 ---------- */
var pollTimers = {};
function stopAllPolling() { Object.keys(pollTimers).forEach(function (k) { clearInterval(pollTimers[k]); }); pollTimers = {}; }
function startPolling() {
  stopAllPolling();
  if (currentView() === 'dashboard') pollTimers.dash = setInterval(loadDashboard, 3000);
  if (currentView() === 'logs' && !logPaused) pollTimers.log = setInterval(loadLogs, 6000);
}

/* ---------- 视图路由 ---------- */
var TITLES = { dashboard: '总览', jobs: '抢票任务', 'new': '新建抢票任务', detail: '任务详情', monitor: '车票查询', order: '确认订单', accounts: '12306 账号', logs: '运行日志', settings: '系统设置' };
function currentView() {
  var v = document.querySelector('.view.is-active');
  return v ? v.id.replace('view-', '') : 'dashboard';
}
function go(view, ctx) {
  document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('is-active'); });
  document.querySelectorAll('.nav a').forEach(function (a) { a.classList.remove('on'); });
  var el = $('view-' + view);
  if (!el) return;
  el.classList.add('is-active');
  var nav = document.querySelector('.nav a[data-view="' + (view === 'detail' ? 'jobs' : view) + '"]');
  if (nav) nav.classList.add('on');
  $('viewTitle').textContent = TITLES[view] || '';
  stopAllPolling(); startPolling();
  if (view === 'dashboard') loadDashboard();
  if (view === 'jobs') loadJobs();
  if (view === 'new') refreshNewView();
  if (view === 'detail' && ctx && ctx.job_id) loadDetail(ctx.job_id);
  if (view === 'monitor') {
    MON.batch = false;
    $('mBatchToggle').classList.remove('is-active');
    $('mBatchToggle').setAttribute('aria-pressed', 'false');
    if (ctx && ctx.pick) { refreshMonitorView(); enterPickMode(); }
    else { exitPickMode(); refreshMonitorView(); }
  }
  if (view === 'order') renderOrderView();
  if (view === 'accounts') loadAccounts();
  if (view === 'logs') loadLogs();
  if (view === 'settings') loadSettings();
}

/* ---------- 1. 仪表盘 ---------- */
var ICONS = {
  jobs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v14H4zM8 3v4M16 3v4M4 10h16"/></svg>',
  query: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
  hit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
  acc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c.8-3.3 3.5-5 8-5s7.2 1.7 8 5"/></svg>'
};
function loadDashboard() {
  api('/api/dashboard').then(function (d) {
    var s = d.stats;
    $('dashStats').innerHTML =
      '<div class="stat"><div class="ic red">' + ICONS.jobs + '</div><div><div class="v">' + s.jobs_total + '</div><div class="k">抢票任务</div><div class="t" style="color:var(--ok)">' + s.jobs_running + ' 个运行中</div></div></div>' +
      '<div class="stat"><div class="ic info">' + ICONS.query + '</div><div><div class="v">' + s.query_today + '</div><div class="k">今日查询次数</div><div class="t" style="color:var(--faint)">累计 ' + s.query_total + '</div></div></div>' +
      '<div class="stat"><div class="ic warn">' + ICONS.hit + '</div><div><div class="v">' + s.hit_total + '</div><div class="k">累计余票命中</div><div class="t" style="color:var(--faint)">详见任务详情</div></div></div>' +
      '<div class="stat"><div class="ic ok">' + ICONS.acc + '</div><div><div class="v">' + s.accounts_total + '</div><div class="k">12306 账号</div><div class="t" style="color:var(--ok)">' + s.accounts_online + ' 个在线</div></div></div>';

    // 任务表
    var stTag = { running: '<span class="tag ok"><span class="d"></span>运行中</span>', paused: '<span class="tag muted">已暂停</span>', stopped: '<span class="tag warn">待启动</span>' };
    $('dashJobs').innerHTML = d.jobs.length ? d.jobs.map(function (j) {
      var route = (j.stations || []).map(function (p) { return p.left + ' → ' + p.arrive; }).join('、') || '—';
      var seats = (j.seats || []).join(' / ') || '—';
      var dates = (j.left_dates || []).map(shortDate).join('、') || '—';
      var last = j.last_hit_at ? esc(String(j.last_hit_at).slice(5, 16)) + ' 命中' : '暂无记录';
      return '<tr style="cursor:pointer" data-job="' + j.job_id + '"><td><b>' + esc(j.job_name || '未命名') + '</b></td><td>' + esc(route) + '</td><td>' + esc(dates) + '</td><td>' + esc(seats) + '</td><td>' + stTag[j.status] + '</td><td style="color:var(--sub)">' + last + '</td></tr>';
    }).join('') : '<tr><td colspan="6" style="color:var(--faint)">暂无任务，点左侧「新建任务」开始</td></tr>';
    $('dashJobs').querySelectorAll('tr[data-job]').forEach(function (tr) {
      tr.addEventListener('click', function () { go('detail', { job_id: tr.dataset.job }); });
    });

    // 7 日柱状图
    var max = Math.max(1, d.daily.map(function (x) { return x.count; }).reduce(function (a, b) { return a + b; }, 0));
    $('dashChart').innerHTML = d.daily.map(function (x, i) {
      var h = Math.max(6, Math.round(x.count / max * 96));
      var label = x.day.slice(5).replace('-', '/');
      return '<div class="c' + (i === d.daily.length - 1 ? ' now' : '') + '"><i style="height:' + h + 'px"><b>' + x.count + '</b></i><span>' + label + '</span></div>';
    }).join('');

    // feed
    $('dashFeed').innerHTML = d.feed.length ? d.feed.slice().reverse().map(function (raw) {
      var cls = /命中|EVENT|订单|成功/.test(raw) ? 'ok' : (/失败|错误|Error|Exception/.test(raw) ? '' : 'info');
      var m = raw.match(/\d{2}:\d{2}:\d{2}/);
      return '<div class="it ' + cls + '"><i class="fdot"></i><div style="min-width:0"><div class="tx">' + clip(raw) + '</div><div class="tm">' + (m ? m[0] : '') + '</div></div></div>';
    }).join('') : '<div class="it mut"><i class="fdot"></i><div class="tx">暂无日志</div></div>';
  }).catch(function () { });
}
function clip(s) {
  s = String(s).replace(/^[\d\-\s:]+/, '');
  return s.length > 46 ? s.slice(0, 46) + '…' : s;
}

/* ---------- 2. 任务列表 ---------- */
function loadJobs() {
  api('/api/jobs').then(function (d) {
    var jobs = d.jobs;
    var running = jobs.filter(function (j) { return j.status === 'running'; }).length;
    $('navJobCount').textContent = jobs.length;
    $('jobsCnt').textContent = '共 ' + jobs.length + ' 个 · 运行中 ' + running;
    if (!jobs.length) {
      $('jobsList').innerHTML = '<div class="empty" style="background:#fff;border:1px dashed var(--line)"><b>还没有抢票任务</b>点击「新建任务」配置区间后即刻开始查询。</div>';
      return;
    }
    $('jobsList').innerHTML = jobs.map(function (j) {
      var routes = (j.stations || []).map(function (p) { return esc(p.left) + ' <b style="color:var(--red);margin:0 6px">→</b> ' + esc(p.arrive); });
      var stTag = j.status === 'running' ? '<span class="tag ok"><span class="d"></span>运行中</span>' : j.status === 'paused' ? '<span class="tag muted">已暂停</span>' : '<span class="tag warn">待启动</span>';
      var tags = '<span class="tag info">' + esc((j.left_dates || []).map(shortDate).join(' / ') || '未设日期') + '</span>' +
        (j.seats || []).map(function (s) { return '<span class="tag hot">' + esc(s) + '</span>'; }).join('') +
        (j.train_numbers && j.train_numbers.length ? '<span class="tag muted">指定 ' + j.train_numbers.length + ' 车次</span>' : '') +
        (j.except_train_numbers && j.except_train_numbers.length ? '<span class="tag muted">排除 ' + j.except_train_numbers.length + ' 车次</span>' : '');
      var hit = j.hit_count ? '<span class="hit">命中 ' + j.hit_count + ' 次</span>' : '尚未命中';
      return '<div class="job' + (j.status !== 'running' ? ' paused' : '') + '">' +
        '<div class="l1"><span class="route">' + routes.join('；') + '</span>' + stTag +
        '<div class="acts"><button class="btn btn-outline btn-sm" data-act="toggle" data-id="' + j.job_id + '" data-active="' + (j.is_active ? 1 : 0) + '">' + (j.is_active ? '暂停' : '启动') + '</button><button class="btn btn-ghost btn-sm" data-act="detail" data-id="' + j.job_id + '">详情</button></div></div>' +
        '<div class="l2">' + tags + '</div>' +
        '<div class="l3"><span>' + hit + '</span><span>创建 ' + esc(j.created_at || '') + '</span><span>账号 ' + esc(j.account_key || '—') + '</span></div></div>';
    }).join('');
    $('jobsList').querySelectorAll('button[data-act="toggle"]').forEach(function (b) {
      b.addEventListener('click', function () { jobToggle(b.dataset.id, b.dataset.active === '0'); });
    });
    $('jobsList').querySelectorAll('button[data-act="detail"]').forEach(function (b) {
      b.addEventListener('click', function () { go('detail', { job_id: b.dataset.id }); });
    });
  }).catch(function (e) { toast(e.message, 'err'); });
}
// 任务行点击进详情（整卡除按钮外可点）
document.addEventListener('click', function (e) {
  var card = e.target.closest && e.target.closest('#jobsList .job');
  if (!card) return;
  var btn = e.target.closest('button');
  if (btn) return;
  var b = card.querySelector('button[data-act="detail"]');
  if (b) go('detail', { job_id: b.dataset.id });
});

/* ---------- 3. 任务详情 ---------- */
function loadDetail(job_id) {
  api('/api/jobs/' + encodeURIComponent(job_id)).then(function (j) {
    $('dName').textContent = j.job_name || '任务详情';
    var stTag = j.status === 'running' ? '<span class="tag ok"><span class="d"></span>运行中</span>' : '<span class="tag muted">已暂停</span>';
    $('dMeta').innerHTML = stTag + ' <span class="tag muted">创建 ' + esc(j.created_at || '—') + '</span> <span class="tag muted">账号 ' + esc(j.account && j.account.user_name || '—') + '</span>';
    $('dToggle').textContent = j.is_active ? '暂停任务' : '启动任务';
    $('dToggle').onclick = function () {
      jobToggle(job_id, !j.is_active, this, function () { loadDetail(job_id); });
    };
    // 行程信息
    var routes = (j.stations || []).map(function (p) { return esc(p.left) + ' → ' + esc(p.arrive); });
    var seatPri = (j.seats || []).map(function (s, i) { return '<i class="p' + Math.min(3, i + 1) + '">' + esc(s) + '</i>'; }).join('');
    $('dFacts').innerHTML =
      '<div class="detail-fact"><span>区间</span><b>' + (routes.join('；') || '—') + '</b></div>' +
      '<div class="detail-fact"><span>出行日期</span><b>' + esc((j.left_dates || []).map(shortDate).join('、') || '—') + '</b></div>' +
      '<div class="detail-fact"><span>乘车人</span><b>' + esc((j.members || []).join('、') || '—') + '</b></div>' +
      '<div class="detail-fact"><span>席别优先级</span><b class="seat-priority">' + (seatPri || '—') + '</b></div>' +
      '<div class="detail-fact"><span>车次策略</span><b>' + ((j.train_numbers || []).length ? esc(j.train_numbers.join('、')) : (j.except_train_numbers || []).length ? '排除 ' + esc(j.except_train_numbers.join('、')) : '不限') + '</b></div>';
    // 4 指标
    $('dStats').innerHTML =
      '<div class="card detail-stat"><span>累计命中</span><b>' + j.hit_count + '</b></div>' +
      '<div class="card detail-stat"><span>查询频率</span><b>' + esc(j.interval.min) + '–' + esc(j.interval.max) + '<small>s</small></b></div>' +
      '<div class="card detail-stat"><span>查询时间段</span><b style="font-size:13px">' + esc(j.period.from) + ' – ' + esc(j.period.to) + '</b></div>' +
      '<div class="card detail-stat"><span>最后命中</span><b style="font-size:13px">' + (j.last_hit_at ? esc(String(j.last_hit_at).slice(5, 16)) : '—') + '</b></div>';
    // 命中表
    $('dHits').innerHTML = (j.hits || []).length ? j.hits.map(function (h) {
      return '<tr><td><b>' + esc(h.train_number) + '</b></td><td>' + esc(h.seat) + '</td><td>' + esc(h.num) + '</td><td>' + esc(h.left_date) + '</td><td style="color:var(--sub)">' + esc(h.at) + '</td></tr>';
    }).join('') : '<tr><td colspan="5" style="color:var(--faint);text-align:center">暂无命中记录</td></tr>';
    // 时间线
    $('dTimeline').innerHTML = (j.hit_timeline || []).length ? j.hit_timeline.slice(0, 15).map(function (h) {
      return '<div class="it"><time>' + esc(String(h.at).slice(5, 16).replace(' ', ' ')) + '</time><i class="fdot" style="background:var(--red);border:3px solid var(--red-bg);border-radius:50%;width:12px;height:12px"></i><div><b>' + esc(h.train_number) + '</b> 命中 <b>' + esc(h.seat) + '</b> × ' + esc(h.num) + ' <span style="color:var(--faint)">(' + esc(shortDate(h.left_date)) + ')</span></div></div>';
    }).join('') : '<div style="padding:16px;color:var(--faint);font-size:12px">还没有执行记录，任务启动后这里会实时展示查询与命中轨迹。</div>';
    // 日志
    $('dLog').innerHTML = (j.logs || []).length ? j.logs.slice(-60).map(function (l) { return '<div class="' + logLineClass(l) + '">' + esc(l) + '</div>'; }).join('') : '<div style="color:var(--faint)">暂无日志</div>';
  }).catch(function (e) { toast(e.message, 'err'); go('jobs'); });
}
function logLineClass(line) {
  if (/失败|错误|Error|Exception|放弃/.test(line)) return 'l-ERROR';
  if (/命中|订单|EVENT/.test(line)) return 'l-EVENT';
  if (/余票|查询/.test(line)) return 'l-INFO';
  return 'l-OK';
}
// #dToggle 的写操作在 loadDetail 内按当前 is_active 绑定（避免重复触发）

/* ---------- 4. 新建任务 ---------- */
var APP = { passengers: {}, seats: [] };
function loadDates() {
  api('/api/dates').then(function (d) {
    // 新建任务：紧凑日期选择（今天~+11 显示，点击弹日期条）
    var wrap = $('ntDates');
    wrap.innerHTML = '';
    APP.dates = d.dates;
    APP.selDates = [];
    renderNtDates();
    // 监控日期条
    $('mDates').innerHTML = d.dates.map(function (x) {
      var dd = new Date(x.date + 'T00:00:00');
      return '<div class="date' + (x.tag === 'today' ? ' on' : '') + '" data-date="' + x.date + '"><b>' + x.weekday + '</b><small>' + x.date.slice(5) + '</small></div>';
    }).join('');
    $('mDates').querySelectorAll('.date').forEach(function (el) {
      el.addEventListener('click', function () {
        $('mDates').querySelectorAll('.date').forEach(function (x) { x.classList.remove('on'); });
        el.classList.add('on');
        $('mDate').value = el.dataset.date;
      });
    });
    $('mDate').value = d.dates[0].date;
    $('mDate').addEventListener('change', function () {
      var el = $('mDates').querySelector('.date[data-date="' + $('mDate').value + '"]');
      if (el) el.click();
    });
    loadStationsForPairs();
  }).catch(function () { });
}
function renderNtDates() {
  var wrap = $('ntDates');
  wrap.innerHTML = APP.selDates.map(function (d, i) { return '<span class="date-chip">' + shortDate(d) + '<button data-i="' + i + '">✕</button></span>'; }).join('') + '<span class="date-chip add" id="ntDateAdd">+ 选择日期</span>';
  $('ntDateCnt').textContent = APP.selDates.length ? '已选 ' + APP.selDates.length + ' 天' : '请选择';
  wrap.querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function (e) { e.stopPropagation(); APP.selDates.splice(+b.dataset.i, 1); renderNtDates(); updateNtSummary(); });
  });
  $('ntDateAdd').addEventListener('click', openNtDatePicker);
  updateNtSummary();
}
function openNtDatePicker() {
  var box = $('ntDates');
  var pick = document.createElement('div');
  pick.style.cssText = 'display:grid;grid-template-columns:repeat(12,1fr);gap:6px;margin-top:8px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px';
  pick.innerHTML = APP.dates.map(function (x) {
    var on = APP.selDates.indexOf(x.date) >= 0;
    return '<span class="date-chip" style="background:' + (on ? 'var(--red)' : 'var(--line-soft)') + ';color:' + (on ? '#fff' : 'var(--sub)') + ';justify-content:center" data-d="' + x.date + '">' + x.weekday + '<br>' + x.date.slice(5) + '</span>';
  }).join('');
  box.appendChild(pick);
  pick.querySelectorAll('[data-d]').forEach(function (el) {
    el.addEventListener('click', function () {
      var i = APP.selDates.indexOf(el.dataset.d);
      if (i >= 0) APP.selDates.splice(i, 1);
      else if (APP.selDates.length >= APP.dates.length) { toast('最多选择 ' + APP.dates.length + ' 天', 'err'); return; }
      else APP.selDates.push(el.dataset.d);
      pick.remove(); renderNtDates();
    });
  });
}
function loadAccountsForNew() {
  api('/api/accounts').then(function (d) {
    var opts = '<option value="">（需先添加并登录账号）</option>' + d.accounts.map(function (a) {
      return '<option value="' + a.key + '" ' + (!a.is_ready ? 'disabled' : '') + '>' + esc(a.user_name) + (a.is_ready ? '（在线 · ' + a.passenger_count + ' 位乘客）' : '（离线）') + '</option>';
    }).join('');
    $('ntAccount').innerHTML = opts;
    $('oAccount').innerHTML = opts;
  }).catch(function () { });
}
function loadPassengersFor(key) {
  if (!key) {
    $('ntPassengers').innerHTML = '<span style="color:var(--faint);font-size:12.5px">请先在上方选择账号</span>';
    $('ntPaxHint').textContent = '需选择账号后加载';
    APP.paxAll = []; APP.paxSel = [];
    return;
  }
  APP.paxAll = []; APP.paxSel = [];
  $('ntPassengers').innerHTML = '<span style="color:var(--faint);font-size:12.5px">加载中…</span>';
  $('ntPaxHint').textContent = '';
  api('/api/accounts/' + encodeURIComponent(key) + '/passengers').then(function (d) {
    APP.paxAll = d.passengers || [];
    if (!APP.paxAll.length) { $('ntPassengers').innerHTML = '<span style="color:var(--faint);font-size:12.5px">该账号暂无乘客</span>'; updateNtSummary(); return; }
    APP.paxSel = APP.paxAll.map(function (p) { return p.name; });
    renderNtPassengers();
  }).catch(function () { $('ntPassengers').innerHTML = '<span style="color:var(--faint)">加载失败</span>'; });
}
function renderNtPassengers() {
  $('ntPassengers').innerHTML = APP.paxAll.map(function (p) {
    var on = APP.paxSel.indexOf(p.name) >= 0;
    return '<label class="order-person"><input type="checkbox" ' + (on ? 'checked' : '') + ' value="' + esc(p.name) + '"><span><b>' + esc(p.name) + ' · ' + esc(p.type || '成人') + '</b><small>' + esc(p.no || '') + '</small></span></label>';
  }).join('');
  $('ntPassengers').querySelectorAll('input').forEach(function (i) {
    i.addEventListener('change', function () {
      var v = i.value, ix = APP.paxSel.indexOf(v);
      if (i.checked && ix < 0) APP.paxSel.push(v);
      if (!i.checked && ix >= 0) APP.paxSel.splice(ix, 1);
      updateNtSummary();
    });
  });
}
function buildNtSeats() {
  if (!APP.seats.length) return;
  if (APP.selSeats && APP.selSeats.length) { /* 保留预填选择 */ }
  else {
    var prefer = ['二等座', '一等座', '商务座', '硬卧', '硬座'];
    APP.selSeats = prefer.filter(function (s) { return APP.seats.indexOf(s) >= 0; }).slice(0, 2);
    if (!APP.selSeats.length) APP.selSeats = [APP.seats[0]];
  }
  $('ntSeats').innerHTML = APP.seats.map(function (s) {
    var on = APP.selSeats.indexOf(s) >= 0;
    return '<label style="display:inline-flex;align-items:center;background:' + (on ? 'var(--red-bg)' : 'var(--line-soft)') + ';border-radius:99px;padding:5px 13px;font-size:12.5px;margin:0 8px 8px 0;cursor:pointer;user-select:none" data-seat="' + esc(s) + '"><input type="checkbox" ' + (on ? 'checked' : '') + ' style="margin-right:6px;accent-color:var(--red)">' + esc(s) + '</label>';
  }).join('');
  $('ntSeats').querySelectorAll('label').forEach(function (l) {
    l.addEventListener('click', function (e) {
      e.preventDefault();
      var input = l.querySelector('input');
      input.checked = !input.checked;
      var v = l.dataset.seat, ix = APP.selSeats.indexOf(v);
      if (input.checked && ix < 0) APP.selSeats.push(v);
      if (!input.checked && ix >= 0) APP.selSeats.splice(ix, 1);
      l.style.background = input.checked ? 'var(--red-bg)' : 'var(--line-soft)';
      updateNtSummary();
    });
  });
}
function addNtPair(left, arrive) {
  var row = document.createElement('div');
  row.className = 'pair';
  row.innerHTML = '<input class="stn" type="text" data-role="left" value="" placeholder="出发站"><span class="arr">→</span><input class="stn" type="text" data-role="arrive" value="" placeholder="到达站"><span class="del">✕</span>';
  $('ntPairs').appendChild(row);
  if (left) row.querySelector('[data-role=left]').value = left;
  if (arrive) row.querySelector('[data-role=arrive]').value = arrive;
  wireNtPair(row);
}
function wireNtPair(row) {
  row.querySelector('.del').addEventListener('click', function () {
    row.remove();
    if (!$('ntPairs').querySelector('.pair')) addNtPair('北京', '深圳');
  });
  bindStationSuggest(row.querySelectorAll('.stn'));
}
function loadStationsForPairs() {
  $('ntPairs').querySelectorAll('.pair').forEach(wireNtPair);
}
function bindIntervalPresets() {
  var box = $('ntIntervalPresets'); if (!box || box.dataset.bound) return;
  box.dataset.bound = '1';
  var custom = box.closest('.task-interval-field').querySelector('.task-interval-custom');
  box.querySelectorAll('.task-interval-preset').forEach(function (b) {
    b.addEventListener('click', function () {
      box.querySelectorAll('.task-interval-preset').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      if (b.dataset.custom) {
        custom.classList.add('open');
        setTimeout(function () { $('ntIntMin').focus(); }, 60);
      } else {
        custom.classList.remove('open');
        $('ntIntMin').value = b.dataset.min;
        $('ntIntMax').value = b.dataset.max;
      }
      updateNtSummary();
    });
  });
  ['ntIntMin', 'ntIntMax'].forEach(function (id) {
    $(id).addEventListener('input', function () {
      box.querySelectorAll('.task-interval-preset').forEach(function (x) { x.classList.toggle('on', !!x.dataset.custom); });
      custom.classList.add('open');
    });
  });
}
function refreshNewView() {
  bindIntervalPresets();
  buildNtSeats();
  loadPassengersFor($('ntAccount').value);
  renderTaskPicked();
  updateNtSummary();
}
function ntPairs() {
  var out = [];
  $('ntPairs').querySelectorAll('.pair').forEach(function (r) {
    out.push({ left: r.querySelector('[data-role=left]').value.trim(), arrive: r.querySelector('[data-role=arrive]').value.trim() });
  });
  return out.filter(function (p) { return p.left && p.arrive; });
}
function ntTags(id) {
  return Array.prototype.map.call(document.querySelectorAll('#' + id + ' .t'), function (t) { return t.textContent.trim(); });
}
function updateNtSummary() {
  var pairs = ntPairs();
  var picked = APP.taskPicked || [];
  var pickedNames = picked.map(function (s) { return s.leg.n; });
  var tagTrains = ntTags('ntTrainBox');
  var seatPri = (APP.selSeats || []).map(function (s, i) { return '<i class="p' + Math.min(3, i + 1) + '">' + esc(s) + '</i>'; }).join(' ');
  var accKey = $('ntAccount').value;
  $('ntSummary').innerHTML =
    row('车次 / 席别', picked.length ? esc(pickedNames.join('、')) + '<small>' + picked.length + ' 个车次 · 从车票查询添加</small>'
      : (tagTrains.length ? esc(tagTrains.join('、')) + '<small>仅限列表内车次</small>' : (ntTags('ntExceptBox').length ? '排除 ' + esc(ntTags('ntExceptBox').join('、')) : '按区间查全部车次'))) +
    row('账号', esc(accKey || '未选')) +
    row('乘客', APP.paxSel && APP.paxSel.length ? esc(APP.paxSel.join('、')) + '<small>' + APP.paxSel.length + ' 人' + ($('ntLessMember').checked ? ' · 允许部分先行' : '') + '</small>' : '未选') +
    row('区间', pairs.length ? esc(pairs.map(function (p) { return p.left + '→' + p.arrive; }).join(' · ')) + '<small>' + pairs.length + ' 组区间并行查询</small>' : '未填') +
    row('日期', APP.selDates.length ? esc(APP.selDates.map(shortDate).join('、')) + '<small>共 ' + APP.selDates.length + ' 天</small>' : '未选') +
    row('席别', seatPri || '未选', 'seat-priority') +
    row('策略', esc($('ntFromT').value + '–' + $('ntToT').value + ' · 间隔 ' + ($('ntIntMin').value || 1) + '–' + ($('ntIntMax').value || 1) + 's') + '<small>命中即提交下单</small>');
}
function row(k, v, cls) { return '<div class="r"><span class="k">' + k + '</span><span class="v"><span class="' + (cls || '') + '">' + (v || '未填') + '</span></span></div>'; }

/* 车次标签框 */
function wireTagbox(boxId, inputId) {
  var box, input;
  function init() {
    box = $(boxId); input = $(inputId);
    if (!box || !input) return;
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        var v = input.value.trim().toUpperCase().replace(/，/g, ',');
        if (!v) return;
        v.split(',').forEach(function (t) {
          t = t.trim();
          if (t && !box.querySelector('[data-t="' + t + '"]')) {
            var s = document.createElement('span');
            s.className = 't'; s.dataset.t = t;
            s.innerHTML = esc(t) + ' <em>✕</em>';
            box.insertBefore(s, input);
            s.querySelector('em').addEventListener('click', function () { s.remove(); updateNtSummary(); });
          }
        });
        input.value = '';
        updateNtSummary();
      }
    });
  }
  init();
}
function refreshMonitorView() {
  $('mFromSug').classList.add('hidden');
  $('mToSug').classList.add('hidden');
  if (!MON.filterBound) {
    MON.filterBound = true;
    bindMonitorFilters();
    $('mPanel').querySelectorAll('.sort-head').forEach(function (b) {
      b.addEventListener('click', function () { setMonSort(b.dataset.sort); });
    });
  }
  applyMonitor();
}

/* ---------- 车站联想 ---------- */
var sugTimers = {};
function bindStationSuggest(inputs) {
  (inputs.length ? inputs : [inputs]).forEach(function (inp) {
    inp.addEventListener('input', function () {
      var boxId = inp.id === 'mFrom' ? 'mFromSug' : inp.id === 'mTo' ? 'mToSug' : null;
      clearTimeout(sugTimers[boxId || inp]);
      var key = boxId || (inp.dataset.role || 'x') + '.' + (inp.parentNode.querySelector('[data-role=left]') ? inp.parentNode.querySelector('[data-role=left]').value : '');
      if (!boxId) return; // 新建任务页站名直接输入即可，不做远程联想
      if (!inp.value.trim()) { $(boxId).classList.add('hidden'); return; }
      sugTimers[key] = setTimeout(function () {
        api('/api/stations?q=' + encodeURIComponent(inp.value.trim())).then(function (d) {
          var list = d.list || [];
          var box = $(boxId);
          if (!list.length) { box.classList.add('hidden'); return; }
          box.innerHTML = list.map(function (s) {
            return '<div class="stn-item" data-n="' + esc(s.name) + '"><span>' + esc(s.name) + '</span><small>' + esc(s.pinyin || '') + '</small></div>';
          }).join('');
          box.classList.remove('hidden');
          box.querySelectorAll('.stn-item').forEach(function (it) {
            it.addEventListener('mousedown', function (e) {
              e.preventDefault();
              inp.value = it.dataset.n;
              box.classList.add('hidden');
              if (it.dataset.n.indexOf('站') < 0) { /* 保持原样 */ }
            });
          });
        }).catch(function () { });
      }, 300);
    });
    inp.addEventListener('blur', function () { setTimeout(function () { if (boxId) $(boxId).classList.add('hidden'); }, 150); });
  });
}

/* ---------- 5. 车票查询 ---------- */
var MON = { rows: [], batch: false, sel: {}, selSeats: {}, sort: null, stationOpts: { from: {}, to: {} },
            filters: { types: [], fromSt: [], toSt: [], seats: [], hour: '', bookable: false } };
APP.taskPicked = []; // 新建任务：从车票查询勾选的车次（含席别）
var PICK_SEAT_KEYS = ['business', 'first', 'second', 'hardSleeper', 'hardSeat', 'noSeat', 'softSleeper', 'special'];
function renderTaskPicked() {
  var list = $('taskSelectionList'), empty = $('taskSelectionEmpty');
  if (!list) return;
  var sels = APP.taskPicked || [];
  empty.style.display = sels.length ? 'none' : 'block';
  list.innerHTML = sels.map(function (s, idx) {
    var leg = s.leg;
    var chip = PICK_SEAT_KEYS.map(function (k) {
      var v = leg.s ? leg.s[k] : '';
      var on = s.seats.indexOf(SEAT_NAME[k]) >= 0;
      if (!v || v === '无') return '<span class="task-seat-option" style="opacity:.4;cursor:default"><input type="checkbox" disabled>' + SEAT_NAME[k] + '</span>';
      return '<label class="task-seat-option"><input type="checkbox" data-idx="' + idx + '" data-k="' + k + '" ' + (on ? 'checked' : '') + '>' + SEAT_NAME[k] + (v !== '有' ? '<small>' + esc(v) + '</small>' : '') + '</label>';
    }).join('');
    return '<div class="task-selection-item" data-idx="' + idx + '">' +
      '<div class="train"><b>' + esc(leg.n) + '</b><small>' + esc(leg.tn) + '</small></div>' +
      '<div class="route"><b>' + esc(leg.f) + ' ' + esc(leg.d) + ' → ' + esc(leg.to) + ' ' + esc(leg.a) + '</b><small>' + $('mDate').value + ' · ' + fmtDur(leg.m) + '</small></div>' +
      '<div class="task-seat-options">' + chip + '</div>' +
      '<button class="remove-selection" data-idx="' + idx + '" title="移除">×</button></div>';
  }).join('');
  list.querySelectorAll('input[data-idx]').forEach(function (i) {
    if (i.disabled) return;
    i.addEventListener('change', function () {
      var s = APP.taskPicked[+i.dataset.idx];
      var name = SEAT_NAME[i.dataset.k];
      var ix = s.seats.indexOf(name);
      if (i.checked && ix < 0) s.seats.push(name);
      if (!i.checked && ix >= 0) s.seats.splice(ix, 1);
      updateNtSummary();
    });
  });
  list.querySelectorAll('.remove-selection').forEach(function (b) {
    b.addEventListener('click', function () { APP.taskPicked.splice(+b.dataset.idx, 1); renderTaskPicked(); updateNtSummary(); });
  });
  updateNtSummary();
}
function enterPickMode() {
  $('mPanel').classList.add('task-pick-mode', 'batch-mode');
  toast('勾选要抢的车次后点「添加到任务」', '', 2600);
}
function exitPickMode() {
  $('mPanel').classList.remove('task-pick-mode');
  if (!MON.batch) $('mPanel').classList.remove('batch-mode');
}
function pickedTrains() { // 已选车次号（去重）
  var t = [];
  Object.keys(MON.sel).map(Number).sort(function (a, b) { return a - b; }).forEach(function (i) { var n = MON.rows[i] && MON.rows[i].n; if (n && t.indexOf(n) < 0) t.push(n); });
  return t;
}
function pickAddToTask() {
  var sel = Object.keys(MON.sel).map(Number).sort(function (a, b) { return a - b; });
  if (!sel.length) { toast('请先勾选车次', 'err'); return; }
  sel.forEach(function (i) {
    var leg = MON.rows[i];
    var seats = Object.keys(MON.selSeats[i] || {}).map(function (k) { return SEAT_NAME[k]; }).filter(Boolean);
    APP.taskPicked.push({ leg: leg, seats: seats });
  });
  // 顺带预填区间
  var leg0 = sel.length ? MON.rows[sel[0]] : null;
  if (leg0) { $('ntPairs').innerHTML = ''; addNtPair(leg0.f, leg0.to); }
  var d = $('mDate').value;
  if (d && APP.selDates.indexOf(d) < 0) { APP.selDates.push(d); renderNtDates(); }
  exitPickMode();
  MON.sel = {};
  go('new');
  renderTaskPicked();
  toast('已添加 ' + sel.length + ' 个车次到任务', 'ok');
}
/* 车次筛选（按首字母归类） */
function trainTypeOf(n) {
  var c = String(n || '').charAt(0).toUpperCase();
  if (c === 'G' || c === 'C') return 'g';
  if (c === 'D') return 'd';
  if (c === 'Z') return 'z';
  if (c === 'T') return 't';
  if (c === 'K' || c === 'L') return 'k';
  return 'other';
}
/* 批量关联弹窗 */
function openTaskBindModal() {
  var sel = Object.keys(MON.sel).map(Number).sort(function (a, b) { return a - b; });
  if (!sel.length) { toast('请先勾选车次', 'err'); return; }
  api('/api/jobs').then(function (d) {
    var jobs = (d.jobs || []).filter(function (j) { return j.is_active || j.status === 'running'; });
    if (!jobs.length) { toast('暂无可关联的任务（先到「新建任务」创建）', 'err'); return; }
    var names = {};
    // 账号名映射
    api('/api/accounts').then(function (a) { (a.accounts || []).forEach(function (x) { names[x.key] = x.user_name; }); renderBindOptions(d.jobs || [], sel, names); })
      .catch(function () { renderBindOptions(d.jobs || [], sel, names); });
  }).catch(function (e) { toast(e.message, 'err'); });
}
function renderBindOptions(jobs, sel, names) {
  var rows = sel.slice(0, 6).map(function (i) { var l = MON.rows[i]; return esc(l.n) + ' ' + esc(l.f) + '→' + esc(l.to); }).join('、');
  $('taskPreview').textContent = '将 ' + sel.length + ' 个车次关联到所选任务：' + (sel.length > 6 ? rows + '…' : rows);
  $('bindChoices').innerHTML = jobs.map(function (j) {
    var routes = (j.stations || []).map(function (p) { return esc(p.left) + '→' + esc(p.arrive); }).join('、');
    var st = j.is_active ? '运行中' : '已暂停';
    return '<label class="choice"><input type="radio" name="jobBind" value="' + esc(j.job_id) + '"><span>' +
      '<b>' + routes + ' · ' + esc(j.job_name || '未命名') + '</b>' +
      '<small>' + esc(names[j.account_key] || j.account_key || '未设账号') + (j.train_numbers && j.train_numbers.length ? ' · 指定车次 ' + j.train_numbers.slice(0, 5).join('/') : '') + ' · ' + st + '</small></span></label>';
  }).join('');
  $('taskModal').classList.add('open');
}
function closeTaskBindModal(force) {
  if (!force && !window.confirm('取消关联？')) return;
  $('taskModal').classList.remove('open');
}
function confirmTaskBind() {
  var checked = document.querySelector('#bindChoices input[name="jobBind"]:checked');
  if (!checked) { toast('请选择要关联的任务', 'err'); return; }
  var job_id = checked.value;
  var trains = pickedTrains();
  api('/api/jobs/' + encodeURIComponent(job_id), { method: 'PATCH', body: JSON.stringify({ train_numbers: trains }) })
    .then(function () { toast('已把 ' + trains.length + ' 个车次关联到任务', 'ok'); exitTaskModalHard(); loadJobs(); })
    .catch(function (e) { toast(e.message, 'err'); });
}
function exitTaskModalHard() { $('taskModal').classList.remove('open'); }
/* 静态筛选区（对齐设计稿）：每组含「全部」互斥；时间组多选 */
function readFilterGroup(boxId) {
  var box = $(boxId); if (!box) return [];
  var all = box.querySelector('input[value="all"]');
  if (all && all.checked) return [];
  return Array.prototype.map.call(box.querySelectorAll('input:checked'), function (i) { return i.value; });
}
function checkedVals(root, g) {
  return Array.prototype.map.call(root.querySelectorAll('input[data-g="' + g + '"]:checked'), function (i) { return i.value; });
}
function syncMonitorFilters() {
  MON.filters.types = readFilterGroup('mType');
  MON.filters.fromSt = readFilterGroup('mFromStation');
  MON.filters.toSt = readFilterGroup('mToStation');
  MON.filters.seats = readFilterGroup('mSeatFilter');
  MON.filters.hour = readFilterGroup('mTime');
  MON.filters.bookable = $('mAvailable').checked;
}
function bindMonitorFilters() {
  ['mType', 'mFromStation', 'mToStation', 'mSeatFilter'].forEach(function (id) {
    var box = $(id); if (!box) return;
    box.addEventListener('change', function () {
      var checked = box.querySelector('input:checked');
      var isAll = box.querySelector('input[value="all"]');
      if (checked && checked !== isAll) { if (isAll) isAll.checked = false; }
      else if (isAll) { // 全被取消 → 回到「全部」
        if (!box.querySelector('input[value!="all"]:checked')) { box.querySelectorAll('input').forEach(function (i) { i.checked = false; }); isAll.checked = true; }
      }
      syncMonitorFilters();
      applyMonitor();
    });
  });
  var hourBox = $('mTime');
  if (hourBox) hourBox.addEventListener('change', function () {
    var isAll = hourBox.querySelector('input[value="all"]');
    var others = hourBox.querySelectorAll('input[value!="all"]:checked');
    if (others.length && isAll) isAll.checked = false;
    if (!others.length && isAll) isAll.checked = true;
    syncMonitorFilters();
    applyMonitor();
  });
  if ($('mAvailable')) $('mAvailable').addEventListener('change', function () { syncMonitorFilters(); applyMonitor(); });
  if ($('mFilterClear')) $('mFilterClear').addEventListener('click', function () {
    ['mType', 'mFromStation', 'mToStation', 'mSeatFilter'].forEach(function (id) {
      var box = $(id); if (!box) return;
      box.querySelectorAll('input').forEach(function (i) { i.checked = (i.value === 'all'); });
    });
    var hourBox = $('mTime');
    if (hourBox) hourBox.querySelectorAll('input').forEach(function (i) { i.checked = (i.value === 'all'); });
    if ($('mAvailable')) $('mAvailable').checked = false;
    var seg = $('mMode');
    if (seg) seg.querySelectorAll('.seg-btn').forEach(function (b) { b.classList.toggle('on', b.dataset.mode === 'all'); });
    var dur = $('mDur'); if (dur) dur.value = 'all';
    MON.filters = { types: [], fromSt: [], toSt: [], seats: [], hour: '', bookable: false };
    applyMonitor();
  });
  if ($('mFilterApply')) $('mFilterApply').addEventListener('click', function () {
    syncMonitorFilters();
    var n = applyMonitor();
    toast('筛选完成 · ' + n + ' 个车次', 'ok');
  });
  if ($('mClearSort')) $('mClearSort').addEventListener('click', function () { setMonSort(null); });
  var seg = $('mMode');
  if (seg) seg.querySelectorAll('.seg-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      seg.querySelectorAll('.seg-btn').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      var m = b.dataset.mode;
      var isTransfer = m === 'transfer';
      seg.closest('.filter').querySelectorAll('[data-transfer-filter]').forEach(function (el) {
        el.style.display = isTransfer ? 'flex' : 'none';
      });
      if (m === 'direct') seg.closest('.filter').querySelectorAll('[data-transfer-filter]').forEach(function (el) { el.style.display = 'none'; });
    });
  });
}
function renderStationFilter(boxId, opts) {
  var box = $(boxId); if (!box) return;
  var cur = readFilterGroup(boxId);
  box.innerHTML = '<label class="filter-option filter-all"><input type="checkbox" value="all" ' + (!cur.length ? 'checked' : '') + '><span>全部</span></label>' +
    Object.keys(opts).sort(function (a, b) { return opts[b] - opts[a]; }).map(function (n) {
      return '<label class="filter-option"><input type="checkbox" value="' + esc(n) + '" ' + (cur.indexOf(n) >= 0 ? 'checked' : '') + '><span>' + esc(n) + '</span></label>';
    }).join('');
  if (!box.dataset.wired) {
    box.dataset.wired = '1';
    box.addEventListener('change', function () {
      var isAll = box.querySelector('input[value="all"]');
      var checked = box.querySelector('input:checked');
      if (checked && checked !== isAll) { if (isAll) isAll.checked = false; }
      else if (isAll && !box.querySelector('input[value!="all"]:checked')) { box.querySelectorAll('input').forEach(function (i) { i.checked = false; }); isAll.checked = true; }
      syncMonitorFilters();
      applyMonitor();
    });
  }
}
function doMonitorSearch() {
  var left = $('mFrom').value.trim(), arrive = $('mTo').value.trim(), date = $('mDate').value;
  if (!left || !arrive || !date) { toast('请填写出发地、目的地和日期', 'err'); return; }
  $('mSearch').disabled = true;
  $('mSummary').textContent = '查询中…';
  api('/api/tickets?' + new URLSearchParams({ left: left, arrive: arrive, date: date }))
    .then(function (d) {
      MON.rows = d.rows || [];
      MON.sel = {}; MON.selSeats = {};
      MON.sort = null;
      $('mRoute').textContent = left + ' → ' + arrive + ' · ' + date;
      // 收集出发/到达车站选项
      var fo = {}, to = {};
      MON.rows.forEach(function (l) { if (l.f) fo[l.f] = (fo[l.f] || 0) + 1; if (l.to) to[l.to] = (to[l.to] || 0) + 1; });
      MON.stationOpts = { from: fo, to: to };
      renderStationFilter('mFromStation', fo);
      renderStationFilter('mToStation', to);
      markSortHeads();
      applyMonitor();
    })
    .catch(function (e) {
      MON.rows = [];
      applyMonitor();
      toast(e.message, 'err');
    })
    .finally(function () { $('mSearch').disabled = false; });
}
function matchHour(leg, ranges) {
  if (!ranges || !ranges.length) return true;
  var h = +leg.d.slice(0, 2);
  return ranges.some(function (range) {
    var lo = +range.slice(0, 2), hi = +range.slice(6, 8);
    return h >= lo && h < hi;
  });
}
function matchStation(val, list) {
  if (!list || !list.length) return true;
  return list.some(function (s) { return val === s || String(val || '').indexOf(s) === 0; });
}
function setMonSort(key) {
  if (!key) { MON.sort = null; applyMonitor(); return; }
  if (MON.sort && MON.sort.k === key) MON.sort = (MON.sort.dir === 'asc' ? { k: key, dir: 'desc' } : null);
  else MON.sort = { k: key, dir: 'asc' };
  applyMonitor();
}
function markSortHeads() {
  $('mPanel').querySelectorAll('.sort-head').forEach(function (b) {
    b.classList.remove('sort-up', 'sort-down');
    if (MON.sort && b.dataset.sort === MON.sort.k) b.classList.add('active', MON.sort.dir === 'asc' ? 'sort-up' : 'sort-down');
    else b.classList.remove('active');
  });
  if ($('mClearSort')) $('mClearSort').style.display = MON.sort ? '' : 'none';
}
function applyMonitor() {
  var F = MON.filters;
  var rows = MON.rows.filter(function (leg) {
    if (F.types.length && F.types.indexOf(trainTypeOf(leg.n)) < 0) return false;
    if (!matchStation(leg.f, F.fromSt)) return false;
    if (!matchStation(leg.to, F.toSt)) return false;
    if (F.seats.length) {
      var hasAny = F.seats.some(function (k) { var v = leg.s ? leg.s[k] : ''; return v && v !== '无'; });
      if (!hasAny) return false;
    }
    if (!matchHour(leg, F.hour)) return false;
    if (F.bookable && !leg.bookable) return false;
    return true;
  });
  var s = MON.sort;
  rows.sort(function (a, b) {
    if (!s) return a.d.localeCompare(b.d);
    var r = 0;
    if (s.k === 'depart') r = a.d.localeCompare(b.d);
    else if (s.k === 'arrive') r = a.a.localeCompare(b.a);
    else if (s.k === 'duration') r = (a.m == null ? 9999 : a.m) - (b.m == null ? 9999 : b.m);
    else if (s.k === 'tickets') r = seatNum(b, 'second') - seatNum(a, 'second');
    else if (s.k === 'type') r = String(a.n).localeCompare(String(b.n));
    return s.dir === 'asc' ? r : -r;
  });
  var n = rows.length, hitCnt = rows.filter(function (r) { return r.bookable; }).length;
  $('mSummary').textContent = n ? '共 ' + n + ' 个车次 · 可订 ' + hitCnt + ' 个' : (MON.rows.length ? '筛选后无结果，调整筛选条件' : '');
  $('mEmpty').classList.toggle('hidden', n > 0);
  $('mResults').innerHTML = rows.map(rowHtml).join('');
  markSortHeads();
  // 事件
  $('mResults').querySelectorAll('input.row-check').forEach(function (cb) {
    cb.addEventListener('change', function () {
      var i = +cb.dataset.i;
      if (cb.checked) MON.sel[i] = true; else delete MON.sel[i];
      syncSelCount();
    });
  });
  $('mResults').querySelectorAll('button[data-act]').forEach(function (b) {
    b.addEventListener('click', function () {
      var i = +b.parentElement.parentElement.dataset.i;
      if (b.dataset.act === 'book') {
        if (Object.keys(MON.selSeats[i] || {}).length === 0) { toast('先点击该车的席别单元格选择席别（如「二等座」）', 'err'); return; }
        orderPush(MON.rows[i]);
        go('order');
      } else {
        prefillNewTask(MON.rows[i]);
        go('new');
      }
    });
  });
  // 点席别单元格选席（预定用）
  $('mResults').querySelectorAll('td.seat').forEach(function (td) {
    td.classList.add('seat-selectable');
    var k = td.dataset.seat, i = +td.parentElement.dataset.i;
    var v = MON.rows[i].s ? MON.rows[i].s[k] : '';
    if (!v || v === '无') return;
    if ((MON.selSeats[i] || {})[k]) td.classList.add('seat-selected');
    td.addEventListener('click', function () {
      MON.selSeats[i] = MON.selSeats[i] || {};
      if (MON.selSeats[i][k]) delete MON.selSeats[i][k]; else MON.selSeats[i][k] = true;
      td.classList.toggle('seat-selected', !!MON.selSeats[i][k]);
    });
  });
  // 全选
  var all = $('mSelAll');
  all.checked = n > 0 && rows.every(function (leg) { return MON.sel[MON.rows.indexOf(leg)]; });
  all.onchange = function () {
    rows.forEach(function (leg) { var i = MON.rows.indexOf(leg); if (all.checked) MON.sel[i] = true; else delete MON.sel[i]; });
    applyMonitor();
  };
  syncSelCount();
}
function syncSelCount() {
  var c = Object.keys(MON.sel).length;
  $('mSelCount').textContent = '已选 ' + c + ' 条';
  var show = c > 0 && (MON.batch || $('mPanel').classList.contains('task-pick-mode'));
  if (show && !MON.batch) $('mPanel').classList.add('batch-mode');
  if (!show && !MON.batch) $('mPanel').classList.remove('batch-mode');
  $('mSelBar').classList.toggle('open', c > 0);
}
function orderPush(leg) {
  APP.orderSel = APP.orderSel || [];
  APP.orderSel.push({ leg: leg, seats: MON.selSeats[MON.rows.indexOf(leg)] || {} });
}
function prefillNewTask(leg) {
  // 预填新建任务：区间 + 默认日期 + 默认席别（有票席别）
  $('ntPairs').innerHTML = '';
  addNtPair(leg.f, leg.to);
  if (!$('ntAccount').value) {
    // 选第一个在线账号
    var first = $('ntAccount').querySelector('option[value]');
    if (first) $('ntAccount').value = first.value;
    loadPassengersFor($('ntAccount').value);
  }
  var d = $('mDate').value;
  if (d && APP.selDates.indexOf(d) < 0) { APP.selDates.push(d); renderNtDates(); }
  var seats = [];
  ['second', 'first', 'business', 'hardSleeper', 'hardSeat'].forEach(function (k) {
    var name = ({ business: '商务座', first: '一等座', second: '二等座', hardSleeper: '硬卧', hardSeat: '硬座' })[k];
    var v = leg.s ? leg.s[k] : '';
    if (v && v !== '无' && name) seats.push(name);
  });
  if (!seats.length) seats = ['二等座'];
  if (APP.seats) APP.seats.forEach(function (n) { if (seats.indexOf(n) >= 0 && APP.selSeats.indexOf(n) < 0) APP.selSeats.push(n); });
  buildNtSeats();
  updateNtSummary();
}

/* ---------- 6. 确认订单 ---------- */
function renderOrderView() {
  var sels = APP.orderSel || [];
  $('oSelEmpty').style.display = sels.length ? 'none' : 'block';
  $('oSelections').innerHTML = sels.map(function (s, idx) {
    var leg = s.leg;
    var seats = ['business', 'first', 'second', 'hardSleeper', 'hardSeat', 'softSleeper', 'special'];
    var names = { business: '商务座', first: '一等座', second: '二等座', hardSleeper: '硬卧', hardSeat: '硬座', softSleeper: '软卧', special: '特等座' };
    return '<div class="task-selection-item">' +
      '<div class="train"><b>' + esc(leg.n) + '</b><small>' + esc(leg.tn) + '</small></div>' +
      '<div class="station"><b>' + esc(leg.f) + '  ' + esc(leg.d) + '</b><small>→ ' + esc(leg.to) + '  ' + esc(leg.a) + '</small></div>' +
      '<div class="task-seat-options">' + seats.map(function (k) {
        var v = leg.s ? leg.s[k] : '';
        var on = s.seats[k];
        return '<label class="task-seat-option chip ' + (on ? 'on' : '') + '" style="margin:0;background:' + (on ? 'var(--red-bg)' : 'var(--line-soft)') + ';border-radius:6px;font-size:11.5px;cursor:' + (v && v !== '无' ? 'pointer' : 'not-allowed') + ';color:' + (v && v !== '无' ? 'var(--text)' : 'var(--faint)') + ';display:flex;align-items:center;justify-content:center;height:30px"><span>' + names[k] + (v && v !== '无' ? '<small style="opacity:.7"> ' + esc(v === '有' ? '有' : v) + '</small>' : '') + '</span></label>';
      }).join('') + '</div>' +
      '<div style="display:flex;align-self:center"><button class="btn btn-ghost btn-sm" data-rm="' + idx + '">移除</button></div></div>';
  }).join('');
  $('oSelections').querySelectorAll('[data-rm]').forEach(function (b) {
    b.addEventListener('click', function () { APP.orderSel.splice(+b.dataset.rm, 1); renderOrderView(); });
  });
  updateOrderSummary();
}
function loadOrderPassengers(key) {
  if (!key) { $('oPassengers').innerHTML = '<span style="color:var(--faint)">请先选择账号</span>'; updateOrderSummary(); return; }
  api('/api/accounts/' + encodeURIComponent(key) + '/passengers').then(function (d) {
    var ps = d.passengers || [];
    $('oPassengers').innerHTML = ps.length ? ps.map(function (p, i) {
      return '<label class="order-person"><input type="checkbox" ' + (i === 0 ? 'checked' : '') + ' value="' + esc(p.name) + '"><span><b>' + esc(p.name) + ' · 成人票</b><small>' + esc(p.no || '') + '</small></span></label>';
    }).join('') : '<span style="color:var(--faint)">该账号暂无乘客</span>';
    updateOrderSummary();
  }).catch(function () { });
}
function orderPassengers() {
  return Array.prototype.map.call($('oPassengers').querySelectorAll('input:checked'), function (i) { return i.value; });
}
function orderSeatTotal() {
  var total = 0, cnt = 0;
  (APP.orderSel || []).forEach(function (s) {
    Object.keys(s.seats).forEach(function (k) {
      if (s.seats[k]) { var p = seatPrice(s.leg, k); if (p) total += p; cnt++; }
    });
  });
  return { total: total, cnt: cnt };
}
function updateOrderSummary() {
  var acc = $('oAccount').value, ps = orderPassengers(), t = orderSeatTotal();
  var trip = (APP.orderSel || []).map(function (s) { return esc(s.leg.n) + ' ' + esc(s.leg.d); }).join('、');
  $('oSummary').innerHTML =
    row('车次 / 席别', trip || '未选择') +
    row('席别数量', t.cnt + ' 个') +
    row('账号', esc(acc || '未选')) +
    row('乘客', ps.length ? esc(ps.join('、')) : '未选') +
    row('预计金额', '约 ¥' + (t.total * (ps.length || 1)), '') ;
}

/* ---------- 7. 账号 ---------- */
/* P2 写操作辅助 */
function jobToggle(id, active, btn, reloadFn) {
  if (btn) { btn.disabled = true; }
  api('/api/jobs/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ is_active: !!active }) })
    .then(function () {
      toast(active ? '任务已启动' : '任务已暂停', 'ok');
      loadJobs(); loadDashboard();
      if (reloadFn) reloadFn();
    })
    .catch(function (e) { toast(e.message, 'err'); if (btn) btn.disabled = false; });
}
function jobsBatchAct(active) {
  var ids = Array.prototype.map.call(document.querySelectorAll('#jobsList .job [data-act="toggle"]'), function (b) { return b.dataset.id; });
  if (!ids.length) { toast('没有可操作的运行任务', 'err'); return; }
  api('/api/jobs/toggle', { method: 'POST', body: JSON.stringify({ ids: ids, active: active }) })
    .then(function () { toast(active ? '已启动全部任务' : '已暂停全部任务', 'ok'); loadJobs(); loadDashboard(); })
    .catch(function (e) { toast(e.message, 'err'); });
}
function collectNtForm() {
  return {
    name: $('ntName').value.trim(),
    account_key: $('ntAccount').value || '',
    left_dates: APP.selDates || [],
    stations: ntPairs(),
    members: APP.paxSel || [],
    allow_less_member: !!$('ntLessMember').checked,
    seats: APP.selSeats || [],
    train_numbers: ntTags('ntTrainBox'),
    except_train_numbers: ntTags('ntExceptBox'),
    period_from: $('ntFromT').value,
    period_to: $('ntToT').value,
    interval_min: parseFloat($('ntIntMin').value) || 1,
    interval_max: parseFloat($('ntIntMax').value) || 1
  };
}
function createNewTask(btn) {
  var f = collectNtForm();
  if (!f.account_key) { toast('请选择使用账号（先到「账号管理」登录）', 'err'); return; }
  if (!f.left_dates.length) { toast('请至少选择一个出行日期', 'err'); return; }
  if (!f.stations.length) { toast('请填写出发/到达区间', 'err'); return; }
  var picked = APP.taskPicked || [];
  var pickedTrains = [];
  picked.forEach(function (s) { if (pickedTrains.indexOf(s.leg.n) < 0) pickedTrains.push(s.leg.n); });
  var pickedSeats = {};
  picked.forEach(function (s) { s.seats.forEach(function (nm) { pickedSeats[nm] = true; }); });
  if (picked.length) {
    if (pickedTrains.length) f.train_numbers = pickedTrains;
    if (Object.keys(pickedSeats).length) f.seats = Object.keys(pickedSeats);
  }
  if (!f.seats.length) { toast('请至少选择一种席别', 'err'); return; }
  if (btn) btn.disabled = true;
  api('/api/jobs', { method: 'POST', body: JSON.stringify(f) })
    .then(function (d) {
      APP.taskPicked = [];
      toast('任务已创建并开始抢票', 'ok');
      go('jobs');
    })
    .catch(function (e) { toast(e.message, 'err'); })
    .finally(function () { if (btn) btn.disabled = false; });
}
var SEAT_NAME = { business: '商务座', first: '一等座', second: '二等座', hardSleeper: '硬卧', hardSeat: '硬座', softSleeper: '软卧', special: '特等座', noSeat: '无座' };
function batchCreateFromMonitor(btn) {
  var sel = Object.keys(MON.sel).map(Number).sort(function (a, b) { return a - b; });
  if (!sel.length) { toast('请先勾选车次（可用「批量」模式选择）', 'err'); return; }
  var account_key = $('ntAccount').value || '';
  if (!account_key) { toast('请先选择账号（可到「账号管理」登录后再试）', 'err'); return; }
  var date = $('mDate').value;
  var batchErr = null;
  var jobs = sel.map(function (i) {
    var leg = MON.rows[i];
    var seatList = Object.keys(MON.selSeats[i] || {}).map(function (k) { return SEAT_NAME[k]; }).filter(Boolean);
    if (!seatList.length) seatList = ['二等座', '一等座'];
    return {
      name: leg.n + ' ' + leg.f + '→' + leg.to,
      account_key: account_key,
      left_dates: date ? [date] : (APP.selDates || []),
      stations: [{ left: leg.f, arrive: leg.to }],
      members: APP.paxSel || [],
      allow_less_member: !!$('ntLessMember').checked,
      seats: seatList,
      train_numbers: [leg.n],
      except_train_numbers: [],
      period_from: '00:00', period_to: '24:00', interval_min: 1, interval_max: 1
    };
  });
  if (btn) { btn.disabled = true; }
  var done = 0;
  jobs.forEach(function (f) {
    api('/api/jobs', { method: 'POST', body: JSON.stringify(f) })
      .catch(function (e) { batchErr = e.message; })
      .finally(function () {
        done++;
        if (done === jobs.length) {
          if (btn) { btn.disabled = false; }
          if (batchErr) { toast(batchErr, 'err'); }
          else { toast('已创建 ' + jobs.length + ' 个抢票任务', 'ok'); go('jobs'); }
        }
      });
  });
}
function loadAccounts() {
  api('/api/accounts').then(function (d) {
    $('accCnt').textContent = '共 ' + d.accounts.length + ' 个';
    var online = d.accounts.filter(function (a) { return a.is_ready; }).length;
    $('accList').innerHTML = d.accounts.length ? d.accounts.map(function (a) {
      var status = a.is_ready ? '<span class="tag ok"><span class="d"></span>在线 · 已就绪</span>' : a.key ? '<span class="tag warn">' + (a.login_ok ? '离线 · 待恢复' : '未登录完成') + '</span>' : '<span class="tag warn">待登录</span>';
      var typeTag = a.type === 'qr' ? '<span class="tag info">扫码登录</span>' : '<span class="tag muted">账号密码</span>';
      return '<tr><td><div class="cell-user"><span class="av" style="width:32px;height:32px;font-size:13px">' + esc((a.user_name || '?').slice(0, 1)) + '</span><span><b>' + esc(a.user_name || '未同步') + '</b><small>key: ' + esc(a.key) + '</small></span></div></td>' +
        '<td>' + typeTag + '</td><td>' + status + '</td>' +
        '<td>' + (a.passenger_count ? esc(a.passenger_count) + ' 位乘客' : '<span style="color:var(--faint)">—</span>') + '</td>' +
        '<td style="color:var(--faint)">' + esc(a.last_heartbeat || '—') + '</td>' +
        '<td style="text-align:right;white-space:nowrap"><button class="btn btn-outline btn-sm acc-act" data-act="rescan" data-key="' + a.key + '">重新扫码</button> <button class="btn btn-outline btn-sm acc-act" data-act="logout" data-key="' + a.key + '">登出</button> <button class="btn btn-ghost btn-sm acc-act" data-act="del" data-key="' + a.key + '">删除</button></td></tr>';
    }).join('') : '<tr><td colspan="6" class="empty" style="border:0"><b>还没有 12306 账号</b>在右侧面板扫码或输密码添加，登录成功后自动拉取乘客。</td></tr>';
    $('accList').querySelectorAll('.acc-act').forEach(function (b) {
      b.addEventListener('click', function () { accAction(b.dataset.act, b.dataset.key, b); });
    });
  }).catch(function (e) { toast(e.message, 'err'); });
}
function accAction(act, key, btn) {
  if (btn) { btn.disabled = true; }
  var done = function (ok, msg) { if (btn) { btn.disabled = false; } if (msg) { toast(msg, ok ? 'ok' : 'err'); } loadAccounts(); loadDashboard(); if (act === 'rescan' && ok) openQrPanel(key); };
  var finish = function (e) { if (e && e.message) done(false, e.message); else done(true, null); };
  if (act === 'logout') {
    if (!confirm('确认登出该账号？')) return;
    api('/api/accounts/' + encodeURIComponent(key) + '/logout', { method: 'POST', body: '{}' }).then(function () { finish(); }).catch(finish);
  } else if (act === 'rescan') {
    api('/api/accounts/' + encodeURIComponent(key) + '/rescan', { method: 'POST', body: '{}' }).then(function () { finish(); }).catch(finish);
  } else if (act === 'del') {
    if (!confirm('确认删除该账号及本地会话？')) return;
    api('/api/accounts/' + encodeURIComponent(key), { method: 'DELETE' }).then(function () { finish(); }).catch(finish);
  }
}

/* ---------- 添加账号（P2） ---------- */
var QR = { key: null, uuid: null, timer: null, statusEl: null, boxEl: null, holder: null, btn: null };
function resetAddPanel() {
  if (QR.timer) { clearInterval(QR.timer); QR.timer = null; }
  $('accQrBox').innerHTML = '<div style="text-align:center;color:var(--faint);font-size:12px" id="accQrPlaceholder">点击下方按钮生成二维码</div>';
  $('accQrStatus').textContent = '—';
  $('accPwdUser').value = ''; $('accPwdPass').value = '';
}
function openQrPanel(key) {
  var pwdTab = $('accTabPwd');
  $('accTabQr').classList.add('on');
  if (pwdTab) pwdTab.classList.remove('on');
  $('accQrZone').classList.remove('hidden');
  $('accPwdZone').classList.add('hidden');
  QR.key = key || QR.key;
}
function startQr() {
  if (QR.key) { runQrSession(QR.key); return; }
  // 先建一个 qr 账号再出码（扫码成功后才标记 login_ok 并发布）
  api('/api/accounts', { method: 'POST', body: JSON.stringify({ type: 'qr' }) })
    .then(function (d) { QR.key = d.key; $('accPwdUser').value = ''; runQrSession(QR.key); })
    .catch(function (e) { toast(e.message, 'err'); });
}
function runQrSession(key) {
  resetAddPanel();
  QR.key = key;
  openQrPanel(key);
  if (QR.timer) { clearInterval(QR.timer); QR.timer = null; }
  if (QR.holder) { QR.holder.onchange = null; }
  QR.statusEl = $('accQrStatus'); QR.boxEl = $('accQrBox');
  QR.statusEl.textContent = '二维码生成中…';
  api('/api/accounts/' + encodeURIComponent(key) + '/qr/start')
    .then(function (d) {
      QR.uuid = d.uuid;
      QR.boxEl.classList.add('has-img');
      QR.boxEl.innerHTML = '<img class="qr-img" alt="登录二维码" src="data:image/png;base64,' + d.image + '">';
      var holder = document.createElement('input');
      holder.type = 'text'; holder.placeholder = '扫码后按回车确认';
      holder.style.cssText = 'width:100%;margin-top:10px';
      QR.boxEl.appendChild(holder);
      holder.focus();
      QR.holder = holder;
      var fireCheck = function () { checkQr(); };
      holder.addEventListener('keydown', function (e) { if (e.key === 'Enter') fireCheck(); });
      holder.addEventListener('change', fireCheck);
      QR.statusEl.textContent = '请用 12306 App 扫码，扫完按回车或用确认按钮';
      QR.timer = setInterval(checkQr, 4000);
    })
    .catch(function (e) {
      QR.boxEl.classList.remove('has-img');
      QR.boxEl.innerHTML = '<div style="text-align:center;color:var(--red);font-size:12px">二维码生成失败：' + esc(e.message) + '</div>';
      QR.statusEl.textContent = '生成失败，可点击重新生成';
    });
}
function checkQr() {
  if (!QR.key || !QR.uuid) return;
  api('/api/accounts/' + encodeURIComponent(QR.key) + '/qr/check')
    .then(function (d) {
      var st = d.state;
      if (st === 'success') {
        stopQrPoll();
        QR.boxEl.classList.remove('has-img');
        QR.boxEl.innerHTML = '<div style="text-align:center;color:var(--ok);font-size:13px"><b>登录成功</b><br>' + esc(d.user_name || '') + '</div>';
        QR.statusEl.textContent = '账号已就绪，乘客已拉取';
        toast('账号登录成功', 'ok');
        resetAddPanel();
        loadAccounts(); loadAccountsForNew(); loadDashboard();
      } else if (st === 'confirm') {
        QR.statusEl.textContent = '已扫码，请在手机 12306 上点击确认登录';
        if (QR.holder) QR.holder.focus();
      } else if (st === 'expired' || st === 'error') {
        stopQrPoll();
        QR.statusEl.textContent = '二维码已失效，请重新生成';
      } else if (st === 'pending') {
        if (!/已扫码/.test(QR.statusEl.textContent || '')) QR.statusEl.textContent = '等待扫码…';
      }
    }).catch(function () { /* 忽略单次轮询失败 */ });
}
function stopQrPoll() {
  if (QR.timer) { clearInterval(QR.timer); QR.timer = null; }
  if (QR.holder) { QR.holder.onchange = null; }
}
function addPwdAccount() {
  var user = $('accPwdUser').value.trim(), pwd = $('accPwdPass').value;
  if (!user) { toast('请输入手机号 / 用户名', 'err'); return; }
  if (!pwd) { toast('请输入密码', 'err'); return; }
  api('/api/accounts', { method: 'POST', body: JSON.stringify({ type: 'pwd', user_name: user, password: pwd }) })
    .then(function (d) {
      var key = d.key;
      toast('账号已创建，正在登录…', '', 4000);
      api('/api/accounts/' + encodeURIComponent(key) + '/login', { method: 'POST', body: '{}' })
        .then(function (r) {
          toast('账号登录成功：' + (r.user_name || user), 'ok');
          resetAddPanel();
          loadAccounts(); loadAccountsForNew(); loadDashboard();
        })
        .catch(function (e) {
          toast('登录失败：' + e.message + '（账号已创建，可稍后在列表中重新登录）', 'err');
          loadAccounts();
        });
    })
    .catch(function (e) { toast(e.message, 'err'); });
}

/* ---------- 8. 日志 ---------- */
var logPaused = false, logLevel = '', logQ = '';
function loadLogs() {
  var p = new URLSearchParams({ limit: 300 });
  if (logLevel) p.set('level', logLevel);
  if (logQ) p.set('q', logQ);
  api('/api/logs?' + p).then(function (d) {
    var term = $('logTerm');
    var before = term.scrollTop, atBottom = term.scrollHeight - before - term.clientHeight < 40;
    $('logCnt').textContent = 'runtime webx.log · 尾部 ' + d.lines.length + ' / 共 ' + d.total + ' 行';
    term.innerHTML = d.lines.map(function (l) {
      var m = l.match(/^\[(\d{4}-\d{2}-\d{2}[ T]?\d{2}:\d{2}:\d{2})\]\s*/);
      var ts = m ? m[1] : '', body = m ? l.slice(m[0].length) : l;
      var cls = logLineClass(body);
      return '<div class="' + cls + '"><span class="ts">' + esc(ts) + '</span>' + esc(body) + '</div>';
    }).join('') || '<div class="l-OK">（空）</div>';
    if (atBottom) term.scrollTop = term.scrollHeight;
  }).catch(function () { });
}
function logTermColor(l) {
  if (/错误|失败|Error|Exception|放弃/i.test(l)) return 'l-ERROR';
  if (/命中|订单|EVENT/.test(l)) return 'l-EVENT';
  return 'l-INFO';
}

/* ---------- 9. 设置 ---------- */
function loadSettings() {
  api('/api/settings').then(function (d) {
    var c = d.config, st = d.state || {};
    var cards = [];
    function fldLabel(label, path, extra) {
      var v = deepGet(c, path);
      var isSecret = !!deepGet(st, path);
      var stv = deepGet(st, path) || {};
      var maxW = 'max-width:340px';
      var field;
      var numPaths = ['query.interval', 'user.heartbeat_interval', 'query.request_max_retry', 'query.job_timeout', 'cdn.check_time_out', 'server.port', 'cluster.redis_port'];
      var isBool = typeof v === 'boolean' || /enabled|allow/.test(path) || (typeof v === 'number' && numPaths.indexOf(path) < 0);
      if (isBool) {
        var on = v === 1 || v === true;
        field = '<label class="switch-row"><span style="font-size:13px">' + label + '</span><label class="tgl"><input type="checkbox" data-path="' + path + '"' + (on ? ' checked' : '') + '><i></i></label></label>';
      } else if (typeof v === 'number') {
        field = '<div class="f-col" style="max-width:220px"><div class="f-lab">' + label + '</div><input class="ctl" type="number" step="any" data-path="' + path + '" value="' + v + '"></div>';
      } else {
        var input = isSecret
          ? '<input class="ctl" type="password" data-path="' + path + '" placeholder="' + (stv.configured ? '已配置 ' + esc(stv.tail || '') + '（留空不改）' : '未配置') + '">'
          : '<input class="ctl" type="text" data-path="' + path + '" value="' + esc(v || '') + '">';
        field = '<div class="f-col" style="' + maxW + '"><div class="f-lab">' + label + '</div>' + input + '</div>';
      }
      return field;
    }
    cards.push(setCard('查询与网络', [
      fldLabel('查询间隔(秒)', 'query.interval'),
      fldLabel('请求重试次数', 'query.request_max_retry'),
      fldLabel('账号心跳间隔(秒)', 'user.heartbeat_interval'),
      fldLabel('多线程查询', 'query.thread_enabled'),
      fldLabel('启用 CDN', 'cdn.enabled'),
      fldLabel('日志写入文件', 'log.to_file')
    ]));
    cards.push(setCard('通知渠道（命中/下单提醒）', [
      fldLabel('短信语音（钉钉信控）', 'notification.voice_code.enabled'),
      fldLabel('渠道', 'notification.voice_code.type'),
      fldLabel('AppCode', 'notification.voice_code.app_code'),
      fldLabel('钉钉', 'notification.dingtalk.enabled'),
      fldLabel('Webhook', 'notification.dingtalk.webhook'),
      fldLabel('Telegram', 'notification.telegram.enabled'),
      fldLabel('接入地址', 'notification.telegram.bot_api_url'),
      fldLabel('Server酱', 'notification.serverchan.enabled'),
      fldLabel('SendKey', 'notification.serverchan.key'),
      fldLabel('PushBear', 'notification.pushbear.enabled'),
      fldLabel('Key', 'notification.pushbear.key'),
      fldLabel('Bark', 'notification.bark.enabled'),
      fldLabel('Push URL', 'notification.bark.push_url'),
      fldLabel('邮件', 'notification.email.enabled'),
      fldLabel('发件人', 'notification.email.sender'),
      fldLabel('收件人', 'notification.email.receiver'),
      fldLabel('SMTP 主机', 'notification.email.host'),
      fldLabel('SMTP 账号', 'notification.email.user'),
      fldLabel('SMTP 密码', 'notification.email.password')
    ]));
    cards.push(setCard('集群与节点', [
      fldLabel('启用集群', 'cluster.enabled'),
      fldLabel('本节点可当选 Master', 'cluster.node_is_master'),
      fldLabel('从节点可晋升', 'cluster.node_slave_can_be_master'),
      fldLabel('节点名', 'cluster.node_name'),
      fldLabel('Redis 主机', 'cluster.redis_host'),
      fldLabel('Redis 端口', 'cluster.redis_port'),
      fldLabel('Redis 密码', 'cluster.redis_password')
    ]));
    // 网页与服务
    cards.push(setCard('网页与服务', [
      '<div class="f-col" style="max-width:260px"><div class="f-lab">管理台用户名（不可改）</div><input class="ctl" type="text" value="' + esc(c.web.username) + '" disabled></div>',
      '<div class="f-col" style="max-width:240px"><div class="f-lab">重置管理台密码（留空不改）</div><input class="ctl" type="password" data-path="web.password" placeholder="新密码 ≥6 位"></div>',
      '<div class="f-col" style="max-width:160px"><div class="f-lab">服务监听地址</div><input class="ctl" type="text" data-path="server.host" value="' + esc(c.server.host) + '"></div>',
      '<div class="f-col" style="max-width:120px"><div class="f-lab">服务端口</div><input class="ctl" type="number" data-path="server.port" value="' + c.server.port + '"></div>',
      '<div class="f-col" style="max-width:200px"><div class="f-lab">验证码平台</div><input class="ctl" type="text" data-path="auth_code.platform" value="' + esc(c.auth_code.platform || '') + '"></div>',
      '<div class="f-col" style="max-width:220px"><div class="f-lab">验证码 API 地址</div><input class="ctl" type="text" data-path="auth_code.api" value="' + esc(c.auth_code.api || '') + '"></div>',
      '<div class="f-col" style="max-width:180px"><div class="f-lab">验证码账号</div><input class="ctl" type="text" data-path="auth_code.account.user" value="' + esc((c.auth_code.account || {}).user || '') + '"></div>',
      '<div class="f-col" style="max-width:180px"><div class="f-lab">验证码密码</div><input class="ctl" type="password" data-path="auth_code.account.pwd" placeholder="已配置（留空不改）"></div>'
    ]));
    // RAIL 设备缓存
    cards.push(setCard('RAIL 设备缓存', [
      '<div class="f-col" style="max-width:220px"><div class="f-lab">设备 ID（留空自动）</div><input class="ctl" type="text" data-path="rail.device_id" value="' + esc(c.rail.device_id || '') + '"></div>',
      '<div class="f-col" style="max-width:220px"><div class="f-lab">设备过期值</div><input class="ctl" type="text" data-path="rail.expiration" value="' + esc(c.rail.expiration || '') + '"></div>'
    ]));
    $('setGrid').innerHTML = cards.join('') + '<div class="set-note">配置持久化于 runtime/webx.json（chmod 600）。保存后立即生效，无需重启；密钥类字段留空表示保持原值。日志文件：' + esc((c.log.path || '') + (c.log.path_exists ? '（存在）' : '（未生成）')) + '</div>';
  }).catch(function (e) { toast(e.message, 'err'); });
}
function deepGet(obj, path) {
  var cur = obj;
  path.split('.').forEach(function (p) { cur = (cur == null || typeof cur !== 'object') ? undefined : cur[p]; });
  return cur;
}
function setCard(title, fields) {
  return '<div class="card"><div class="card-h"><h3>' + title + '</h3></div><div style="padding:14px 18px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 18px">' + fields.join('') + '</div></div>';
}

/* ---------- 站点绑定（静态） ---------- */
function wireStatic() {
  // 导航
  document.querySelectorAll('[data-view]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      var v = a.dataset.view;
      if (v === 'new') { prefillNewFromMonitor(); }
      go(v);
    });
  });
  // 登录
  $('loginBtn').addEventListener('click', doLogin);
  $('loginPwd').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  $('logoutBtn').addEventListener('click', function () {
    showLogin();
    $('loginPwd').value = '';
    toast('已退出登录');
  });
  // 任务写操作
  $('jobsPauseAll').addEventListener('click', function () { jobsBatchAct(false); });
  $('taskFlowNext').addEventListener('click', function () { createNewTask(this); });
  // 新建任务（task-flow 布局）
  $('taskHeaderBack').addEventListener('click', function () { go('jobs'); });
  $('taskOpenTicketQuery').addEventListener('click', function () { go('monitor', { pick: true }); });
  $('ntAddPair').addEventListener('click', function () { addNtPair(); });
  $('ntAccount').addEventListener('change', function () { loadPassengersFor($('ntAccount').value); updateNtSummary(); });
  ['ntName', 'ntIntMin', 'ntIntMax', 'ntFromT', 'ntToT', 'ntLessMember'].forEach(function (id) {
    $(id).addEventListener('input', updateNtSummary);
    $(id).addEventListener('change', updateNtSummary);
  });
  wireTagbox('ntTrainBox', 'ntTrainInput');
  wireTagbox('ntExceptBox', 'ntExceptInput');
  // 车站联想
  bindStationSuggest($('mFrom'));
  bindStationSuggest($('mTo'));
  // 监控（车票查询）
  $('mSearch').addEventListener('click', doMonitorSearch);
  $('mFrom').addEventListener('keydown', function (e) { if (e.key === 'Enter') doMonitorSearch(); });
  $('mTo').addEventListener('keydown', function (e) { if (e.key === 'Enter') doMonitorSearch(); });
  $('mBatchToggle').addEventListener('click', function () {
    MON.batch = !MON.batch;
    $('mPanel').classList.toggle('batch-mode', MON.batch);
    $('mBatchToggle').classList.toggle('is-active', MON.batch);
    $('mBatchToggle').setAttribute('aria-pressed', MON.batch ? 'true' : 'false');
  });
  $('mBatchCreate').addEventListener('click', function () { batchCreateFromMonitor(this); });
  $('mFloatBind').addEventListener('click', openTaskBindModal);
  $('mBatchBind').addEventListener('click', openTaskBindModal);
  $('mFloatAddTask').addEventListener('click', pickAddToTask);
  $('mFloatPrefill').addEventListener('click', function () {
    var sel = Object.keys(MON.sel).map(Number).sort(function (a, b) { return a - b; });
    if (!sel.length) { toast('请先勾选车次', 'err'); return; }
    sel.forEach(function (i) { prefillNewTask(MON.rows[i]); });
    go('new');
  });
  $('mSelReset').addEventListener('click', function () { MON.sel = {}; MON.selSeats = {}; applyMonitor(); });
  // 批量关联弹窗
  $('closeTaskModal').addEventListener('click', function () { closeTaskBindModal(); });
  $('cancelTaskModal').addEventListener('click', function () { closeTaskBindModal(); });
  $('confirmTaskBind').addEventListener('click', confirmTaskBind);
  // 订单
  $('oBack').addEventListener('click', function () { go('monitor'); });
  $('oAccount').addEventListener('change', function () { loadOrderPassengers($('oAccount').value); });
  $('oPassengers').addEventListener('change', updateOrderSummary);
  $('oSubmit').addEventListener('click', function () { toast('下单接口将在下一批（P3）实现', '', 2800); });
  // 账号
  function showAddPanel() {
    var panel = document.querySelector('#view-accounts .addacc');
    if (!panel) return;
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  $('accAdd').addEventListener('click', function () { resetAddPanel(); QR.key = null; showAddPanel(); var u = $('accPwdUser'); if (u) u.focus(); });
  $('accPanelClose').addEventListener('click', function () { QR.key = null; stopQrPoll(); resetAddPanel(); });
  $('accQrStart').addEventListener('click', function () {
    if (!$('accPwdZone').classList.contains('hidden')) { addPwdAccount(); }
    else { startQr(); }
  });
  $('accTabQr').addEventListener('click', function () {
    $('accTabQr').classList.add('on'); $('accTabPwd').classList.remove('on');
    $('accQrZone').classList.remove('hidden'); $('accPwdZone').classList.add('hidden');
    resetAddPanel();
    var b = $('accQrStart'); if (b) b.textContent = '生成登录二维码';
  });
  $('accTabPwd').addEventListener('click', function () {
    $('accTabPwd').classList.add('on'); $('accTabQr').classList.remove('on');
    stopQrPoll();
    $('accPwdZone').classList.remove('hidden'); $('accQrZone').classList.add('hidden');
    var b = $('accQrStart'); if (b) b.textContent = '登录并添加账号';
  });
  // 日志
  document.querySelectorAll('.lv-chip[data-lv]').forEach(function (ch) {
    ch.addEventListener('click', function () {
      document.querySelectorAll('.lv-chip[data-lv]').forEach(function (x) { x.classList.remove('on'); });
      ch.classList.add('on');
      logLevel = ch.dataset.lv;
      loadLogs();
    });
  });
  var searchTimer;
  $('logSearch').addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { logQ = $('logSearch').value.trim(); loadLogs(); }, 300);
  });
  $('logPause').addEventListener('click', function () {
    logPaused = !logPaused;
    $('logPause').textContent = logPaused ? '恢复滚动' : '暂停滚动';
    stopAllPolling(); startPolling();
  });
  // 下载需要 token：改用 fetch blob
  $('logDownload').addEventListener('click', function (e) {
    e.preventDefault();
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/logs/download?n=5000', true);
    xhr.setRequestHeader('Authorization', 'Bearer ' + token());
    xhr.responseType = 'blob';
    xhr.onload = function () {
      if (xhr.status !== 200) return;
      var url = URL.createObjectURL(xhr.response);
      var a = document.createElement('a');
      a.href = url; a.download = 'webx_tail.log';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    };
    xhr.send();
  });
  // 设置
  $('setSave').addEventListener('click', saveSettings);
}
function collectSettings() {
  var cfg = {};
  function setPath(path, value) {
    var cur = cfg;
    var parts = path.split('.');
    for (var i = 0; i < parts.length - 1; i++) { cur[parts[i]] = cur[parts[i]] || {}; cur = cur[parts[i]]; }
    cur[parts[parts.length - 1]] = value;
  }
  document.querySelectorAll('#view-settings [data-path]').forEach(function (inp) {
    var p = inp.dataset.path;
    if (inp.type === 'checkbox') setPath(p, inp.checked ? 1 : 0);
    else if (inp.type === 'number') { var n = inp.value === '' ? null : Number(inp.value); if (n !== null && !isNaN(n)) setPath(p, n); }
    else setPath(p, inp.value);
  });
  // 用户名不可改
  delete (cfg.web && cfg.web.username);
  return cfg;
}
function saveSettings() {
  var btn = $('setSave'); btn.disabled = true;
  var cfg = collectSettings();
  api('/api/settings', { method: 'POST', body: JSON.stringify({ config: cfg }) })
    .then(function (d) {
      toast(d.password_reset ? '设置已保存，管理台密码已重置，请重新登录' : '设置已保存并生效', 'ok');
      if (d.password_reset) { /* 后端已改口令；当前 token 仍有效，下次登录用新密码 */ loadSettings(); }
    })
    .catch(function (e) { toast(e.message, 'err'); })
    .finally(function () { btn.disabled = false; });
}
function prefillNewFromMonitor() {
  // 若监控页选了车次，则进入 new 时保留现有表单
}

/* ---------- init ---------- */
document.addEventListener('DOMContentLoaded', function () {
  wireStatic();
  var t = token();
  var u = localStorage.getItem(USERNAME_KEY);
  if (t) {
    api('/api/auth/me').then(function (d) {
      showApp(d.username || u);
    }).catch(function (e) { if (e.message === 'unauthorized') showLogin(); });
  } else showLogin();
});
})();
