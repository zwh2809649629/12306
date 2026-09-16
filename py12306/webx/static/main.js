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
// 后端 last_heartbeat 是 unix 秒；直接渲染会出现裸时间戳（1789493802）
function fmtAgo(ts) {
  if (!ts) return '—';
  var sec = Math.floor(Date.now() / 1000) - Number(ts);
  if (!isFinite(sec)) return String(ts);
  if (sec < 0) sec = 0;
  if (sec < 60) return sec + ' 秒前';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
  if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
  return Math.floor(sec / 86400) + ' 天前';
}

/* ---------- 席别票价（与原型一致） ---------- */
function seatPrice(leg, k) {
  var high = leg.tn === '高铁' || leg.tn === '动车';
  // 注意：这是**估算**（按历时 × 单价），长距离会明显偏低，仅供参考。
  // 按「一个席别一个基准单价」给全：之前把卧铺/硬座只放在非高铁分支，
  // 导致动车（D 字头，带卧铺）的硬卧/软卧拿不到价格。
  var rates = {};
  if (high) { rates.business = 3.1; rates.first = 1.65; rates.second = .82; rates.special = 2.1; }
  rates.noSeat = high ? .82 : .21;      // 高铁无座 = 二等座价；普速无座 = 硬座价
  rates.hardSleeper = .43; rates.softSleeper = .63; rates.hardSeat = .21;
  var minutes = leg.m;
  if (minutes == null) {
    var d = +leg.d.slice(0, 2) * 60 + +leg.d.slice(3, 5);
    var a = +leg.a.slice(0, 2) * 60 + +leg.a.slice(3, 5);
    minutes = a - d; if (minutes < 0) minutes += 1440;
  }
  var r = rates[k]; if (!r) return null;
  return Math.max(12, Math.round(minutes * r));
}
// 席别取值语义（与后端约定）：'/'(或不设) = 该车不设此席别；'无' = 有该席别但无票；'有'/数字 = 可购
function seatOffered(leg, k) {          // 该车是否提供此席别（可用于任务等待）
  var v = leg && leg.s ? leg.s[k] : undefined;
  return !!v && v !== '/';
}
function seatHasTicket(v) {              // 当前是否真有余票
  return !!v && v !== '/' && v !== '无' && v !== '候补';
}
function seatCell(leg, k) {
  var v = leg.s ? leg.s[k] : undefined;
  // 不设座：用 '/' 表示，不给票价、不可选
  if (!seatOffered(leg, k)) {
    return '<td class="seat seat-absent" data-seat="' + k + '" title="该车次不设此席别"><strong class="absent">/</strong></td>';
  }
  var price = seatPrice(leg, k);
  var inner;
  if (v == null || v === '') inner = '<strong class="none">无</strong>';
  else if (v === '无') inner = '<strong class="none">无</strong>';
  else if (v === '有') inner = '<strong>有</strong>';
  else if (v === '候补') inner = '<strong class="wait">候补</strong>';
  else inner = '<strong>' + esc(v) + '</strong>';
  if (price) inner += '<small class="seat-price">约 ¥' + price + '</small>';
  return '<td class="seat" data-seat="' + k + '">' + inner + '</td>';
}
function rowHtml(leg) {
  var i = MON.rows.indexOf(leg);
  var rowCls = 'ticket-row' + (leg.bookable ? ' hit' : '');
  return '<tr class="' + rowCls + '" data-i="' + i + '">' +
    '<td class="train"><b>' + esc(leg.n) + '</b><small>' + esc(leg.tn) + '</small></td>' +
    legCell(leg.f, leg.d) +
    legCell(leg.to, leg.a) +
    '<td class="duration">' + fmtDur(leg.m) + '</td>' +
    MON_SEAT_KEYS.map(function (k) { return seatCell(leg, k); }).join('') +
    '<td class="actions">' +
      '<span class="row-pick"><input class="row-check" type="checkbox" data-i="' + i + '"' + (MON.sel[i] ? ' checked' : '') + '></span>' +
      '<button class="btn btn-outline" data-act="book">预定</button>' +
      '<button class="btn btn-ghost" data-act="prefill">新建任务</button>' +
    '</td></tr>';
}
// 出发/到达：站名 + 对应时间合并在一栏（去掉冗余的单独时间列）
function legCell(station, time) {
  return '<td class="leg"><b>' + esc(station) + '</b><span class="lt">' + esc(time) + '</span></td>';
}
// 该车次【可参与抢票】的席别 key（含无票——任务可等它放票；排除不设座）
function availableSeatKeys(leg) {
  if (!leg || !leg.s) return [];
  return MON_SEAT_KEYS.filter(function (k) { return seatOffered(leg, k); });
}
// 把已保存的席别选中状态回写到该行单元格
function paintRowSeats(i, tr) {
  if (!tr) return;
  tr.querySelectorAll('td.seat').forEach(function (td) {
    var k = td.dataset.seat;
    var v = MON.rows[i] && MON.rows[i].s ? MON.rows[i].s[k] : '';
    if (!seatOffered(MON.rows[i], k)) return;   // 不设座不参与选中态回写
    td.classList.toggle('seat-selected', !!(MON.selSeats[i] || {})[k]);
  });
}
// 是否处于「批量选择」界面（批量按钮打开，或从新建任务页的「添加到任务」进入）
function inBatchUI() {
  return !!MON.batch || $('mPanel').classList.contains('task-pick-mode');
}
// 勾选车次 → 默认复选该行【全部】有票席别；取消勾选 → 清空该行席别
function selectRow(i, on) {
  if (on) {
    MON.sel[i] = true;
    MON.selSeats[i] = {};
    availableSeatKeys(MON.rows[i]).forEach(function (k) { MON.selSeats[i][k] = true; });
    // 记住来源：复选框 = 「默认全部」语义（提交时补上表格没列的软卧/特等座）
    MON.selBy[i] = 'check';
  } else {
    delete MON.sel[i];
    delete MON.selBy[i];
    MON.selSeats[i] = {};
  }
}
// 同一车次号在查询结果里可能出现多行（不同到达站 / 不同出发站的余票分区，
// 如 G1025→深圳北 与 G1025→福田）。而引擎的车次白名单只有车次号，
// 所以勾选/取消必须整组进行，否则会出现「G1025 的 A 行勾着、B 行没勾」这种自相矛盾的状态
function sameTrainIndexes(i) {
  var n = MON.rows[i] && MON.rows[i].n, out = [i];
  MON.rows.forEach(function (r, k) { if (k !== i && r.n === n) out.push(k); });
  return out;
}
// 勾选/取消某行 → 同车次号的所有行一起处理（复选框与席别都跟随）
function setRowChecked(i, on) {
  sameTrainIndexes(i).forEach(function (k) {
    selectRow(k, on);
    var tr = document.querySelector('#mResults tr[data-i="' + k + '"]');
    var cb = tr && tr.querySelector('input.row-check');
    if (cb) cb.checked = on;
    paintRowSeats(k, tr);
  });
}
// 由席别反推复选框：只要还有席别被选中就勾上，全部取消则自动取消勾选
function syncRowCheckFromSeats(i, tr) {
  if (!tr) return;
  var any = Object.keys(MON.selSeats[i] || {}).length > 0;
  var cb = tr.querySelector('input.row-check');
  if (cb) cb.checked = any;
  if (any) MON.sel[i] = true; else delete MON.sel[i];
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
  // 编辑态只在「编辑流程」里保留（ctx.keepEdit）；其它任何进出新建页的路径都回到「新建」语义
  if (view !== 'new' && APP.editJobId) clearJobEdit();
  if (view === 'new') {
    if (!(ctx && ctx.keepEdit)) clearJobEdit();
    refreshNewView();
    if (ctx && ctx.job) { applyJobToForm(ctx.job); setEditMode(true); }
  }
  if (view === 'detail' && ctx && ctx.job_id) loadDetail(ctx.job_id);
  if (view === 'monitor') {
    MON.batch = false;
    $('mBatchToggle').classList.remove('is-active');
    $('mBatchToggle').setAttribute('aria-pressed', 'false');
    if (ctx && ctx.pick) { refreshMonitorView(); enterPickMode(); }
    else { exitPickMode(); refreshMonitorView(); }
  }
  if (view === 'order') { renderOrderView(); loadOrderHistory(); }
  if (view === 'accounts') loadAccounts();
  if (view === 'logs') loadLogs();
  if (view === 'settings') loadSettings();
}

/* ---------- 1. 仪表盘 ---------- */
var ICONS = {
  jobs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v14H4zM8 3v4M16 3v4M4 10h16"/></svg>',
  query: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
  hit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
  acc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c.8-3.3 3.5-5 8-5s7.2 1.7 8 5"/></svg>',
  /* 任务卡右上角操作（对齐设计稿 reference_template/index.html 的 .icon-btn 四联） */
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>'
};
function loadDashboard() {
  api('/api/dashboard').then(function (d) {
    var s = d.stats;
    // 侧边栏徽标原来只由 loadJobs() 更新，停在总览页时不会刷新（看起来像 bug）
    var navCnt = $('navJobCount');
    if (navCnt) navCnt.textContent = s.jobs_total;
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
    JOB_INDEX = {};
    jobs.forEach(function (j) { JOB_INDEX[j.job_id] = j; });
    $('jobsList').innerHTML = jobs.map(function (j) {
      var routes = (j.stations || []).map(function (p) { return esc(p.left) + ' <b style="color:var(--red);margin:0 6px">→</b> ' + esc(p.arrive); });
      var stTag = j.status === 'running' ? '<span class="tag ok"><span class="d"></span>运行中</span>' : j.status === 'paused' ? '<span class="tag muted">已暂停</span>' : '<span class="tag warn">待启动</span>';
      var tags = '<span class="tag info">' + esc((j.left_dates || []).map(shortDate).join(' / ') || '未设日期') + '</span>' +
        (j.seats || []).map(function (s) { return '<span class="tag hot">' + esc(s) + '</span>'; }).join('') +
        (j.train_numbers && j.train_numbers.length ? '<span class="tag muted">指定 ' + j.train_numbers.length + ' 车次</span>' : '') +
        (j.except_train_numbers && j.except_train_numbers.length ? '<span class="tag muted">排除 ' + j.except_train_numbers.length + ' 车次</span>' : '');
      var hit = j.hit_count ? '<span class="hit">命中 ' + j.hit_count + ' 次</span>' : '尚未命中';
      // 右上角操作：开始/暂停 · 编辑 · 详情 · 删除（对齐设计稿）
      var acts = '<div class="acts">' +
        '<button class="icon-btn" type="button" data-act="toggle" data-id="' + j.job_id + '" data-active="' + (j.is_active ? 1 : 0) + '" title="' + (j.is_active ? '暂停' : '开始') + '" aria-label="' + (j.is_active ? '暂停任务' : '开始任务') + '">' + (j.is_active ? ICONS.pause : ICONS.play) + '</button>' +
        '<button class="icon-btn" type="button" data-act="edit" data-id="' + j.job_id + '" title="编辑" aria-label="编辑任务">' + ICONS.edit + '</button>' +
        '<button class="icon-btn" type="button" data-act="detail" data-id="' + j.job_id + '" title="查看详情" aria-label="查看任务详情">' + ICONS.eye + '</button>' +
        '<button class="icon-btn danger" type="button" data-act="del" data-id="' + j.job_id + '" title="删除" aria-label="删除任务">' + ICONS.trash + '</button>' +
        '</div>';
      return '<div class="job' + (j.status !== 'running' ? ' paused' : '') + '">' +
        '<div class="l1"><span class="route">' + routes.join('；') + '</span>' + stTag + acts + '</div>' +
        '<div class="l2">' + tags + '</div>' +
        '<div class="l3"><span>' + hit + '</span><span>创建 ' + esc(j.created_at || '') + '</span><span>账号 ' + esc(j.account_key || '—') + '</span></div></div>';
    }).join('');
    $('jobsList').querySelectorAll('button[data-act]').forEach(function (b) {
      var act = b.dataset.act, id = b.dataset.id;
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        if (act === 'toggle') jobToggle(id, b.dataset.active === '0');
        else if (act === 'edit') jobEdit(id);
        else if (act === 'detail') go('detail', { job_id: id });
        else if (act === 'del') jobDelete(id);
      });
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
    if ($('dEdit')) $('dEdit').onclick = function () { jobEdit(job_id); };
    $('dToggle').textContent = j.is_active ? '暂停任务' : '启动任务';
    $('dToggle').onclick = function () {
      jobToggle(job_id, !j.is_active, this, function () { loadDetail(job_id); });
    };
    // 行程信息
    var routes = (j.stations || []).map(function (p) { return esc(p.left) + ' → ' + esc(p.arrive); });
    // 优先级结构由 job.seat_tiers 持久化（引擎不读，纯展示）；
    // 老数据没有该列 → 接口回落为 [seats]，这里自然渲染成单级。
    // 展平后的顺序与 seats 一致，所以用座次名反查它属于第几级即可。
    var tierOf = {};
    var rawTiers = (j.seat_tiers && j.seat_tiers.length ? j.seat_tiers : [(j.seats || [])]);
    if (rawTiers.length && typeof rawTiers[0] === 'string') rawTiers = [rawTiers];
    rawTiers.forEach(function (t, ti) {
      (Array.isArray(t) ? t : []).forEach(function (n) { if (tierOf[n] == null) tierOf[n] = ti; });
    });
    var seatPri = (j.seats || []).map(function (s) {
      var ti = tierOf[s] == null ? 0 : tierOf[s];
      return '<i class="p' + (ti % 8 + 1) + '">' + esc(s) + '</i>';
    }).join('');
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
// selSeats/selDates 必须在此处预置：refreshNewView() 里的 syncSeatsFromPicked() 会在
// renderNtSeats() 之前就向它们写值，若等到首次进新建任务页才创建，
// 冷启动直接点「新建任务」会抛 "Cannot read properties of undefined (reading 'indexOf')"，
// 并因异常中断而导致页面不跳转
var APP = { passengers: {}, seats: [], selSeats: [], selDates: [], paxAll: [], paxSel: [], dates: [], openDates: [],
            seatTiers: [[]],      // 座次优先级（二维：每级一组）；展平后写入 selSeats
            seatPickTier: -1,     // 当前展开的座次选择面板（-1 = 都收起）
            // 新建任务页的查询方式：'train'（车次查询，默认）| 'range'（区间查询）。
            // 由顶部「查询方式」手动切换，不再由「有没有已选车次」推断
            ntMode: 'train',
            // 编辑任务：非空 = 当前处于编辑态，提交走 PATCH 而不是 POST
            editJobId: null,
            // 编辑时账号/乘客列表是异步加载的，先把任务里已保存的选中项暂存于此
            pendingAccount: null,
            pendingPax: null };
// 日期（预售期）状态：open=可售、all=含未开售的展示项
var DATES = { all: [], open: [], first: '', last: '', presale: 0, note: '' };
function loadDates() {
  api('/api/dates').then(function (d) {
    var list = d.dates || [];
    DATES.all = list;
    DATES.open = list.filter(function (x) { return x.open !== false; });
    DATES.first = d.first || (DATES.open[0] || {}).date || '';
    DATES.last = d.last || (DATES.open[DATES.open.length - 1] || {}).date || '';
    DATES.presale = d.presale_days || DATES.open.length;
    DATES.note = d.note || '';

    // 新建任务：紧凑日期选择（只列出预售期内可售日期）
    APP.dates = DATES.open;
    APP.openDates = DATES.open;
    APP.selDates = [];
    $('ntDates').innerHTML = '';
    renderNtDates();

    // 车票查询：日期条 + 原生日期输入的范围限制
    var inp = $('mDate');
    inp.min = DATES.first;
    inp.max = DATES.last;
    renderMonitorDates();
    setMonitorDate(DATES.first, { search: false });
    inp.onchange = onMonitorDateInput;
    loadStationsForPairs();
  }).catch(function () { });
}
function isMonitorDateOpen(date) {
  if (!DATES.open.length) return true;   // 日期未加载成功时不拦截
  return DATES.open.some(function (x) { return x.date === date; });
}
function renderMonitorDates() {
  var box = $('mDates');
  if (!box) return;
  var cur = $('mDate').value;
  box.innerHTML = DATES.all.map(function (x) {
    var blocked = x.open === false;
    return '<div class="date' + (blocked ? ' dis' : '') + (x.date === cur ? ' on' : '') +
      '" data-date="' + x.date + '" data-open="' + (blocked ? '0' : '1') +
      '" title="' + esc(blocked ? '尚未开售' : x.date) + '">' +
      '<b>' + esc(x.weekday) + '</b><small>' + esc(x.date.slice(5)) + '</small>' +
      (blocked ? '<small class="dis-tag">未开售</small>' : '') + '</div>';
  }).join('');
  if ($('mPresaleNote')) $('mPresaleNote').textContent = DATES.note;
  box.querySelectorAll('.date').forEach(function (el) {
    el.addEventListener('click', function () {
      if (el.dataset.open === '0') {
        toast('该日期尚未开售（' + DATES.note + '）', 'err');
        return;
      }
      // 点日期即切换并重新查询
      setMonitorDate(el.dataset.date, { search: true });
    });
  });
}
function setMonitorDate(date, opts) {
  opts = opts || {};
  $('mDate').value = date || '';
  $('mDates').querySelectorAll('.date').forEach(function (x) {
    x.classList.toggle('on', x.dataset.date === date);
  });
  if (opts.search) doMonitorSearch();
}
function onMonitorDateInput() {
  var v = $('mDate').value;
  if (!v) return;
  if (!isMonitorDateOpen(v)) {
    // 手输/原生选择器选到未开售日期 → 回到最近一个可售日期
    toast('该日期尚未开售，已切回 ' + DATES.last, 'err');
    setMonitorDate(DATES.last, { search: false });
    return;
  }
  setMonitorDate(v, { search: true });
}
// 乘车日期 / 座次控件只有区间查询模式才有（车次模式两项均由车次派生，只做展示、不可编辑）
function ntDateBoxId() { return ntMode() === 'train' ? null : 'ntDates'; }
function ntSeatBoxId() { return ntMode() === 'train' ? null : 'ntSeats'; }
function renderNtDates() {
  var wrap = ntDateBoxId() ? $(ntDateBoxId()) : null;
  // 车次模式没有日期控件，但摘要仍需刷新（它会在增删日期时变化）
  if (!wrap) { updateNtSummary(); return; }
  wrap.innerHTML = APP.selDates.map(function (d, i) {
    return '<span class="chip on">' + shortDate(d) + '<button class="x" data-i="' + i + '" title="移除">✕</button></span>';
  }).join('') + '<span class="chip add" id="ntDateAdd">+ 选择日期</span>';
  var cnt = $('ntDateCnt');
  if (cnt) cnt.textContent = APP.selDates.length ? '已选 ' + APP.selDates.length + ' 天' : '请选择，可多选';
  wrap.querySelectorAll('.chip .x').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      APP.selDates.splice(+b.dataset.i, 1);
      renderNtDates();
      if (datePickOpen()) renderNtDatePicker();   // 面板开着时同步刷新选中态
    });
  });
  $('ntDateAdd').addEventListener('click', function (e) { e.stopPropagation(); toggleNtDatePicker(); });
  updateNtSummary();
}
/* 乘车日期：内联多选面板
   旧实现是 appendChild 的浮层且「点一个日期就 remove()」：不能多选，
   再点「+ 选择日期」还会叠加出第二个面板，也没有取消入口（用户报的 bug）。
   现在：唯一实例（#ntDatePick）、常驻多选、可收起、点面板外部关闭。 */
function datePickOpen() { var p = $('ntDatePick'); return !!p && !p.hidden; }
function closeNtDatePicker() { var p = $('ntDatePick'); if (p) { p.hidden = true; p.innerHTML = ''; } }
function toggleNtDatePicker() {
  if (datePickOpen()) { closeNtDatePicker(); return; }
  renderNtDatePicker();
}
function renderNtDatePicker() {
  var p = $('ntDatePick');
  if (!p) return;
  p.hidden = false;
  var list = APP.openDates || APP.dates || [];
  p.innerHTML =
    '<div class="picker-grid">' + list.map(function (x) {
      var on = APP.selDates.indexOf(x.date) >= 0;
      return '<span class="pk-cell' + (on ? ' on' : '') + '" data-d="' + x.date + '">' +
        '<b>' + esc(x.weekday) + '</b><small>' + x.date.slice(5) + '</small></span>';
    }).join('') + '</div>' +
    '<div class="picker-foot"><span>已选 ' + APP.selDates.length + ' / ' + list.length +
      ' 天（可多选）</span><button class="btn btn-outline" id="ntDatePickDone" type="button">完成</button></div>';
  p.querySelectorAll('[data-d]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      var d = el.dataset.d, i = APP.selDates.indexOf(d);
      if (i >= 0) APP.selDates.splice(i, 1);
      else if (APP.selDates.length >= list.length) { toast('最多选择 ' + list.length + ' 天', 'err'); return; }
      else APP.selDates.push(d);
      el.classList.toggle('on', i < 0);
      renderNtDates(); renderNtDatePicker();
    });
  });
  $('ntDatePickDone').addEventListener('click', function (e) { e.stopPropagation(); closeNtDatePicker(); });
}
function loadAccountsForNew() {
  api('/api/accounts').then(function (d) {
    // 在线账号排前面；离线置灰（引擎取乘客需要账号处于就绪状态）
    var list = (d.accounts || []).slice().sort(function (a, b) {
      return (b.is_ready ? 1 : 0) - (a.is_ready ? 1 : 0);
    });
    var opts = '<option value="">（需先添加并登录账号）</option>' + list.map(function (a) {
      return '<option value="' + a.key + '" ' + (!a.is_ready ? 'disabled' : '') + '>' + esc(a.user_name) + (a.is_ready ? '（在线 · ' + a.passenger_count + ' 位乘客）' : '（离线，未就绪）') + '</option>';
    }).join('');
    $('ntAccount').innerHTML = opts;
    $('oAccount').innerHTML = opts;
    // 编辑态：账号列表可能比 applyJobToForm 晚到，这里补选任务原账号
    if (APP.pendingAccount) {
      $('ntAccount').value = APP.pendingAccount;
      APP.pendingAccount = null;
      loadPassengersFor($('ntAccount').value);
      return;
    }
    // 默认选中第一个在线账号，减少手动步骤
    if (!$('ntAccount').value) {
      var first = Array.prototype.find.call($('ntAccount').options, function (o) { return o.value && !o.disabled; });
      if (first) { $('ntAccount').value = first.value; loadPassengersFor(first.value); }
    }
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
    // 编辑态：优先用任务里已保存的乘车人，而不是默认全选
    var want = APP.pendingPax;
    APP.pendingPax = null;
    APP.paxSel = (want && want.length)
      ? APP.paxAll.filter(function (p) { return want.indexOf(p.name) >= 0; }).map(function (p) { return p.name; })
      : APP.paxAll.map(function (p) { return p.name; });
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
/* 座次优先级（仅区间查询模式）：按「优先级」分行，每行是一组芯片（与乘车日期同一套样式）。
   顺序 = 引擎 handle_seats() 的尝试顺序；提交时按行序展平成引擎的 seats 数组。
   APP.seatTiers 是 UI 模型（二维），APP.selSeats 是展平后的事实来源（提交/摘要都用它）。
   同一座次只允许存在于一级里（加到某级时会从其它级移除），避免展平后重复。 */
function seatTiers() {
  if (!APP.seatTiers || !APP.seatTiers.length) APP.seatTiers = [[]];
  return APP.seatTiers;
}
function flattenSeatTiers() {
  var out = [];
  seatTiers().forEach(function (t) { t.forEach(function (s) { if (out.indexOf(s) < 0) out.push(s); }); });
  APP.selSeats = out;
}
function seedSeatTiers(all) {
  if (seatTiers().some(function (t) { return t.length; })) return;   // 已有选择就别覆盖
  // 优先沿用现有的 selSeats（比如从车次查询带过来 / 之前选过），否则给个默认
  var seed = (APP.selSeats || []).filter(function (s) { return all.indexOf(s) >= 0; });
  if (!seed.length) {
    var prefer = ['二等座', '一等座', '商务座', '硬卧', '硬座'];
    seed = prefer.filter(function (s) { return all.indexOf(s) >= 0; }).slice(0, 2);
  }
  APP.seatTiers = [seed.length ? seed : [all[0]]];
}
function renderNtSeats() {
  var box = ntSeatBoxId() ? $(ntSeatBoxId()) : null;
  // 席别一致性提示独立于列表存在，必须先刷（否则车次模式下永远不显示）
  renderSeatSync();
  // 车次模式：席别来自卡片勾选，不用这里的二维模型，保持 selSeats 原样。
  // 但必须顺带重绘「由车次推导」—— 卡片里改座次后就要看到座次顺序跟着变，
  // 之前这里直接 return，导致推导行永远不刷新。
  if (!box) { renderNtDerived(); updateNtSummary(); return; }
  var all = APP.seats || [];
  if (!all.length) { box.innerHTML = '<div class="hint">席别列表加载中…</div>'; return; }
  seedSeatTiers(all);
  // 区间模式下 tiers 才是事实来源（车次模式写入过 selSeats，这里必须校正回来）
  flattenSeatTiers();
  var tiers = seatTiers();
  var openIdx = ntSeatPickTier();
  box.innerHTML = tiers.map(function (list, ti) {
    var chips = list.map(function (name) {
      return '<span class="chip on">' + esc(name) +
        '<button class="x" data-t="' + ti + '" data-s="' + esc(name) + '" title="移除">✕</button></span>';
    }).join('');
    // 选择面板渲染在**所属优先级内部**（原来统一追加到容器末尾，
    // 展开第 1 级时面板会跑到所有优先级下方，看不出它属于哪一级）
    var pickerHtml = (openIdx === ti && openIdx < tiers.length) ? buildSeatPicker(ti, all) : '';
    return '<div class="tier" data-tier="' + ti + '">' +
      '<div class="tier-head">' +
        '<span class="tier-no">' + (ti + 1) + '</span>' +
        '<span class="tier-label">第 ' + (ti + 1) + ' 优先级</span>' +
        // 注释跟在标题右侧（不再单独占一行）
        '<span class="tier-hint">' + (ti === 0 ? '最先尝试这一级' : '上一级都没票时才看这里') + '</span>' +
        // 只剩一个优先级时没东西可删，不渲染按钮（避免出现无意义的禁用图标）
        (tiers.length > 1 ? '<button class="tier-del" data-del-tier="' + ti + '" title="删除该优先级">✕</button>' : '') +
      '</div>' +
      '<div class="chip-row">' + chips +
        '<span class="chip add" data-open="' + ti + '">+ 选择座次</span>' +
      '</div>' +
      pickerHtml +
      '</div>';
  }).join('');
  var picker = box.querySelector('.tier[data-tier="' + openIdx + '"] .picker');
  if (picker) wireSeatPicker(picker);
  // 移除芯片
  box.querySelectorAll('.chip .x').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      var ti = +b.dataset.t, list = seatTiers()[ti];
      var ix = list.indexOf(b.dataset.s);
      if (ix >= 0) list.splice(ix, 1);
      renderNtSeats();
    });
  });
  // 删除某一优先级（行内的 ✕）。删掉的级若在展开面板之前/本身，需要修正面板索引
  box.querySelectorAll('.tier-del').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      var ti = +b.dataset.delTier;
      if (seatTiers().length <= 1) return;
      seatTiers().splice(ti, 1);
      if (APP.seatPickTier === ti) APP.seatPickTier = -1;
      else if (APP.seatPickTier > ti) APP.seatPickTier = APP.seatPickTier - 1;
      renderNtSeats();
    });
  });
  // 展开 / 收起选择面板
  box.querySelectorAll('.chip.add').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      var ti = +b.dataset.open;
      APP.seatPickTier = (ntSeatPickTier() === ti) ? -1 : ti;
      renderNtSeats();
    });
  });
  // 所有改动都经过这里：重绘 + 展平 + 刷摘要，避免漏掉某处导致摘要不同步
  updateNtSummary();
}
function ntSeatPickTier() { return typeof APP.seatPickTier === 'number' ? APP.seatPickTier : -1; }
// 某级的座次选择面板：已选的用选中样式；未启用 / 已在其它优先级的用弱化样式
function buildSeatPicker(ti, all) {
  var cur = seatTiers()[ti] || [];
  return '<div class="picker">' +
    '<div class="picker-grid">' + all.map(function (name) {
      var on = cur.indexOf(name) >= 0;
      var otherTier = -1;
      seatTiers().forEach(function (t, k) { if (k !== ti && t.indexOf(name) >= 0) otherTier = k; });
      var cls = on ? 'pk-cell on' : (otherTier >= 0 ? 'pk-cell used' : 'pk-cell');
      var sub = on ? '已选' : (otherTier >= 0 ? ('第 ' + (otherTier + 1) + ' 优先级') : '未启用');
      // 已在其它级的仍可点 —— 点一下就「移过来」，否则想换级得先去那边删掉（死路）
      var title = otherTier >= 0 ? '点击移动到第 ' + (ti + 1) + ' 优先级' : '点击加入第 ' + (ti + 1) + ' 优先级';
      return '<span class="' + cls + '" data-s="' + esc(name) + '" title="' + title + '">' +
        '<b>' + esc(name) + '</b><small>' + sub + '</small></span>';
    }).join('') + '</div>' +
    '<div class="picker-foot"><span>第 ' + (ti + 1) + ' 优先级 · 已选 ' + cur.length +
      ' 项（可多选）</span>' +
      '<button class="btn btn-primary" data-done="' + ti + '" type="button">完成</button></div>' +
    '</div>';
}
function wireSeatPicker(box) {
  box.querySelectorAll('.pk-cell').forEach(function (el) {
    if (el.classList.contains('dis')) return;
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      var ti = ntSeatPickTier();
      if (ti < 0) return;
      var name = el.dataset.s, tiers = seatTiers();
      var ix = tiers[ti].indexOf(name);
      if (ix >= 0) tiers[ti].splice(ix, 1);
      else {
        // 同一座次只属于一级：从其它级移过来，避免展平后重复
        tiers.forEach(function (t, k) { if (k !== ti) { var j = t.indexOf(name); if (j >= 0) t.splice(j, 1); } });
        tiers[ti].push(name);
      }
      renderNtSeats();
    });
  });
  var done = box.querySelector('[data-done]');
  if (done) done.addEventListener('click', function (e) { e.stopPropagation(); APP.seatPickTier = -1; renderNtSeats(); });
  // 面板里的「删除该优先级」已移除 —— 删除统一走优先级右上角的 ✕，避免同一操作两处入口
}
// 兼容旧调用点（prefillNewTask 已移除）——直接转发到 renderNtSeats
function buildNtSeats() { renderNtSeats(); }
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
    refreshNtQueryLoad();
    updateNtSummary();
  });
  // 输入站点后需要刷新「每轮请求」预估（空区间会被 ntPairs() 过滤，所以必须监听输入）
  row.querySelectorAll('.stn').forEach(function (inp) {
    inp.addEventListener('input', function () { refreshNtQueryLoad(); updateNtSummary(); });
  });
  bindStationSuggest(row.querySelectorAll('.stn'));
}
function loadStationsForPairs() {
  $('ntPairs').querySelectorAll('.pair').forEach(wireNtPair);
}
// 车次范围三选一（与后端「train_numbers / except_train_numbers 不可同时给出」的校验一致）
function ntTrainMode() {
  var box = $('ntTrainMode');
  var on = box && box.querySelector('.seg-btn.on');
  return on ? on.dataset.mode : 'all';
}
function syncTrainMode() {
  var mode = ntTrainMode();
  $('ntAllowWrap').style.display = mode === 'allow' ? '' : 'none';
  $('ntExceptWrap').style.display = mode === 'except' ? '' : 'none';
  updateNtSummary();
}
function bindTrainMode() {
  var box = $('ntTrainMode'); if (!box || box.dataset.bound) return;
  box.dataset.bound = '1';
  box.querySelectorAll('.seg-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      box.querySelectorAll('.seg-btn').forEach(function (x) { x.classList.toggle('on', x === b); });
      syncTrainMode();
    });
  });
  syncTrainMode();
}
// 查询量预估：引擎是 stations 外层 × dates 内层，每轮 requestCount 次
function ntQueryLoad() {
  var st = ntPairs().length, dt = (APP.selDates || []).length;
  return { stations: st, dates: dt, perRound: st * dt };
}
function refreshNtQueryLoad() {
  var L = ntQueryLoad();
  var box = $('ntQueryLoadHint');
  if (box) {
    if (!L.perRound) box.textContent = '填写区间与日期后，这里会显示每轮实际请求次数。';
    else {
      var warn = L.perRound >= 12;
      box.className = 'query-load' + (warn ? ' warn' : '');
      box.innerHTML = '每轮查询 <b>' + L.perRound + '</b> 次（' + L.stations + ' 组区间 × ' + L.dates +
        ' 个日期）' + (warn ? '　请求量偏大，注意 12306 频控风险' : '');
    }
  }
  var e = $('ntQueryLoad');
  if (e) e.textContent = L.perRound ? L.perRound + ' 次（' + L.stations + ' 区间 × ' + L.dates + ' 日期）' : '—';
}
function refreshNewView() {
  bindNtModeSeg();
  bindNtStartMode();
  applyNtMode();
  syncSeatsFromPicked();
  // 日期 chip 必须重绘：车票查询导入车次时会向 APP.selDates 写入查询日期，
  // 只更新状态不重绘的话，汇总里显示有日期、日期条上却什么都没有
  renderNtDates();
  bindTrainMode();
  renderTaskPicked();
  renderNtSeats();
  loadPassengersFor($('ntAccount').value);
  refreshEngineNotes();
  refreshNtQueryLoad();
  updateNtSummary();
}
// 执行说明：查询间隔是全局设置，本任务无法单独调整
function refreshEngineNotes() {
  api('/api/settings').then(function (d) {
    var v = ((d.config || {}).query || {}).interval;
    APP.queryInterval = (v == null ? 1 : v);
    if ($('ntIntervalNote')) $('ntIntervalNote').textContent = APP.queryInterval + ' 秒（全局设置）';
  }).catch(function () {
    if ($('ntIntervalNote')) $('ntIntervalNote').textContent = '全局设置';
  });
}

/* ---------- 新建任务：双模式（区间模式 / 车次模式）----------
   判定依据：APP.taskPicked 是否为空（即用户是否从车票查询导入过车次）。
   车次模式下「区间 / 时段 / 车次范围」全部由已选车次推导，不再让用户重填一遍：
   引擎是 stations × left_dates 两层循环查询、train_numbers 只做结果过滤，
   所以用户随手改这三项中任意一项，都可能把刚导入的车次静默排除。
   （时段更是会直接覆盖白名单 —— is_trains_number_valid 先判时间再判车次号。） */
var SEAT_ORDER = ['商务座', '一等座', '二等座', '硬卧', '软卧', '硬座', '无座', '特等座'];
// 查询方式由用户显式选择（顶部 seg），默认车次查询
function ntMode() { return APP.ntMode === 'range' ? 'range' : 'train'; }
function setNtMode(m) {
  APP.ntMode = (m === 'range') ? 'range' : 'train';
  APP.seatPickTier = -1;      // 切模式时收起座次面板
  closeNtDatePicker();
  applyNtMode();
  renderNtDates();
  renderNtSeats();
  updateNtSummary();
}
function bindNtModeSeg() {
  var seg = $('ntModeSeg');
  if (!seg || seg.dataset.bound) return;
  seg.dataset.bound = '1';
  seg.querySelectorAll('.seg-btn').forEach(function (b) {
    b.addEventListener('click', function () { setNtMode(b.dataset.ntMode); });
  });
}
// 从已选车次推导查询区间（去重、保序）
function pickedPairs() {
  var out = [], seen = {};
  (APP.taskPicked || []).forEach(function (s) {
    var k = s.leg.f + '|' + s.leg.to;
    if (!seen[k]) { seen[k] = 1; out.push({ left: s.leg.f, arrive: s.leg.to }); }
  });
  return out;
}
function pickedTrainNumbers() {
  var out = [];
  (APP.taskPicked || []).forEach(function (s) { if (s.leg.n && out.indexOf(s.leg.n) < 0) out.push(s.leg.n); });
  return out;
}
function pickedSeatUnion() {
  var seen = {}, out = [];
  (APP.taskPicked || []).forEach(function (s) {
    (s.seats || []).forEach(function (n) { if (n && !seen[n]) { seen[n] = 1; out.push(n); } });
  });
  return out;
}
// 各车次勾选不一致的席别（引擎只有一份全局席别表，这里必须显式告知而非静默合并）
function pickedSeatDiff() {
  var all = APP.taskPicked || [];
  if (all.length < 2) return [];
  return SEAT_ORDER.filter(function (n) {
    var c = all.filter(function (s) { return (s.seats || []).indexOf(n) >= 0; }).length;
    return c > 0 && c < all.length;
  });
}
// 卡片勾选 → 优先级列表（单向同步）：保留用户已排定的顺序，新席别按标准序追加到末尾
function syncSeatsFromPicked() {
  if (ntMode() !== 'train') return;
  var want = pickedSeatUnion();
  var kept = (APP.selSeats || []).filter(function (n) { return want.indexOf(n) >= 0; });
  var add = want.filter(function (n) { return kept.indexOf(n) < 0; });
  add.sort(function (a, b) { return SEAT_ORDER.indexOf(a) - SEAT_ORDER.indexOf(b); });
  APP.selSeats = kept.concat(add);
}
// 席别优先级列表里点 ✕ = 从所有车次取消该席别（仅区间模式用；车次模式已无此列表）
function renderSeatSync() {
  var box = $('ntSeatSync'); if (!box) return;
  if (ntMode() !== 'train') { box.style.display = 'none'; return; }
  var diff = pickedSeatDiff(), n = (APP.taskPicked || []).length;
  box.style.display = 'block';
  if (!diff.length) {
    box.className = 'seat-sync ok';
    box.textContent = '各车次勾选的席别一致，已按下方优先级统一生效。';
    return;
  }
  box.className = 'seat-sync';
  box.innerHTML = '<b>席别不完全一致。</b>引擎对所有车次只使用一份席别优先级，因此下列席别会在全部 ' + n +
    ' 个车次上被尝试：' + diff.map(function (x) {
      var c = APP.taskPicked.filter(function (s) { return (s.seats || []).indexOf(x) >= 0; }).length;
      return '<i>' + esc(x) + '</i>（原本仅 ' + c + '/' + n + ' 个车次勾选）';
    }).join('、') + '。若不希望某个车次接受该席别，请在上方卡片里取消勾选。';
}
// 车次模式下的只读推导行：
// 区间 / 车次 / 时段原本就是从车次推出来的，座次与日期也一并展示在这里，
// 说明文字随行给出（面板里不再放可编辑控件，避免与车票查询页重复设置）。
function renderNtDerived() {
  var box = $('ntDerived'); if (!box) return;
  if (ntMode() !== 'train') { box.innerHTML = ''; return; }
  var pairs = pickedPairs(), nums = pickedTrainNumbers();
  var seats = (APP.selSeats || []).slice();   // 不带序号：顺序本身已经表达了优先级
  var dates = (APP.selDates || []).map(shortDate);
  box.innerHTML =
    '<div class="dv-row"><span class="dv-k">查询区间</span><span class="dv-v">' +
      (pairs.length ? pairs.map(function (p) { return '<b>' + esc(p.left) + '</b> → <b>' + esc(p.arrive) + '</b>'; }).join('、') +
        '<small>' + pairs.length + ' 组，依次轮询</small>' : '—') +
    '</span></div>' +
    '<div class="dv-row"><span class="dv-k">抢票车次</span><span class="dv-v">' + esc(nums.join('、')) +
      '<small>只抢这些车次（引擎 train_numbers 白名单）</small></span></div>' +
    '<div class="dv-row"><span class="dv-k">出发时段</span><span class="dv-v">全天' +
      '<small>车次已明确指定，时间窗会额外过滤白名单，故固定为全天</small></span></div>' +
    '<div class="dv-row"><span class="dv-k">座次顺序</span><span class="dv-v">' +
      (seats.length ? esc(seats.join('、')) : '—') +
      '<small>取上方车次卡片勾选的席别；引擎只有一份全局席别表（无法按车次区分），此处顺序对所有已选车次生效。</small></span></div>' +
    '<div class="dv-row"><span class="dv-k">乘车日期</span><span class="dv-v">' +
      (dates.length ? esc(dates.join('、')) : '—') +
      '<small>取车票查询时的日期；引擎会对每个日期各查一遍。</small></span></div>';
}
// 切换模式时同步提示文案（结构显隐由 CSS 按 .mode-train / .mode-range 控制）
function applyNtMode() {
  var flow = $('taskFlow'); if (!flow) return;
  var train = ntMode() === 'train';
  flow.classList.toggle('mode-train', train);
  flow.classList.toggle('mode-range', !train);
  // 切换按钮的选中态也在这里统一同步：
  // 导入车次（pickAddToTask 直接改 APP.ntMode）等入口不会走 setNtMode，
  // 不同步的话会出现「面板已是车次查询、按钮还高亮区间查询」的矛盾状态
  var seg = $('ntModeSeg');
  if (seg) seg.querySelectorAll('.seg-btn').forEach(function (b) { b.classList.toggle('on', b.dataset.ntMode === APP.ntMode); });
  var n = (APP.taskPicked || []).length;
  // 注释跟在「查询方式」标题右侧，必须压到一行内（面板副标题已有更长解释）
  if ($('ntModeHint')) {
    $('ntModeHint').textContent = train ? '只抢勾选的车次' : '查区间内全部车次';
  }
  // 区间模式下还有已选车次时，必须显式提醒它们不会生效
  if ($('ntPickedHint')) {
    if (!train && n) {
      $('ntPickedHint').style.display = 'block';
      $('ntPickedHint').innerHTML = '你已从车票查询选了 <b>' + n + '</b> 个车次，但当前是<b>区间查询</b>模式，'
        + '这些车次不会生效（不会写入车次白名单）。如需使用请切回<button class="link-btn" id="ntSwitchToTrain" type="button">车次查询</button>。';
      if ($('ntSwitchToTrain')) $('ntSwitchToTrain').addEventListener('click', function () { setNtMode('train'); });
    } else {
      $('ntPickedHint').style.display = 'none';
      $('ntPickedHint').innerHTML = '';
    }
  }
  renderNtDerived();
}
function ntPairs() {
  // 车次模式下「区间」不再是用户输入项，而是由已选车次推导出来的 —— 这一点很关键：
  // 引擎的查询是 `for station in stations: for date in left_dates`，train_numbers 只在返回结果里过滤。
  // 之前只拿第一行车次的区间去填，跨线路一起勾选时其余线路的车次永远查不到。
  if (ntMode() === 'train') return pickedPairs();
  var out = [];
  $('ntPairs').querySelectorAll('.pair').forEach(function (r) {
    out.push({ left: r.querySelector('[data-role=left]').value.trim(), arrive: r.querySelector('[data-role=arrive]').value.trim() });
  });
  return out.filter(function (p) { return p.left && p.arrive; });
}
function ntTags(id) {
  // 必须读 dataset.t 而不是 textContent：标签 DOM 是「车次号 + 删除按钮 ✕」，
  // textContent 会把 ✕ 一起带上（提交成 "G79 ✕"），引擎的车次白名单永远匹配不上，
  // 「只抢指定车次 / 排除指定车次」会静默失效
  return Array.prototype.map.call(document.querySelectorAll('#' + id + ' .t'), function (t) {
    return t.dataset.t || t.textContent.replace(/✕/g, '').trim();
  });
}
function updateNtSummary() {
  var pairs = ntPairs();
  var picked = APP.taskPicked || [];
  var pickedNames = picked.map(function (s) { return s.leg.n; });
  var train = ntMode() === 'train';
  var mode = ntTrainMode();
  var allowTags = mode === 'allow' ? ntTags('ntTrainBox') : [];
  var exceptTags = mode === 'except' ? ntTags('ntExceptBox') : [];
  var seats = APP.selSeats || [];
  // 一个颜色 = 一个优先级：同一级内的座次同色，不同级不同色。
  // 车次查询模式没有优先级概念（席别来自车次卡片勾选），整体算作第 1 级 → 全部同色。
  var tierOfSeat = {};
  if (!train) {
    seatTiers().forEach(function (list, ti) {
      if (!Array.isArray(list)) return;
      list.forEach(function (n) { if (tierOfSeat[n] == null) tierOfSeat[n] = ti; });
    });
  }
  var seatPri = seats.map(function (s) {
    var ti = train ? 0 : (tierOfSeat[s] == null ? 0 : tierOfSeat[s]);
    // 不带序号：顺序已经由芯片排列表达，优先级由颜色区分（同色 = 同一优先级）
    return '<i class="p' + (ti % 8 + 1) + '">' + esc(s) + '</i>';
  }).join(' ');
  var load = ntQueryLoad();
  var iv = ntIntervalValue();
  // 车次范围（含从车票查询带入的指定车次）
  var trainsTxt;
  if (train && picked.length) trainsTxt = esc(pickedNames.join('、')) + '<small>来自车票查询 · ' + picked.length + ' 个</small>';
  else if (!train && allowTags.length) trainsTxt = esc(allowTags.join('、')) + '<small>只抢列表内车次</small>';
  else if (!train && exceptTags.length) trainsTxt = '排除 ' + esc(exceptTags.join('、')) + '<small>其余车次均可抢</small>';
  else if (train) trainsTxt = '未选车次<small>请到车票查询添加</small>';
  else trainsTxt = '不限车次<small>区间内全部车次</small>';
  $('ntSummary').innerHTML =
    row('查询方式', train ? '车次查询<small>只抢列表内车次</small>' : '区间查询<small>查询区间内全部车次</small>') +
    row('账号', esc($('ntAccount').value || '未选')) +
    row('乘车人', APP.paxSel && APP.paxSel.length
      ? esc(APP.paxSel.join('、')) + '<small>' + APP.paxSel.length + ' 人' + ($('ntLessMember').checked ? ' · 允许部分先行' : '') + '</small>'
      : '未选') +
    row('区间', pairs.length ? esc(pairs.map(function (p) { return p.left + '→' + p.arrive; }).join(' · ')) + '<small>' + pairs.length + ' 组，依次轮询</small>' : '未填') +
    row('日期', APP.selDates.length ? esc(APP.selDates.map(shortDate).join('、')) + '<small>共 ' + APP.selDates.length + ' 天</small>' : '未选') +
    // 标签跟模式走：车次模式没有可编辑的「席别优先级」列表，那里叫「座次顺序」
    row(train ? '座次顺序' : '席别优先级', seatPri || '未选', 'seat-priority') +
    row('车次', trainsTxt) +
    row('时间段', train
      ? '全天<small>车次已指定，不做时间过滤</small>'
      : esc(ntPeriodLabel()) + '<small>按出发时刻筛选</small>') +
    row('开始时间', esc(ntStartLabel()) + '<small>需引擎支持后生效</small>') +
    row('查询间隔', iv.min + '–' + iv.max + ' 秒<small>本任务专用；需引擎支持后生效</small>') +
    row('每轮请求', load.perRound ? '<b>' + load.perRound + '</b> 次<small>' + load.stations + ' 区间 × ' + load.dates + ' 日期</small>' : '—');
  // 允许部分乘客：说明引擎在该开关下的实际行为
  if ($('ntLessNote')) $('ntLessNote').textContent = $('ntLessMember').checked
    ? '开启时：按实际余票数减人提交'
    : '关闭时：余票 < 人数则不提交';
  if ($('ntMemberNote')) $('ntMemberNote').textContent = $('ntLessMember').checked
    ? '余票不足时按实际张数减人提交（不等待满足全部乘客）'
    : '必须满足全部乘客的余票数，否则跳过该席别继续看下一优先级';
  refreshNtQueryLoad();
}
function row(k, v, cls) { return '<div class="r"><span class="k">' + k + '</span><span class="v"><span class="' + (cls || '') + '">' + (v || '未填') + '</span></span></div>'; }

/* ---------- 策略：开始时间 / 查询间隔 ----------
   注意：这两项都需要 py12306 抢票引擎侧改动才会生效（引擎目前只用全局 QUERY_INTERVAL，
   且没有定时启动能力）。此处先做到「可填、可存（写进 job 表）」，UI 上已标注「待引擎支持」。 */
function ntStartMode() {
  var seg = $('ntStartMode');
  var on = seg && seg.querySelector('.seg-btn.on');
  return on && on.dataset.start === 'at' ? 'at' : 'now';
}
function bindNtStartMode() {
  var seg = $('ntStartMode');
  if (!seg || seg.dataset.bound) return;
  seg.dataset.bound = '1';
  seg.querySelectorAll('.seg-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      seg.querySelectorAll('.seg-btn').forEach(function (x) { x.classList.toggle('on', x === b); });
      syncNtStartMode();
    });
  });
  syncNtStartMode();
}
function syncNtStartMode() {
  var at = ntStartMode() === 'at';
  var inp = $('ntStartAt');
  if (inp) inp.disabled = !at;
  updateNtSummary();
}
function ntStartAtValue() {
  if (ntStartMode() !== 'at') return '';
  // datetime-local 给的是 'YYYY-MM-DDTHH:MM'，统一成 'YYYY-MM-DD HH:MM' 存库
  var v = ($('ntStartAt') || {}).value || '';
  return v ? v.replace('T', ' ') : '';
}
function ntIntervalValue() {
  var a = parseFloat(($('ntIntMin') || {}).value), b = parseFloat(($('ntIntMax') || {}).value);
  if (!isFinite(a) || a <= 0) a = APP.queryInterval || 1;
  if (!isFinite(b) || b <= 0) b = a;
  if (b < a) b = a;
  return { min: a, max: b };
}
function ntStartLabel() {
  if (ntStartMode() !== 'at') return '立即开始';
  var v = ntStartAtValue();
  return v ? ('定时 ' + v) : '定时开始（未填时间）';
}

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
    // boxId 必须在外层作用域求值：blur 处理器与 input 处理器是两个函数，
    // 之前 boxId 只声明在 input 处理器内，blur 引用它必然抛 ReferenceError
    var boxId = inp.id === 'mFrom' ? 'mFromSug' : inp.id === 'mTo' ? 'mToSug' : null;
    if (!boxId) return; // 新建任务页站名直接输入即可，不做远程联想
    var box = function () { return $(boxId); };
    inp.addEventListener('input', function () {
      clearTimeout(sugTimers[boxId]);
      if (!inp.value.trim()) { box().classList.add('hidden'); return; }
      sugTimers[boxId] = setTimeout(function () {
        api('/api/stations?q=' + encodeURIComponent(inp.value.trim())).then(function (d) {
          var list = d.list || [];
          var el = box();
          if (!list.length) { el.classList.add('hidden'); return; }
          el.innerHTML = list.map(function (s) {
            return '<div class="stn-item" data-n="' + esc(s.name) + '"><span>' + esc(s.name) + '</span><small>' + esc(s.pinyin || '') + '</small></div>';
          }).join('');
          el.classList.remove('hidden');
          el.querySelectorAll('.stn-item').forEach(function (it) {
            it.addEventListener('mousedown', function (e) {
              e.preventDefault();
              inp.value = it.dataset.n;
              el.classList.add('hidden');
            });
          });
        }).catch(function () { });
      }, 300);
    });
    inp.addEventListener('blur', function () {
      setTimeout(function () { box().classList.add('hidden'); }, 150);
    });
  });
}

/* ---------- 5. 车票查询 ---------- */
var MON = { rows: [], batch: false, sel: {}, selSeats: {}, selBy: {}, sort: null, stationOpts: { from: {}, to: {} },
            searched: false,
            filters: { types: [], fromSt: [], toSt: [], seats: [], hour: '', bookable: false } };
APP.taskPicked = []; // 新建任务：从车票查询勾选的车次（含席别）
var PICK_SEAT_KEYS = ['business', 'first', 'second', 'hardSleeper', 'hardSeat', 'noSeat', 'softSleeper', 'special'];
function renderTaskPicked() {
  var list = $('taskSelectionList');
  if (!list) return;
  var sels = APP.taskPicked || [];
  // 入口按钮的文案随状态变化（样式与「+ 添加一组区间」一致）；
  // 没有车次时它兼任空态提示，所以不再需要单独的空白占位块
  if ($('taskAddTrain')) $('taskAddTrain').textContent = sels.length ? '+ 继续添加车次' : '+ 添加车次';
  if ($('ntTrainCnt')) $('ntTrainCnt').textContent = sels.length ? '已选 ' + sels.length + ' 个车次' : '尚未添加';
  list.innerHTML = sels.map(function (s, idx) {
    var leg = s.leg;
    // 只渲染「该车次有设的席别」：不设的席别既不显示也不参与勾选
    // （之前渲染成禁用复选框，一排空框既占地方又容易误读成"无票"）
    var chip = PICK_SEAT_KEYS.filter(function (k) { return seatOffered(leg, k); }).map(function (k) {
      var v = leg.s ? leg.s[k] : '';
      var on = s.seats.indexOf(SEAT_NAME[k]) >= 0;
      var price = seatPrice(leg, k);
      // 展示格式：座次（票数） 价格。票数就是接口原值（有 / 无 / 数字 / 候补），
      // 不再用「等待放票」这种额外文案 —— 无票就是「无」，含义已经足够清楚。
      var vTxt = (v == null || v === '') ? '—' : esc(String(v));
      return '<label class="task-seat-option"><input type="checkbox" data-tn="' + esc(leg.n) + '" data-k="' + k + '" ' + (on ? 'checked' : '') + '>' +
        SEAT_NAME[k] + '（' + vTxt + '）' +
        (price ? '<em class="tk-price">¥' + price + '</em>' : '') + '</label>';
    }).join('');
    return '<div class="task-selection-item" data-tn="' + esc(leg.n) + '">' +
      '<div class="train"><b>' + esc(leg.n) + '</b><small>' + esc(leg.tn) + '</small></div>' +
      '<div class="route"><b>' + esc(leg.f) + ' ' + esc(leg.d) + ' → ' + esc(leg.to) + ' ' + esc(leg.a) + '</b><small>' + $('mDate').value + ' · ' + fmtDur(leg.m) + '</small></div>' +
      '<div class="task-seat-options">' + chip + '</div>' +
      '<button class="remove-selection" data-tn="' + esc(leg.n) + '" title="移除">×</button></div>';
  }).join('');
  // 一律用「车次号」定位，不用渲染时的下标：
  // 渲染后数组一旦变动，旧元素残留的 data-idx 会指向错位元素（快速连点会误删/漏删）
  var findByTn = function (tn) {
    var ix = -1;
    (APP.taskPicked || []).forEach(function (s, k) { if (s.leg.n === tn) ix = k; });
    return ix;
  };
  list.querySelectorAll('input[data-tn]').forEach(function (i) {
    if (i.disabled) return;
    i.addEventListener('change', function () {
      var ix = findByTn(i.dataset.tn);
      if (ix < 0) return;
      var s = APP.taskPicked[ix];
      var name = SEAT_NAME[i.dataset.k];
      var jx = s.seats.indexOf(name);
      if (i.checked && jx < 0) s.seats.push(name);
      if (!i.checked && jx >= 0) s.seats.splice(jx, 1);
      // 席别优先级由卡片勾选汇总而来（引擎只有一份全局席别表）：
      // syncSeatsFromPicked 更新 selSeats，renderNtSeats 在车次模式下会顺带重绘「由车次推导」。
      syncSeatsFromPicked(); renderNtSeats(); updateNtSummary();
    });
  });
  list.querySelectorAll('.remove-selection').forEach(function (b) {
    b.addEventListener('click', function () {
      var ix = findByTn(b.dataset.tn);
      if (ix < 0) return;
      APP.taskPicked.splice(ix, 1);
      // 移除最后一个车次会自动回到区间模式（模式由 taskPicked 是否为空判定）
      if (!APP.taskPicked.length) APP.pickOrder = [];
      applyNtMode(); syncSeatsFromPicked(); renderTaskPicked(); renderNtSeats();
    });
  });
  renderNtDerived();
  updateNtSummary();
}

function enterPickMode() {
  // 从新建任务页「继续添加」进入：直接开启批量模式，右侧复选框才可用
  MON.batch = true;
  $('mPanel').classList.add('task-pick-mode', 'batch-mode');
  $('mBatchToggle').classList.add('is-active');
  $('mBatchToggle').setAttribute('aria-pressed', 'true');
  // 进入时快照草稿：「添加到任务」提交本次修改，「取消」回滚到此快照
  snapshotPick();
  restorePickFromTask();
  toast('勾选要抢的车次，完成后点「添加到任务」保存；点「取消」放弃本次修改', '', 3600);
}
function exitPickMode() {
  $('mPanel').classList.remove('task-pick-mode');
  if (!MON.batch) $('mPanel').classList.remove('batch-mode');
}
function inTaskPick() { return $('mPanel').classList.contains('task-pick-mode'); }
// 任务草稿快照（深拷贝：leg 全是字符串字段，JSON 往返安全）
function snapshotPick() {
  APP.pickSnapshot = {
    picked: JSON.parse(JSON.stringify(APP.taskPicked || [])),
    order: (APP.pickOrder || []).slice()
  };
}
function restorePickSnapshot() {
  var s = APP.pickSnapshot;
  APP.taskPicked = s ? JSON.parse(JSON.stringify(s.picked)) : [];
  APP.pickOrder = s ? s.order.slice() : [];
  APP.pickSnapshot = null;
}
// 提交本次修改：把当前查询页的勾选态合并进草稿（只治理出现在当前结果里的车次）
function commitPick() {
  // 车次查询模式没有日期控件，乘车日期必须取「车票查询当前选中的日期」。
  // 之前在 pickAddToTask 里顺手推入日期，改走 commitPick 后日期就丢了 →
  // 创建任务会因「未选出行日期」被校验拦住（表现为无提示地提交失败）。
  // 日期应是「取用」而不是「累加」：先清掉之前带入的，再写入当前查询日期。
  var d = ($('mDate') || {}).value;
  if (d) APP.selDates = [d];
  syncDraftFromSelection();
  APP.pickSnapshot = null;
}
/* 已选车次 → 查询页勾选态（重新进入「添加车次」时恢复上次的选择）
   当前结果里没有草稿中的车次时，先用草稿的区间/日期查一次再回写 */
function restorePickFromTask() {
  var picked = APP.taskPicked || [];
  if (picked.length) {
    var have = picked.some(function (s) {
      return MON.rows.some(function (r) { return r.n === s.leg.n; });
    });
    if (have) { applyPickToRows(); return; }
    // 当前结果里没有草稿车次 → 用草稿的区间/日期重查一次再回写
    var pairs = pickedPairs();
    if (pairs.length) { $('mFrom').value = pairs[0].left; $('mTo').value = pairs[0].arrive; }
    var d = (APP.selDates || [])[0];
    if (d && isMonitorDateOpen(d)) setMonitorDate(d, { search: false });
    if (!$('mFrom').value || !$('mTo').value || !$('mDate').value) { applyMonitor(); syncSelCount(); return; }
    doMonitorSearch().then(function () { applyPickToRows(); });
    return;
  }
  // 还没选过车次：列表为空时直接用表单里的区间/日期查一次。
  // 否则从「+ 添加车次」进来会看到出发地/目的地已填好、车次列表却是空的，必须手动再点一次查询。
  if (MON.rows.length || !$('mFrom').value || !$('mTo').value || !$('mDate').value) {
    applyMonitor(); syncSelCount(); return;
  }
  doMonitorSearch().then(function () { applyPickToRows(); });
}
function applyPickToRows() {
  MON.sel = {}; MON.selSeats = {}; MON.selBy = {};
  (APP.taskPicked || []).forEach(function (s) {
    MON.rows.forEach(function (r, i) {
      if (r.n !== s.leg.n) return;
      MON.sel[i] = true;
      // 恢复出来的选择视为「已明确指定」：后续提交不再自动补默认席别
      // （草稿里已有的软卧/特等座会通过 prevSeats 保留）
      MON.selBy[i] = 'seat';
      MON.selSeats[i] = MON.selSeats[i] || {};
      PICK_SEAT_KEYS.forEach(function (k) {
        if (s.seats.indexOf(SEAT_NAME[k]) >= 0 && seatOffered(r, k)) MON.selSeats[i][k] = true;
      });
    });
  });
  applyMonitor();
  syncSelCount();
}
/* 查询页勾选态 → 任务草稿（实时同步）
   只治理「出现在当前查询结果里」的车次：结果里没有的（例如刚换了区间/日期）保持不动，
   避免因为换一次查询就把草稿里看不到的车次静默删掉 */
function syncDraftFromSelection() {
  if (!inTaskPick()) return;
  var idx = {};
  MON.rows.forEach(function (r, i) { if (!(r.n in idx)) idx[r.n] = i; });
  // 席别按「同车次号的所有行」取并集：用户可能是在第二行（另一到达站）点的席别，
  // 只读首行会得到空席别，导致草稿席别为空、创建时被校验拦住。
  // 分两段：表格能表达的席别以表格勾选为准；表格表达不了的（软卧/特等座，表格没有这两列）
  // 保留卡片里原有的选择 —— 否则刚从卡片加上的软卧会在提交时被表格数据覆盖掉。
  var seatsOfTrain = function (n, prevSeats, defaultAll) {
    var out = [];
    MON.rows.forEach(function (r, k) {
      if (r.n !== n) return;
      MON_SEAT_KEYS.forEach(function (kk) {
        if ((MON.selSeats[k] || {})[kk] && SEAT_NAME[kk] && out.indexOf(SEAT_NAME[kk]) < 0) out.push(SEAT_NAME[kk]);
      });
    });
    PICK_SEAT_KEYS.forEach(function (kk) {
      if (MON_SEAT_KEYS.indexOf(kk) >= 0) return;
      var nm = SEAT_NAME[kk];
      if (!nm || out.indexOf(nm) >= 0) return;
      // 表格表达不了的席别（软卧/特等座）：
      // ・已在草稿里 → 沿用卡片上的勾选（用户可能特意取消了）
      // ・新加入的车次 → 只有「勾复选框」才默认补全；「点座次」则不算
      var want = prevSeats ? (prevSeats.indexOf(nm) >= 0) : (!!defaultAll && offeredByAnyRow(n, kk));
      if (want) out.push(nm);
    });
    return out;
  };
  // 该车次（可能有多行）是否有设这个席别
  var offeredByAnyRow = function (n, kk) {
    return MON.rows.some(function (r) { return r.n === n && seatOffered(r, kk); });
  };
  var out = [];
  (APP.taskPicked || []).forEach(function (s) {
    var i = idx[s.leg.n];
    if (i === undefined) { out.push(s); return; }   // 当前结果里没有 → 不动它
    if (!MON.sel[i]) return;                        // 已取消勾选 → 移出
    // 用当前查询的 leg 替换：日期/区间上下文随当前查询走
    out.push({ leg: MON.rows[i], seats: seatsOfTrain(s.leg.n, s.seats, false) });
  });
  Object.keys(MON.sel).map(Number).forEach(function (i) {
    var leg = MON.rows[i]; if (!leg) return;
    if (out.some(function (s) { return s.leg.n === leg.n; })) return;
    // 新勾选 → 是否补全软卧/特等座取决于选中来源（复选框 vs 点座次）
    out.push({ leg: leg, seats: seatsOfTrain(leg.n, null, MON.selBy[i] === 'check') });
  });
  // 取消勾选会把车次从数组里摘掉，再勾回来就会跑到末尾 → 卡片顺序莫名跳动。
  // 用会话内的持久顺序排回去：只在草稿被清空时才重置顺序
  if (!out.length) {
    APP.pickOrder = [];
  } else {
    APP.pickOrder = APP.pickOrder || [];
    out.forEach(function (s) { if (APP.pickOrder.indexOf(s.leg.n) < 0) APP.pickOrder.push(s.leg.n); });
    out.sort(function (a, b) { return APP.pickOrder.indexOf(a.leg.n) - APP.pickOrder.indexOf(b.leg.n); });
  }
  APP.taskPicked = out;
}
function pickedTrains() { // 已选车次号（去重）
  var t = [];
  Object.keys(MON.sel).map(Number).sort(function (a, b) { return a - b; }).forEach(function (i) { var n = MON.rows[i] && MON.rows[i].n; if (n && t.indexOf(n) < 0) t.push(n); });
  return t;
}
// 收录一个车次到任务（同车次再次收录则合并席别，不产生重复卡片）
function addLegToTask(leg, seats) {
  APP.taskPicked = APP.taskPicked || [];
  APP.pickOrder = APP.pickOrder || [];
  if (APP.pickOrder.indexOf(leg.n) < 0) APP.pickOrder.push(leg.n);
  seats = (seats || []).slice();
  var ix = -1;
  APP.taskPicked.forEach(function (s, k) { if (s.leg.n === leg.n) ix = k; });
  if (ix >= 0) {
    seats.forEach(function (n) { if (APP.taskPicked[ix].seats.indexOf(n) < 0) APP.taskPicked[ix].seats.push(n); });
  } else {
    APP.taskPicked.push({ leg: leg, seats: seats });
  }
}
// 未手动点席别时：默认取该车「有设的」全部席别（与卡片渲染的集合保持一致，
// 否则会出现「卡片里看得到却默认没勾选」的怪状态）。
// 这里用 PICK_SEAT_KEYS 而不是监控表格的 MON_SEAT_KEYS，因为卡片多显示 软卧/特等座。
function defaultSeatsFor(leg) {
  return PICK_SEAT_KEYS.filter(function (k) { return seatOffered(leg, k); })
    .map(function (k) { return SEAT_NAME[k]; }).filter(Boolean);
}
function pickAddToTask() {
  var sel = Object.keys(MON.sel).map(Number).sort(function (a, b) { return a - b; });
  if (!sel.length) { toast('请先勾选车次', 'err'); return; }
  var before = (APP.taskPicked || []).length;
  sel.forEach(function (i) {
    var leg = MON.rows[i];
    var seats = Object.keys(MON.selSeats[i] || {}).map(function (k) { return SEAT_NAME[k]; }).filter(Boolean);
    // 两种入口语义不同：
    // ・勾复选框 = 「默认全部」→ 用 defaultSeatsFor（含表格没列的软卧/特等座）
    // ・逐个点席别 = 「已明确指定」→ 只取点的那些，不额外补软卧
    if (!seats.length || MON.selBy[i] === 'check') seats = defaultSeatsFor(leg);
    addLegToTask(leg, seats);
  });
  var added = (APP.taskPicked || []).length - before;
  // 只补一份兜底区间，供用户切到「区间查询」时继续使用；
  // 车次查询模式下真正的查询区间由 pickedPairs() 推导，因此不用它覆盖用户输入
  var leg0 = MON.rows[sel[0]];
  if (leg0 && !$('ntPairs').querySelector('.pair')) { addNtPair(leg0.f, leg0.to); }
  // 乘车日期取车票查询当前选中的日期（车次查询模式没有日期控件）。
  // 用「替换」而非「累加」，与 commitPick() 保持一致，否则两次导入会攒出一串旧日期。
  var d = $('mDate').value;
  if (d) APP.selDates = [d];
  // 导入的车次只在「车次查询」模式下生效，所以进来就切到该模式
  APP.ntMode = 'train';
  renderNtDates();
  exitPickMode();
  MON.sel = {}; MON.selSeats = {}; MON.selBy = {};
  go('new');
  toast(added + ' 个车次已加入任务' + (added < sel.length ? '（' + (sel.length - added) + ' 个已合并）' : ''), 'ok');
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
// 注意：CSS 不支持 [value!="all"]，必须用 JS 过滤（曾导致 change 处理器抛 SyntaxError）
function nonAllChecked(box) {
  return Array.prototype.filter.call(box.querySelectorAll('input:checked'), function (i) { return i.value !== 'all'; });
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
    box.addEventListener('change', function (e) {
      var t = e.target, isAll = box.querySelector('input[value="all"]');
      // 判定必须基于事件目标：querySelector('input:checked') 会取到「全部」自身，互斥永不生效
      if (t === isAll) {
        if (t.checked) box.querySelectorAll('input:not([value="all"])').forEach(function (i) { i.checked = false; });
      } else if (t.checked && isAll) {
        isAll.checked = false;
      }
      if (isAll && !nonAllChecked(box).length) isAll.checked = true;  // 无具体项 → 回到「全部」
      syncMonitorFilters();
      applyMonitor();
    });
  });
  var hourBox = $('mTime');
  // 注意：不能用「others 非空则取消 isAll」的无目标写法——
  // 那样点「不限」时因 others 仍被勾选而立即把 isAll 又取消掉，永远切不回去
  if (hourBox) hourBox.addEventListener('change', function (e) {
    var t = e.target, isAll = hourBox.querySelector('input[value="all"]');
    if (t === isAll) {
      if (t.checked) hourBox.querySelectorAll('input:not([value="all"])').forEach(function (i) { i.checked = false; });
    } else if (t.checked && isAll) {
      isAll.checked = false;
    }
    if (isAll && !nonAllChecked(hourBox).length) isAll.checked = true;
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
  // 不在此处再绑 change：bindMonitorFilters 已在容器上绑过（容器级监听对动态选项仍生效），
  // 重复绑定不但多此一举，旧写法还用了非法的 input[value!="all"] 选择器会抛 SyntaxError。
}
function swapStations() {
  var from = $('mFrom'), to = $('mTo');
  var a = from.value, b = to.value;
  from.value = b;
  to.value = a;
  $('mFromSug').classList.add('hidden');
  $('mToSug').classList.add('hidden');
  // 已经查过车次：交换方向后立即重查，否则列表里展示的会是反方向的结果
  if (MON.searched) doMonitorSearch();
}
function doMonitorSearch() {
  var left = $('mFrom').value.trim(), arrive = $('mTo').value.trim(), date = $('mDate').value;
  if (!left || !arrive || !date) { toast('请填写出发地、目的地和日期', 'err'); return; }
  if (!isMonitorDateOpen(date)) { toast('该日期尚未开售（' + DATES.note + '）', 'err'); return; }
  $('mSearch').disabled = true;
  $('mSummary').textContent = '查询中…';
  // 返回 Promise：从新建任务页重新进入时需等查询完成再回写上次的勾选态
  return api('/api/tickets?' + new URLSearchParams({ left: left, arrive: arrive, date: date }))
    .then(function (d) {
      MON.rows = d.rows || [];
      MON.searched = true;
      MON.sel = {}; MON.selSeats = {}; MON.selBy = {};
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
      MON.searched = false;
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
      var hasAny = F.seats.some(function (k) { return seatOffered(leg, k); });
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
      setRowChecked(+cb.dataset.i, cb.checked);
      syncSelCount();
      // 不实时写草稿：由底部「添加到任务」显式提交，「取消」则回滚
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
        // 行内「新建任务」：同样进入车次模式，带入该车次与已选（未选则默认）席别
        var legR = MON.rows[i];
        var seatsR = Object.keys(MON.selSeats[i] || {}).map(function (k) { return SEAT_NAME[k]; }).filter(Boolean);
        addLegToTask(legR, seatsR.length ? seatsR : defaultSeatsFor(legR));
        var dR = $('mDate').value;
        if (dR && APP.selDates.indexOf(dR) < 0) APP.selDates.push(dR);
        renderNtDates();
        go('new');
      }
    });
  });
  // 点席别单元格选席（预定/任务用）。无票也可选（任务可等放票）；不设座不可选
  $('mResults').querySelectorAll('td.seat').forEach(function (td) {
    var k = td.dataset.seat, i = +td.parentElement.dataset.i;
    if (!seatOffered(MON.rows[i], k)) return;   // 不设座：保持 '/'，不可点
    td.classList.add('seat-selectable');
    if ((MON.selSeats[i] || {})[k]) td.classList.add('seat-selected');
    td.addEventListener('click', function () {
      MON.selSeats[i] = MON.selSeats[i] || {};
      if (MON.selSeats[i][k]) delete MON.selSeats[i][k]; else MON.selSeats[i][k] = true;
      td.classList.toggle('seat-selected', !!MON.selSeats[i][k]);
      var tr = td.closest('tr');
      // 批量界面下：点席别即自动勾选该行；取消全部席别后自动取消勾选
      if (inBatchUI()) {
        syncRowCheckFromSeats(i, tr);
        // 同车次号的其它行跟随复选框与选中态（它们不参与本次席别编辑，
        // 但 MON.sel 必须同步，否则草稿会因首行的 sel 为空而被误删）
        var on = !!MON.sel[i];
        sameTrainIndexes(i).forEach(function (k) {
          if (k === i) return;
          MON.sel[k] = on;
          if (on) MON.selSeats[k] = MON.selSeats[k] || {};
          var t = document.querySelector('#mResults tr[data-i="' + k + '"]');
          var c = t && t.querySelector('input.row-check');
          if (c) c.checked = on;
        });
        // 逐个点席别 = 「已明确指定」语义：提交时不做默认补全
        sameTrainIndexes(i).forEach(function (k) { MON.selBy[k] = 'seat'; });
      }
      syncSelCount();
      // 不实时写草稿：由底部「添加到任务」显式提交
    });
  });
  syncSelCount();
}
function syncSelCount() {
  var c = Object.keys(MON.sel).length;
  $('mSelCount').textContent = '已选 ' + c + ' 条';
  var rule = $('mSelRule');
  if (rule) rule.textContent = c
    ? '点席别＝勾选该行；取消该行全部席别＝取消勾选'
    : '勾选车次默认选中该行全部有票席别；也可直接点席别自动勾选';
  var show = c > 0 && inBatchUI();
  if (show && !MON.batch) $('mPanel').classList.add('batch-mode');
  if (!show && !MON.batch) $('mPanel').classList.remove('batch-mode');
  $('mSelBar').classList.toggle('open', c > 0);
  // 悬浮操作栏是 position:fixed，会盖住列表最后一行 —— 而且到底后无法再滚，那一段永远看不到。
  // 这里给它下方的滚动区补出「栏高 + 间隙」的底部空间，保证最后一行能滚到栏的上方。
  // 注意不能用 classList.contains('open') 判断：批量模式下 CSS 强制 display:flex（无需勾选也显示），
  // 所以直接读计算样式的 display 才是准的。
  var scrollBox = document.querySelector('#mPanel .scroll');
  var selBar = $('mSelBar');
  if (scrollBox && selBar) {
    var barVisible = getComputedStyle(selBar).display !== 'none';
    var bh = barVisible ? selBar.offsetHeight : 0;
    // bh 为 0 说明面板当前不可见（如还在别的视图），交给 CSS 兜底值
    scrollBox.style.paddingBottom = bh ? (bh + 32) + 'px' : '';
  }
  // 「重置选择」紧贴「批量」左侧：只要处于批量界面就显示（哪怕一个都没勾选）。
  // 之前用「有选中内容」作为条件，点批量时会看不到按钮，容易让人以为没有这个功能。
  var slot = document.querySelector('#mPanel .batch-actions .reset-slot');
  if (slot) slot.classList.toggle('on', inBatchUI());
}
function orderPush(leg) {
  APP.orderSel = APP.orderSel || [];
  APP.orderSel.push({ leg: leg, seats: MON.selSeats[MON.rows.indexOf(leg)] || {}, date: $('mDate').value });
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
        var offered = seatOffered(leg, k);
        var tip = v === '无' ? '当前无票，任务会等待放票' : (offered ? '' : '该车次不设此席别');
        return '<label class="task-seat-option chip ' + (on ? 'on' : '') + '" title="' + esc(tip) + '" style="margin:0;background:' + (on ? 'var(--red-bg)' : 'var(--line-soft)') + ';border-radius:6px;font-size:11.5px;cursor:' + (offered ? 'pointer' : 'not-allowed') + ';color:' + (offered ? 'var(--text)' : 'var(--faint)') + ';display:flex;align-items:center;justify-content:center;height:30px"><span>' + names[k] + (offered ? '<small style="opacity:.7"> ' + esc(v === '有' ? '有' : v) + '</small>' : '') + '</span></label>';
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

/* ---------- 6.1 下单（P3） ---------- */
var ORDER_STATUS = {
  queued: { text: '排队中', cls: 'info' },
  submitted: { text: '已提交', cls: 'info' },
  success: { text: '已出票', cls: 'ok' },
  cancelled: { text: '已取消', cls: 'muted' },
  failed: { text: '失败', cls: 'warn' }
};
function orderStatusTag(st) {
  var s = ORDER_STATUS[st] || { text: st || '未知', cls: 'muted' };
  return '<span class="tag ' + s.cls + '"><span class="d"></span>' + esc(s.text) + '</span>';
}
function orderPayload() {
  var sels = APP.orderSel || [];
  var trains = [], seats = [], stations = [], seen = {}, date = '';
  sels.forEach(function (s) {
    if (!date && s.date) date = s.date;
    if (trains.indexOf(s.leg.n) < 0) trains.push(s.leg.n);
    Object.keys(s.seats || {}).forEach(function (k) {
      var nm = SEAT_NAME[k];
      if (nm && seats.indexOf(nm) < 0) seats.push(nm);
    });
    var key = s.leg.f + '|' + s.leg.to;
    if (!seen[key]) { seen[key] = 1; stations.push({ left: s.leg.f, arrive: s.leg.to }); }
  });
  return {
    account_key: $('oAccount').value || '',
    train_date: date,
    stations: stations,
    seats: seats,
    train_numbers: trains,
    members: orderPassengers(),
    allow_less_member: 0
  };
}
function submitOrder(btn) {
  var f = orderPayload();
  if (!f.account_key) { toast('请选择使用账号（先到「账号管理」登录）', 'err'); return; }
  if (!f.train_numbers.length) { toast('请先返回车票查询勾选车次', 'err'); return; }
  if (!f.seats.length) { toast('请点击该车次的席别单元格选择席别（如「二等座」）', 'err'); return; }
  if (!f.members.length) { toast('请至少选择一位乘车人', 'err'); return; }
  if (!f.train_date) { toast('缺少出发日期，请回车票查询选择日期后重新预定', 'err'); return; }
  var d = new Date(f.train_date + 'T00:00:00'), today = new Date();
  today.setHours(0, 0, 0, 0);
  if (isNaN(d.getTime()) || d < today) { toast('出发日期无效或已过期，请重新查询后再预定', 'err'); return; }
  if (btn) btn.disabled = true;
  api('/api/orders', { method: 'POST', body: JSON.stringify(f) })
    .then(function (r) {
      toast(r.msg || '已提交，命中余票后自动下单', 'ok');
      APP.orderSel = [];
      renderOrderView();
      loadOrderHistory();
    })
    .catch(function (e) { toast(e.message, 'err'); })
    .finally(function () { if (btn) btn.disabled = false; });
}
function loadOrderHistory() {
  var box = $('oHistory');
  if (!box) return;
  api('/api/orders?limit=20').then(function (d) {
    var rows = d.orders || [];
    box.innerHTML = rows.length ? rows.map(function (o) {
      var cancelable = o.status === 'queued' || o.status === 'submitted';
      return '<tr>' +
        '<td>' + orderStatusTag(o.status) + '</td>' +
        '<td class="mono">' + esc(o.train_number || '—') + '</td>' +
        '<td>' + esc(o.train_date || '—') + '</td>' +
        '<td>' + esc((o.seats || []).join('/') || '—') + '</td>' +
        '<td>' + esc((o.passengers || []).join('、') || '—') + '</td>' +
        '<td style="color:var(--sub)">' + esc(o.message || '') + '</td>' +
        '<td style="text-align:right">' + (cancelable
          ? '<button class="btn btn-ghost btn-sm" data-cancel="' + o.id + '">撤销</button>' : '') +
        '</td></tr>';
    }).join('') : '<tr><td colspan="7" style="color:var(--faint);text-align:center;padding:22px">暂无下单记录</td></tr>';
    box.querySelectorAll('[data-cancel]').forEach(function (b) {
      b.addEventListener('click', function () { cancelOrder(b.dataset.cancel, b); });
    });
  }).catch(function () { });
}
function cancelOrder(id, btn) {
  if (!confirm('确定撤销该下单记录吗？其关联的即时任务会被暂停。')) return;
  if (btn) btn.disabled = true;
  api('/api/orders/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: '{}' })
    .then(function (r) { toast(r.msg || '已取消', 'ok'); loadOrderHistory(); loadJobs(); loadDashboard(); })
    .catch(function (e) { toast(e.message, 'err'); })
    .finally(function () { if (btn) btn.disabled = false; });
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

/* ---------- 任务行操作：编辑 / 删除（新建页回填） ---------- */
// 任务索引：删除确认要显示任务名，从 dataset 传名会有转义/引号风险，改用渲染时建立的索引
var JOB_INDEX = {};
function jobNameOf(id) { return (JOB_INDEX[id] || {}).job_name || '该任务'; }

function jobDelete(id) {
  if (!confirm('确认删除「' + jobNameOf(id) + '」？\n\n删除后无法恢复，正在进行的查询会立即停止。')) return;
  api('/api/jobs/' + encodeURIComponent(id), { method: 'DELETE' })
    .then(function () { toast('任务已删除', 'ok'); loadJobs(); loadDashboard(); })
    .catch(function (e) { toast(e.message, 'err'); });
}

/* 编辑：把任务回填到「新建任务」页后保存（PATCH），不改变原任务当前的启用状态。
   统一落到**区间查询**模式 —— 只有该模式有可编辑的区间/日期/时段/座次/车次筛选控件；
   车次查询的白名单在引擎侧同样表现为 stations × left_dates + train_numbers，
   所以用「只抢指定车次」表达是等价的，抢票行为不变。 */
function jobEdit(id) {
  api('/api/jobs/' + encodeURIComponent(id)).then(function (j) {
    APP.editJobId = id;
    go('new', { keepEdit: true, job: j });
  }).catch(function (e) { toast(e.message, 'err'); });
}

function applyJobToForm(j) {
  APP.taskPicked = []; APP.pickOrder = [];
  setNtMode('range');
  if ($('ntName')) $('ntName').value = j.job_name || '';
  // 区间地点
  $('ntPairs').innerHTML = '';
  var st = (j.stations && j.stations.length) ? j.stations : [{ left: '', arrive: '' }];
  st.forEach(function (p) { addNtPair(p.left || '', p.arrive || ''); });
  // 乘车日期
  APP.selDates = (j.left_dates || []).slice();
  // 出发时段（<input type=time> 不接受 24:00，界面用 23:59 表示当天结束）
  var pf = (j.period && j.period.from) || '00:00';
  var pt = (j.period && j.period.to) || '24:00';
  if ($('ntFromT')) $('ntFromT').value = (pf === '24:00') ? '23:59' : pf;
  if ($('ntToT')) $('ntToT').value = (pt === '24:00') ? '23:59' : pt;
  // 座次优先级：接口已归一成二维，这里再防御一次（一维/字符串历史数据）
  var raw = (j.seat_tiers && j.seat_tiers.length) ? j.seat_tiers : [(j.seats || [])];
  if (raw.length && typeof raw[0] === 'string') raw = [raw];
  APP.seatTiers = raw.map(function (t) { return (Array.isArray(t) ? t : []).slice(); })
                     .filter(function (t) { return t.length; });
  if (!APP.seatTiers.length) APP.seatTiers = [[]];
  flattenSeatTiers();
  APP.seatPickTier = -1;
  // 账号 + 乘车人（乘客列表异步拉取 → 先记下待选中项）
  processNtAccount(j.account_key || '');
  APP.pendingPax = (j.members || []).slice();
  loadPassengersFor(j.account_key || '');
  // 余票不足
  if ($('ntLessMember')) $('ntLessMember').checked = !!j.allow_less_member;
  // 车次筛选（三种模式互斥）
  var mode = 'all';
  if ((j.train_numbers || []).length) mode = 'allow';
  else if ((j.except_train_numbers || []).length) mode = 'except';
  setNtTrainMode(mode);
  fillTagbox('ntTrainBox', j.train_numbers || []);
  fillTagbox('ntExceptBox', j.except_train_numbers || []);
  // 策略
  var iv = j.interval || {};
  if ($('ntIntMin')) $('ntIntMin').value = iv.min || APP.queryInterval || 1;
  if ($('ntIntMax')) $('ntIntMax').value = iv.max || iv.min || APP.queryInterval || 1;
  setNtStartAt(j.start_at || '');
  renderNtDates();
  renderNtSeats();
  updateNtSummary();
}

// 账号下拉：能选就直接选上；列表还没加载完就记到 pendingAccount 由 loadAccountsForNew 补
function processNtAccount(key) {
  var sel = $('ntAccount');
  if (!sel) return;
  var has = Array.prototype.some.call(sel.options, function (o) { return o.value === key; });
  sel.value = key;
  if (!has) APP.pendingAccount = key;
}

function setNtTrainMode(mode) {
  var box = $('ntTrainMode'); if (!box) return;
  box.querySelectorAll('.seg-btn').forEach(function (b) { b.classList.toggle('on', b.dataset.mode === mode); });
  syncTrainMode();
}

// 往车次标签框里灌一批车次（与 wireTagbox 的删除交互保持一致）
function fillTagbox(boxId, list) {
  var box = $(boxId); if (!box) return;
  box.querySelectorAll('.t').forEach(function (t) { t.remove(); });
  var input = box.querySelector('input');
  (list || []).forEach(function (v) {
    var s = document.createElement('span');
    s.className = 't'; s.dataset.t = v;
    s.innerHTML = esc(v) + ' <em>✕</em>';
    box.insertBefore(s, input);
    s.querySelector('em').addEventListener('click', function () { s.remove(); updateNtSummary(); });
  });
  updateNtSummary();
}

function setNtStartAt(v) {
  var at = !!v;
  var seg = $('ntStartMode');
  if (seg) seg.querySelectorAll('.seg-btn').forEach(function (b) { b.classList.toggle('on', (b.dataset.start === 'at') === at); });
  if ($('ntStartAt')) $('ntStartAt').value = at ? String(v).replace(' ', 'T') : '';
  syncNtStartMode();
}

// 编辑态：标题与主按钮文案随编辑态切换，并显示「取消编辑」
function setEditMode(on) {
  var h = $('newTitle'), c = $('newSub'), btn = $('taskFlowNext'), cancel = $('taskFlowCancel');
  if (h) h.textContent = on ? '编辑抢票任务' : '新建抢票任务';
  if (c) c.textContent = on ? '保存后立即热重载；原任务的启用状态保持不变' : '创建后将立即参与热重载，无需重启服务';
  if (btn) btn.textContent = on ? '保存修改' : '创建任务';
  if (cancel) cancel.classList.toggle('hidden', !on);
}
function clearJobEdit() {
  APP.editJobId = null;
  APP.pendingAccount = null;
  APP.pendingPax = null;
  setEditMode(false);
}
function cancelJobEdit() {
  if (!APP.editJobId) { go('jobs'); return; }
  clearJobEdit();
  go('jobs');
}
// 结束时间：界面 23:59 代表「当天结束」→ 提交 24:00
function ntPeriodTo() {
  var v = $('ntToT').value || '';
  return (!v || v === '23:59') ? '24:00' : v;
}
function ntPeriodLabel() {
  var a = $('ntFromT').value || '00:00', b = ntPeriodTo();
  return (a === '00:00' && b === '24:00') ? '全天' : (a + '–' + b);
}
function collectNtForm() {
  var train = ntMode() === 'train';
  var iv = ntIntervalValue();
  // 车次查询模式下「车次筛选」三选一不存在：车次列表本身就是白名单
  var mode = train ? 'all' : ntTrainMode();
  var f = {
    name: $('ntName').value.trim(),
    account_key: $('ntAccount').value || '',
    left_dates: (APP.selDates || []).slice(),
    // 顺序即优先级（引擎 handle_seats 按序尝试）
    stations: ntPairs(),          // 车次查询模式下由车次推导（见 pickedPairs）
    members: (APP.paxSel || []).slice(),
    allow_less_member: !!$('ntLessMember').checked,
    seats: (APP.selSeats || []).slice(),
    // 优先级结构（二维）：引擎不读，仅为了让任务详情页能重建「哪几个属同一级」的分级配色。
    // 车次模式没有优先级概念，用一维包一层当第 1 级。
    seat_tiers: train ? [(APP.selSeats || []).slice()]
                     : seatTiers().map(function (t) { return t.slice(); }).filter(function (t) { return t.length; }),
    train_numbers: mode === 'allow' ? ntTags('ntTrainBox') : [],
    except_train_numbers: mode === 'except' ? ntTags('ntExceptBox') : [],
    period_from: '00:00',
    period_to: '24:00',
    // 策略：任务级查询间隔与开始时间（需引擎侧改动后生效，但先落库）
    interval_min: iv.min,
    interval_max: iv.max,
    start_at: ntStartAtValue()
  };
  if (train) {
    // 已选车次即白名单；且强制全天 —— is_trains_number_valid() 先判时间再判车次号，
    // 时间窗能直接否决白名单里的车次，这里彻底不给出错的机会
    f.train_numbers = pickedTrainNumbers();
    f.except_train_numbers = [];
  } else {
    f.period_from = $('ntFromT').value || '00:00';
    // <input type=time> 不接受 24:00（HH 上限 23），所以界面用 23:59；
    // 提交时映射回引擎支持的 24:00（= 当天结束），避免把 23:59 当成真的 23:59 而遗漏最后一分钟
    f.period_to = ntPeriodTo();
  }
  return f;
}
function createNewTask(btn) {
  var train = ntMode() === 'train';
  var f = collectNtForm();
  // 校验前移：与后端校验保持一致，尽早给出可读提示
  if (!f.account_key) { toast('请选择使用账号（未在线的账号需先到「账号管理」完成登录）', 'err', 4000); return; }
  if (!f.stations.length) { toast(train ? '车次缺少出发 / 到达站信息，请重新添加' : '请至少填写一组出发 / 到达', 'err'); return; }
  if (!f.left_dates.length) {
    toast(train ? '该车次缺少乘车日期：请到车票查询选中日期后再「添加到任务」' : '请至少选择一个出行日期', 'err', 4000);
    return;
  }
  if (!f.members.length) { toast('请至少选择一位乘车人', 'err'); return; }
  if (!f.seats.length) { toast(train ? '请在上方车次卡片里勾选要抢的席别' : '请在「座次」里至少启用一个席别', 'err'); return; }
  if (f.train_numbers.length && f.except_train_numbers.length) {
    toast('「只抢指定车次」与「排除指定车次」只能选一种', 'err'); return;
  }
  if (!train && f.period_from > f.period_to) { toast('出发时间段的开始时间不能晚于结束时间', 'err'); return; }
  if (ntStartMode() === 'at' && !ntStartAtValue()) { toast('已选「定时开始」，请填写开始时间', 'err'); return; }
  if (ntStartMode() === 'at' && ntStartAtValue() && ntStartAtValue() <= '2026' ) { toast('开始时间格式不正确', 'err'); return; }
  var editing = APP.editJobId || null;
  if (btn) btn.disabled = true;
  api(editing ? ('/api/jobs/' + encodeURIComponent(editing)) : '/api/jobs',
      { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(f) })
    .then(function () {
      // 清空已选车次并让新建页回到车次查询模式（默认值），避免返回时仍显示上一批卡片
      APP.taskPicked = [];
      APP.pickOrder = [];
      setNtMode('train');
      clearJobEdit();
      toast(editing ? '任务已保存' : '任务已创建并开始抢票', 'ok');
      go('jobs');
    })
    .catch(function (e) { toast(e.message, 'err'); })
    .finally(function () { if (btn) btn.disabled = false; });
}
// 表格展示的席别列（单一事实来源）：列渲染、可选席别、任务席别来源均用它，
// 保证「看到的 / 能点的 / 会带进任务的」完全一致
var MON_SEAT_KEYS = ['business', 'first', 'second', 'hardSleeper', 'hardSeat', 'noSeat'];
var SEAT_NAME = { business: '商务座', first: '一等座', second: '二等座', hardSleeper: '硬卧', hardSeat: '硬座', softSleeper: '软卧', special: '特等座', noSeat: '无座' };
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
        '<td style="color:var(--faint)" title="' + esc(a.last_heartbeat || '') + '">' + esc(fmtAgo(a.last_heartbeat)) + '</td>' +
        '<td style="text-align:right;white-space:nowrap"><button class="btn btn-outline btn-sm acc-act" data-act="rescan" data-key="' + a.key + '">重新扫码</button> <button class="btn btn-outline btn-sm acc-act" data-act="logout" data-key="' + a.key + '">登出</button> <button class="btn btn-ghost btn-sm acc-act" data-act="del" data-key="' + a.key + '">删除</button></td></tr>';
    }).join('') : '<tr><td colspan="6" class="empty" style="border:0"><b>还没有 12306 账号</b>在右侧面板扫码或输密码添加，登录成功后自动拉取乘客。</td></tr>';
    $('accList').querySelectorAll('.acc-act').forEach(function (b) {
      b.addEventListener('click', function () { accAction(b.dataset.act, b.dataset.key, b); });
    });
  }).catch(function (e) { toast(e.message, 'err'); });
}
function accAction(act, key, btn) {
  if (btn) { btn.disabled = true; }
  var done = function (ok, msg) {
    if (btn) { btn.disabled = false; }
    if (msg) { toast(msg, ok ? 'ok' : 'err'); }
    loadAccounts(); loadDashboard();
    // 重新扫码：重置成功后立刻出码。原来只调 openQrPanel()（仅切标签、设置 key），
    // 不出二维码 → 用户看到的就是「点了没反应」。
    if (act === 'rescan' && ok) { runQrSession(key); }
  };
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
  if ($('taskFlowCancel')) $('taskFlowCancel').addEventListener('click', cancelJobEdit);
  // 新建任务（task-flow 布局）
  $('taskHeaderBack').addEventListener('click', function () { go('jobs'); });
  ['taskAddTrain', 'taskOpenTicketQuery2'].forEach(function (id) {
    if ($(id)) $(id).addEventListener('click', function () { go('monitor', { pick: true }); });
  });
  $('ntAddPair').addEventListener('click', function () { addNtPair(); refreshNtQueryLoad(); updateNtSummary(); });
  // 新增一级座次优先级；直接展开该级的选择面板
  if ($('ntAddTier')) $('ntAddTier').addEventListener('click', function (e) {
    e.stopPropagation();
    seatTiers().push([]);
    APP.seatPickTier = seatTiers().length - 1;
    renderNtSeats();
  });
  // 点击选择器范围之外 → 收起所有面板（日期 / 座次）。
  // 之前日期面板没有任何取消入口，只能选中一个日期才消失，再点「+ 选择日期」还会叠加出第二个。
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.closest && t.closest('.chip.add, .picker')) return;
    if (datePickOpen()) closeNtDatePicker();
    if (ntSeatPickTier() >= 0) { APP.seatPickTier = -1; renderNtSeats(); }
  });
  $('ntAccount').addEventListener('change', function () { loadPassengersFor($('ntAccount').value); updateNtSummary(); });
  // 策略字段改动 → 实时刷新摘要（ntIntMin / ntIntMax 本次重新启用）
  ['ntName', 'ntFromT', 'ntToT', 'ntLessMember', 'ntIntMin', 'ntIntMax', 'ntStartAt'].forEach(function (id) {
    if (!$(id)) return;
    $(id).addEventListener('input', updateNtSummary);
    $(id).addEventListener('change', updateNtSummary);
  });
  wireTagbox('ntTrainBox', 'ntTrainInput');
  wireTagbox('ntExceptBox', 'ntExceptInput');
  // 车站联想
  bindStationSuggest($('mFrom'));
  bindStationSuggest($('mTo'));
  // 交换出发地 / 目的地
  $('mSwap').addEventListener('click', swapStations);
  // 监控（车票查询）
  $('mSearch').addEventListener('click', doMonitorSearch);
  $('mFrom').addEventListener('keydown', function (e) { if (e.key === 'Enter') doMonitorSearch(); });
  $('mTo').addEventListener('keydown', function (e) { if (e.key === 'Enter') doMonitorSearch(); });
  $('mBatchToggle').addEventListener('click', function () {
    MON.batch = !MON.batch;
    $('mPanel').classList.toggle('batch-mode', MON.batch);
    $('mBatchToggle').classList.toggle('is-active', MON.batch);
    $('mBatchToggle').setAttribute('aria-pressed', MON.batch ? 'true' : 'false');
    // 任务添加态本质就是「批量模式」：关掉批量即结束本次添加（复选框与悬浮栏一起消失，保持一致）
    if (!MON.batch && inTaskPick()) exitPickMode();
    syncSelCount();   // 刷新「重置选择」的显隐/滑出状态
  });
  $('mFloatBind').addEventListener('click', openTaskBindModal);
  // 任务上下文（从新建任务页进来）：「添加到任务」= 保存本次修改，然后返回
  $('mFloatAddTask').addEventListener('click', function () {
    commitPick();
    // 勾选已转入任务，查询页的临时勾选清掉：否则会残留「看不见的选中态」，
    // 让「重置选择」按钮一直亮着
    MON.sel = {}; MON.selSeats = {}; MON.selBy = {};
    exitPickMode();
    var n = (APP.taskPicked || []).length;
    go('new');
    toast(n ? '已保存本次修改，任务共 ' + n + ' 个车次' : '已保存，未选车次将按区间查询全部车次', 'ok');
  });
  // 「取消」= 不保存本次修改，使用上次的内容
  $('mFloatCancel').addEventListener('click', function () {
    restorePickSnapshot();
    exitPickMode();
    go('new');
    toast('已取消，本次修改未保存', '', 2600);
  });
  // 与「添加到任务」同一条路径：都进入车次模式。
  // 早前的 prefillNewTask 只拿第一行车次的区间填 ntPairs，而引擎的 train_numbers 只做结果过滤，
  // 因此一次勾选跨线路的多个车次时，除首条线路外其余车次永远查不到（且界面上完全看不出来）
  $('mFloatPrefill').addEventListener('click', pickAddToTask);
  $('mSelReset').addEventListener('click', function () {
    MON.sel = {}; MON.selSeats = {}; MON.selBy = {};
    applyMonitor();
  });
  // 批量关联弹窗
  $('closeTaskModal').addEventListener('click', function () { closeTaskBindModal(); });
  $('cancelTaskModal').addEventListener('click', function () { closeTaskBindModal(); });
  $('confirmTaskBind').addEventListener('click', confirmTaskBind);
  // 订单
  $('oBack').addEventListener('click', function () { go('monitor'); });
  $('oAccount').addEventListener('change', function () { loadOrderPassengers($('oAccount').value); });
  $('oPassengers').addEventListener('change', updateOrderSummary);
  $('oSubmit').addEventListener('click', function () { submitOrder(this); });
  $('oHistoryRefresh').addEventListener('click', function () { loadOrderHistory(); });
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
