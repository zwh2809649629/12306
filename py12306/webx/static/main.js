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

/* ---------- 席别票价：**12306 真实价格**（不再估算） ----------
   历史：早期用「历时 × 单价」估算，但实测两个方向都错很多 ——
     · G531 北京南→上海虹桥 二等座 估 ¥292，实际 **¥661**（低 56%）
     · G5148 深圳→马踏      二等座 估 ¥127，实际 **¥278**（低 54%）
   根因：真实票价**按里程**，而估算按**历时** —— 同样 1 分钟，跑 200km/h 的
   深茂铁路比跑 350km/h 的京沪高铁走得短得多，所以估算是根本性错误。
   现在改成查 12306 的 `/otn/leftTicketPrice/query`（详见后端 `/api/tickets/prices`）。
   价格放在 MON.prices，key = `train_no:上站电报码:下站电报码`。 */
function priceKey(leg) {
  if (!leg || !leg.no) return '';
  // 上/下站：优先用该行的实际站电报码（t[6]/t[7]）；
  // 若在经停站里改过区间，电报码已清空 → 退化用站名（后端会用站点表解析）。
  var f = leg.f_code || leg.f || '';
  var t = leg.to_code || leg.to || '';
  if (!f || !t) return '';
  return leg.no + ':' + f + ':' + t;
}
// 真实票价（元）。**没有就是 null，绝不用估算值顶替** ——
// 错的数字比没有数字更糟（用户会据此选车次）。
function priceOf(leg, k) {
  var key = priceKey(leg);
  if (!key) return null;
  var p = MON.prices[key];
  if (!p) return null;
  var v = p[k];
  return (v == null || v === '') ? null : v;
}
function fmtPrice(v) {
  if (v == null) return '';
  // 12306 价格可能带 .5（如 K952 硬座 ¥72、软臷 ¥226.5）
  return (Math.round(v * 10) % 10 === 0) ? String(Math.round(v)) : v.toFixed(1);
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
  var inner;
  if (v == null || v === '') inner = '<strong class="none">无</strong>';
  else if (v === '无') inner = '<strong class="none">无</strong>';
  else if (v === '有') inner = '<strong>有</strong>';
  else if (v === '候补') inner = '<strong class="wait">候补</strong>';
  else inner = '<strong>' + esc(v) + '</strong>';
  // 真实的才显示；还没查到就先留空，由 paintPrices() 回填
  var price = priceOf(leg, k);
  if (price != null) inner += '<small class="seat-price">¥' + fmtPrice(price) + '</small>';
  return '<td class="seat" data-seat="' + k + '">' + inner + '</td>';
}

/* 售价填充：先把车次列表渲染出来（快），再异步拉真实票价并**就地回填**。
   为什么不直接把价格写进 /api/tickets：每个车次要单独查一次 12306（无批量接口，
   实测 55 个车次要 ~2s），放在列表接口里会把整体响应拖慢。
   服务端有 6 小时缓存（票价当天不变），所以同一批车次第二次搜几乎瞬回。 */
function loadPrices(rowsOverride, dateOverride) {
  var rows = rowsOverride || (MON.rows || []);
  if (!rows.length) return;
  var need = [], seen = {};
  rows.forEach(function (leg) {
    var key = priceKey(leg);
    if (!key || seen[key]) return;
    seen[key] = 1;
    if (!MON.prices[key]) need.push(key);
  });
  if (!need.length) { paintPrices(); return; }
  var date = dateOverride || (($('mDate') || {}).value || '');
  api('/api/tickets/prices?date=' + encodeURIComponent(date) +
      '&items=' + encodeURIComponent(need.join('|')))
    .then(function (d) {
      var got = (d && d.prices) || {};
      Object.keys(got).forEach(function (k) { MON.prices[k] = got[k]; });
      if ($('mResults')) paintPrices();
      // 任务卡片 / 摘要里的价格也用同一份数据，一并刷新
      if (typeof renderTaskPicked === 'function') renderTaskPicked();
    })
    .catch(function () { /* 票价拿不到就不显示，不弹错（不影响查票主流程）*/ });
}

/** 把已拿到的真实票价写进席别单元格（就地修改，避免整体重渲染） */
function paintPrices() {
  var box = $('mResults');
  if (!box) return;
  box.querySelectorAll('tr.ticket-row').forEach(function (tr) {
    var leg = MON.rows[+tr.dataset.i];
    if (!leg) return;
    tr.querySelectorAll('td.seat').forEach(function (td) {
      var k = td.dataset.seat;
      var price = priceOf(leg, k);
      var sm = td.querySelector('small.seat-price');
      if (price == null) { if (sm) sm.parentNode.removeChild(sm); return; }
      if (!sm) {
        sm = document.createElement('small');
        sm.className = 'seat-price';
        td.appendChild(sm);
      }
      sm.textContent = '¥' + fmtPrice(price);
    });
  });
}
function rowHtml(leg) {
  var i = MON.rows.indexOf(leg);
  var rowCls = 'ticket-row' + (leg.bookable ? ' hit' : '');
  return '<tr class="' + rowCls + '" data-i="' + i + '">' +
    // 车次号本身就是一个按钮：点它看经停站（与 12306 官网的交互一致）。
    // 放在车次格里而不是操作列：操作列只放「预定」一个动作按钮，
    // 而车次格宽度富余，点车次看详情也更符合直觉。
    // （行内「新建任务」按钮已移除 2026-09：加任务统一走底部批量栏「添加到任务」。）
    '<td class="train"><button class="train-stops" type="button" data-act="stops" data-i="' + i + '"'
      + (leg.no ? ' title="查看经停站与到站参考票价"' : ' title="该车次缺少 12306 内部编号，无法查经停站"') + '>'
      + '<b>' + esc(leg.n) + '</b><small>' + esc(leg.tn) + '</small></button></td>' +
    legCell(leg.f, leg.d) +
    legCell(leg.to, leg.a) +
    '<td class="duration">' + fmtDur(leg.m) + '</td>' +
    MON_SEAT_KEYS.map(function (k) { return seatCell(leg, k); }).join('') +
    '<td class="actions">' +
      '<span class="row-pick"><input class="row-check" type="checkbox" data-i="' + i + '"' + (MON.sel[i] ? ' checked' : '') + '></span>' +
      '<button class="btn btn-outline" data-act="book">预定</button>' +
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
// 非批量模式只允许保留一行车次的席别选择；切换车次时同步清掉旧行的视觉状态。
function clearOtherSeatSelections(keepIndex) {
  Object.keys(MON.selSeats).forEach(function (key) {
    var i = +key;
    if (i === keepIndex) return;
    delete MON.selSeats[i];
    delete MON.sel[i];
    delete MON.selBy[i];
    forgetSelection(i);
    var tr = document.querySelector('#mResults tr[data-i="' + i + '"]');
    if (tr) paintRowSeats(i, tr);
  });
}
// 同步列表头「批量」按钮的选中态
function syncModeSeg() {
  var batch = $('mBatchToggle');
  if (!batch) return;
  batch.classList.toggle('on', MON.batch);
  batch.setAttribute('aria-pressed', MON.batch ? 'true' : 'false');
}
function rememberSelection(i) {
  var pos = MON.selOrder.indexOf(i);
  if (pos >= 0) MON.selOrder.splice(pos, 1);
  MON.selOrder.push(i);
}
function forgetSelection(i) {
  var pos = MON.selOrder.indexOf(i);
  if (pos >= 0) MON.selOrder.splice(pos, 1);
}
// 勾选车次 → 默认复选该行【全部】有票席别；取消勾选 → 清空该行席别
function selectRow(i, on) {
  if (on) {
    MON.sel[i] = true;
    rememberSelection(i);
    MON.selSeats[i] = {};
    availableSeatKeys(MON.rows[i]).forEach(function (k) { MON.selSeats[i][k] = true; });
    // 记住来源：复选框 = 「默认全部」语义（提交时补上表格没列的软卧/特等座）
    MON.selBy[i] = 'check';
  } else {
    delete MON.sel[i];
    delete MON.selBy[i];
    MON.selSeats[i] = {};
    forgetSelection(i);
  }
}
// 勾选/取消只作用于当前结果行；同车次号的不同出发/到达区间仍是独立选择。
function setRowChecked(i, on) {
  selectRow(i, on);
  var tr = document.querySelector('#mResults tr[data-i="' + i + '"]');
  var cb = tr && tr.querySelector('input.row-check');
  if (cb) cb.checked = on;
  paintRowSeats(i, tr);
}
// 由席别反推复选框：只要还有席别被选中就勾上，全部取消则自动取消勾选
function syncRowCheckFromSeats(i, tr) {
  if (!tr) return;
  var any = Object.keys(MON.selSeats[i] || {}).length > 0;
  var cb = tr.querySelector('input.row-check');
  if (cb) cb.checked = any;
  if (any) {
    MON.sel[i] = true;
    MON.selBy[i] = 'seat';
    rememberSelection(i);
  } else {
    delete MON.sel[i];
    delete MON.selBy[i];
    forgetSelection(i);
  }
}

// 从非批量席别选择切入批量模式时，把已有席别同步为对应行的复选框选择。
function syncBatchChecksFromSeats() {
  document.querySelectorAll('#mResults tr[data-i]').forEach(function (tr) {
    var i = +tr.dataset.i;
    syncRowCheckFromSeats(i, tr);
  });
}

// 批量模式退出后只保留最后一次选择的结果，避免非批量模式提交多条车次。
function keepOnlyOneSelection() {
  var selected = Object.keys(MON.sel).map(Number).sort(function (a, b) { return a - b; });
  if (!selected.length) return;
  var keep = null;
  for (var j = MON.selOrder.length - 1; j >= 0; j--) {
    if (selected.indexOf(MON.selOrder[j]) >= 0) {
      keep = MON.selOrder[j];
      break;
    }
  }
  if (keep == null) keep = selected[selected.length - 1];
  selected.forEach(function (i) {
    if (i === keep) return;
    delete MON.sel[i];
    delete MON.selSeats[i];
    delete MON.selBy[i];
    forgetSelection(i);
  });
  Object.keys(MON.selSeats).forEach(function (key) {
    if (+key !== keep) delete MON.selSeats[key];
  });
  Object.keys(MON.selBy).forEach(function (key) {
    if (+key !== keep) delete MON.selBy[key];
  });
  document.querySelectorAll('#mResults tr[data-i]').forEach(function (tr) {
    var i = +tr.dataset.i;
    var cb = tr.querySelector('input.row-check');
    if (cb) cb.checked = i === keep;
    paintRowSeats(i, tr);
  });
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
  restoreMonitorRoute();
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
  var v = currentView();
  if (v === 'dashboard') pollTimers.dash = setInterval(loadDashboard, 3000);
  if (v === 'logs' && !logPaused) pollTimers.log = setInterval(loadLogs, 6000);
  // 任务列表/详情：引擎会主动结束任务（下单成功、乘客校验失败）、账号会掉线，
  // 状态必须自己刷新，否则页面会一直停在进入时的旧结论上
  if (v === 'jobs') pollTimers.jobs = setInterval(loadJobs, 5000);
  // 新建任务页与账号管理页都要实时反映账号登录状态：
  // 否则登出后仍显示「在线」（建任务会卡在 wait_for_ready 且无提示），
  // 反过来登录成功后也必须马上变「在线 · 已就绪」，不该等手动刷新。
  if (v === 'new') pollTimers.ntacc = setInterval(loadAccountsForNew, 5000);
  if (v === 'accounts') pollTimers.acc = setInterval(loadAccounts, 5000);
}
// 任务状态：单一事实来源（后端 _job_status 产出这些值）
var JOB_STATUS = {
  running:   { text: '运行中',   cls: 'ok',    dot: true },
  paying:    { text: '待支付',   cls: 'hot',   dot: true },   // 下单成功且仍在 30 分钟窗口内
  paused:    { text: '已暂停',   cls: 'muted' },
  scheduled: { text: '定时中',   cls: 'info' },
  pending:   { text: '待启动',   cls: 'warn' },
  blocked:   { text: '账号未登录', cls: 'warn' },
  completed: { text: '已完成',   cls: 'muted' },               // 下单成功但已超过支付时限
  finished:  { text: '已结束',   cls: 'muted' }
};
function jobStatusTag(st) {
  var s = JOB_STATUS[st] || { text: st || '未知', cls: 'muted' };
  return '<span class="tag ' + s.cls + '">' + (s.dot ? '<span class="d"></span>' : '') + esc(s.text) + '</span>';
}
// 任务已终结的任务不再可操作（引擎已销毁实例）；重新启用由用户点 ▶ 触发。
// paying 也是终态（订单已生成，不会继续查询）。
function jobDone(st) { return st === 'completed' || st === 'finished' || st === 'paying'; }

// 支付提示：30 分钟内为红色紧迫样式，超时后转灰（订单已被 12306 取消）
function payHint(j, cls) {
  var base = j.order_message || '订单已生成，请到 12306 核对';
  var train = j.order_train ? '（' + esc(j.order_train) + '）' : '';
  var left = '';
  if (j.order_paying && j.order_elapsed != null && j.pay_window) {
    var mins = Math.max(0, Math.ceil((j.pay_window - j.order_elapsed) / 60));
    left = '<span class="dh-t">剩余约 ' + mins + ' 分钟</span>';
  } else if (!j.order_paying && j.order_at) {
    left = '<span class="dh-t">已超过支付时限（' + esc(String(j.order_at).slice(5, 16)) + '）</span>';
  }
  // 超时后不再催付款，改为提示去核对订单状态
  var label = j.order_paying ? '下单成功' : '已完成';
  var text = j.order_paying ? base : (base.replace(/请 30 分钟内登录 12306 完成支付[^，]*/g, '').replace(/[，,]+$/, '') || '订单已生成');
  return '<div class="' + cls + '"><b>' + label + '</b>' + esc(text) + train + left + '</div>';
}
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
    keepOnlyOneSelection();
    syncModeSeg();
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
    // 语义：徽标 = **正在运行的抢票任务数**（不是任务总数）
    setNavJobBadge(s.jobs_running);
    $('dashStats').innerHTML =
      '<div class="stat"><div class="ic red">' + ICONS.jobs + '</div><div><div class="v">' + s.jobs_total + '</div><div class="k">抢票任务</div><div class="t" style="color:var(--ok)">' + s.jobs_running + ' 个运行中</div></div></div>' +
      '<div class="stat"><div class="ic info">' + ICONS.query + '</div><div><div class="v">' + s.query_today + '</div><div class="k">今日查询次数</div><div class="t" style="color:var(--faint)">累计 ' + s.query_total + '</div></div></div>' +
      '<div class="stat"><div class="ic warn">' + ICONS.hit + '</div><div><div class="v">' + s.hit_total + '</div><div class="k">累计余票命中</div><div class="t" style="color:var(--faint)">详见任务详情</div></div></div>' +
      '<div class="stat"><div class="ic ok">' + ICONS.acc + '</div><div><div class="v">' + s.accounts_total + '</div><div class="k">12306 账号</div><div class="t" style="color:var(--ok)">' + s.accounts_online + ' 个在线</div></div></div>';

    // 任务表
    $('dashJobs').innerHTML = d.jobs.length ? d.jobs.map(function (j) {
      var route = (j.stations || []).map(function (p) { return p.left + ' → ' + p.arrive; }).join('、') || '—';
      var seats = (j.seats || []).join(' / ') || '—';
      var dates = (j.left_dates || []).map(shortDate).join('、') || '—';
      var last = j.last_hit_at ? esc(String(j.last_hit_at).slice(5, 16)) + ' 命中' : '暂无记录';
      return '<tr style="cursor:pointer" data-job="' + j.job_id + '"><td><b>' + esc(j.job_name || '未命名') + '</b></td><td>' + esc(route) + '</td><td>' + esc(dates) + '</td><td>' + esc(seats) + '</td><td>' + jobStatusTag(j.status) + '</td><td style="color:var(--sub)">' + last + '</td></tr>';
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
// 列表型标签（车次 / 乘客）：超过 5 项就截断成「前5 等 N 项」
function clipList(arr, max) {
  var a = (arr || []).map(function (x) { return String(x); });
  var n = max || 5;
  return a.length > n ? a.slice(0, n).join('、') + ' 等 ' + a.length + ' 项' : a.join('、');
}
// 千分位（查询次数很容易上万）
function fmtNum(n) {
  var v = Number(n) || 0;
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
// 秒 → 「1小时23分」/「45 秒」/「—」
// ⚠️ 不要叫 fmtDur：上面已有一个按**分钟**的 fmtDur（车票历时用），
// 函数声明会提升、后定义者胜 → 同名会把历时显示成「29 秒」而不是「29 分钟」。
function fmtDurSec(sec) {
  if (sec == null || isNaN(sec)) return '—';
  var s = Math.max(0, Math.round(sec));
  if (s < 60) return s + ' 秒';
  var m = Math.floor(s / 60);
  if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
  var h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时 ' + (m % 60) + ' 分';
  return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时';
}
// 导航做标：展示「正在运行的任务数」（0 时隐藏，避免红色 0 看着像报错）
function setNavJobBadge(n) {
  var el = $('navJobCount');
  if (!el) return;
  var v = Number(n) || 0;
  el.textContent = v;
  el.title = '正在运行的抢票任务 ' + v + ' 个';
  el.classList.toggle('zero', v === 0);
}

function catalogCardEmptyWarning() {
  return '条件筛选未找到有效车次：当前任务的区间、日期及时段内未找到符合条件的车次';
}

/* ---------- 2. 任务列表 ---------- */
function loadJobs() {
  api('/api/jobs').then(function (d) {
    var jobs = d.jobs;
    var running = jobs.filter(function (j) { return j.status === 'running'; }).length;
    setNavJobBadge(running);
    $('jobsCnt').textContent = '共 ' + jobs.length + ' 个 · 运行中 ' + running;
    if (!jobs.length) {
      $('jobsList').innerHTML = '<div class="empty" style="background:#fff;border:1px dashed var(--line)"><b>还没有抢票任务</b>点击「新建任务」配置区间后即刻开始查询。</div>';
      return;
    }
    JOB_INDEX = {};
    jobs.forEach(function (j) { JOB_INDEX[j.job_id] = j; });
    $('jobsList').innerHTML = jobs.map(function (j) {
      var routes = (j.stations || []).map(function (p) { return esc(p.left) + ' <b style="color:var(--red);margin:0 6px">→</b> ' + esc(p.arrive); });
      var stTag = jobStatusTag(j.status);
      // 卡片要能直接看到「抢哪些车次」「谁坐」——只写「指定 N 车次」看不到具体车次，
      // 也无法确认乘车人是否选对。车次多时做截断，避免卡片被撑成一长条。
      var trains = j.train_numbers || [];
      var trainTag = trains.length
        ? '<span class="tag muted">车次：' + esc(clipList(trains)) + '</span>'
        : (j.except_train_numbers && j.except_train_numbers.length
          ? '<span class="tag muted">排除：' + esc(clipList(j.except_train_numbers)) + '</span>'
          : '<span class="tag muted">不限车次</span>');
      var members = (j.members || []).filter(Boolean);
      var paxTag = members.length
        ? '<span class="tag muted">乘客：' + esc(clipList(members)) + '</span>'
        : '<span class="tag warn">未选乘客</span>';
      var tags = '<span class="tag info">' + esc((j.left_dates || []).map(shortDate).join(' / ') || '未设日期') + '</span>' +
        (j.seats || []).map(function (s) { return '<span class="tag hot">' + esc(s) + '</span>'; }).join('') +
        trainTag + paxTag;
      // 查询次数与命中次数是两件事：查询多但从不命中 = 条件太紧 / 车次不经过；
      // 两者差得越大越说明「在正常跑，只是还没放票」。
      var stat = '<span class="q"><b>' + fmtNum(j.query_count || 0) + '</b> 已查询</span>'
        + '<span class="h"><b>' + fmtNum(j.hit_count || 0) + '</b> 命中</span>';
      var done = jobDone(j.status);
      // 状态提示：账号未登录 / 下单成功（待支付）/ 已结束原因
      var hint = '';
      if (j.status === 'blocked') {
        // 账号未就绪 → 引擎会卡在 wait_for_ready()，一条查询也发不出去，必须明确提示
        hint = '<div class="job-hint">账号<b>' + esc(j.account_name || j.account_key || '') + '</b>当前未登录，任务已中止。'
          + '<button class="link-btn" type="button" data-act="goacc">去账号管理登录</button></div>';
      } else if (j.status === 'scheduled') {
        var remain = scheduleRemaining(j.start_at);
        hint = '<div class="job-hint scheduled">北京时间 ' + esc(j.start_at || '') + ' 开始查询'
          + (remain ? '（' + esc(remain) + '）' : '') + '</div>';
      } else if (j.status === 'paying' || j.status === 'completed') {
        // 下单成功：30 分钟内红色催付，超时后转灰（12306 会取消超时未付订单）
        hint = payHint(j, 'job-hint ' + (j.status === 'paying' ? 'pay' : 'paid'));
      } else if (done && j.finish_reason) {
        hint = '<div class="job-hint done">' + esc(j.finish_reason)
          + (j.finished_at ? '（' + esc(String(j.finished_at).slice(5, 16)) + '）' : '') + '</div>';
      }
      if (j.catalog_empty) {
        hint += '<div class="job-hint">⚠ ' + esc(catalogCardEmptyWarning()) + '</div>';
      } else if (j.catalog_failed) {
        hint += '<div class="job-hint">⚠ 车次和经停站缓存生成失败：' + esc(j.catalog_message || '请编辑并保存任务重试') + '</div>';
      }
      // 右上角操作：开始/暂停 · 编辑 · 详情 · 删除（对齐设计稿）
      var acts = '<div class="acts">' +
        '<button class="icon-btn" type="button" data-act="toggle" data-id="' + j.job_id + '" data-active="' + ((j.is_active && !done) ? 1 : 0) + '" title="' + (done ? '重新开始' : (j.is_active ? '暂停' : '开始')) + '" aria-label="' + (done ? '重新开始任务' : (j.is_active ? '暂停任务' : '开始任务')) + '">' + ((j.is_active && !done) ? ICONS.pause : ICONS.play) + '</button>' +
        '<button class="icon-btn" type="button" data-act="edit" data-id="' + j.job_id + '" title="编辑" aria-label="编辑任务">' + ICONS.edit + '</button>' +
        '<button class="icon-btn" type="button" data-act="detail" data-id="' + j.job_id + '" title="查看详情" aria-label="查看任务详情">' + ICONS.eye + '</button>' +
        '<button class="icon-btn danger" type="button" data-act="del" data-id="' + j.job_id + '" title="删除" aria-label="删除任务">' + ICONS.trash + '</button>' +
        '</div>';
      var createdMeta = '<span>创建 ' + esc(j.created_at || '') + '</span>';
      if (j.start_at) {
        var startMs = Date.parse(String(j.start_at).replace(' ', 'T') + '+08:00');
        var reached = !isNaN(startMs) && Date.now() >= startMs;
        createdMeta += '<span class="job-start-meta ' + (reached ? 'reached' : 'pending') + '">启动 ' +
          esc(j.start_at) + '</span>';
      }
      return '<div class="job' + ((j.status === 'running' || j.status === 'scheduled') ? '' : ' paused') + '">' +
        '<div class="l1"><span class="jname">' + esc(j.job_name || '未命名任务') + '</span><span class="job-id">' + esc(j.job_id || '—') + '</span>' +
          '<span class="route">' + routes.join('；') + '</span>' + stTag + acts + '</div>' +
        hint +
        '<div class="l2">' + tags + '</div>' +
        '<div class="l3"><span class="l3stat">' + stat + '</span>' + createdMeta + '<span>账号 ' + esc(j.account_name || j.account_key || '—') + '</span></div></div>';
    }).join('');
    $('jobsList').querySelectorAll('button[data-act]').forEach(function (b) {
      var act = b.dataset.act, id = b.dataset.id;
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        if (act === 'toggle') jobToggle(id, b.dataset.active === '0');
        else if (act === 'edit') jobEdit(id);
        else if (act === 'detail') go('detail', { job_id: id });
        else if (act === 'del') jobDelete(id);
        else if (act === 'goacc') go('accounts');
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
    // 创建/结束时间放在标题行（详情页要一屏装满，不再单占一张卡）
    $('dMeta').innerHTML = jobStatusTag(j.status)
      + ' <span class="tag muted">创建 ' + esc(j.created_at || '—') + '</span>'
      + (j.finished_at ? ' <span class="tag muted">结束 ' + esc(j.finished_at) + '</span>' : '')
      + ' <span class="tag ' + (j.account_ready ? 'muted' : 'warn') + '">账号 '
      + esc(j.account_name || (j.account && j.account.user_name) || '—')
      + (j.account_ready ? '' : ' · 未登录') + '</span>';
    if ($('dEdit')) $('dEdit').onclick = function () { jobEdit(job_id); };
    // 已结束/已完成的任务要能重新开始（后端在 is_active=true 时会清掉结束标记）
    var dDone = jobDone(j.status);
    $('dToggle').textContent = dDone ? '重新开始' : (j.is_active ? '暂停任务' : '启动任务');
    $('dToggle').onclick = function () {
      jobToggle(job_id, dDone ? true : !j.is_active, this, function () { loadDetail(job_id); });
    };
    // 账号未登录 / 下单成功（待支付・超时） / 任务已结束：在标题下方给出可行动的说明
    if ($('dHint')) {
      if (j.status === 'paying' || j.status === 'completed') {
        $('dHint').className = 'detail-hint ' + (j.status === 'paying' ? 'pay' : 'paid');
        $('dHint').innerHTML = payHint(j, '');
      } else if (j.status === 'blocked') {
        $('dHint').className = 'detail-hint warn';
        $('dHint').innerHTML = '账号<b>' + esc(j.account_name || j.account_key || '')
          + '</b>当前未登录，任务已中止、不会发起任何查询。'
          + '<button class="link-btn" type="button" id="dGoAcc">去账号管理登录</button>';
        if ($('dGoAcc')) $('dGoAcc').onclick = function () { go('accounts'); };
      } else if (dDone) {
        $('dHint').className = 'detail-hint done';
        $('dHint').innerHTML = esc(j.finish_reason || '任务已结束')
          + (j.finished_at ? '（' + esc(String(j.finished_at).slice(5, 16)) + '）' : '');
      } else {
        $('dHint').className = 'detail-hint';
        $('dHint').innerHTML = '';
      }
    }
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
    // ---------- 任务配置（创建任务时的全部条件，不再只展示 5 项）----------
    var ivMin = j.interval && j.interval.min != null ? j.interval.min : '—';
    var ivMax = j.interval && j.interval.max != null ? j.interval.max : '—';
    var trains = j.train_numbers || [];
    var excepts = j.except_train_numbers || [];
    var members = (j.members || []).filter(Boolean);
    var isTrainMode = j.query_mode === 'train' || (j.query_mode !== 'range' && trains.length > 0);
    var detailTrainDate = (j.left_dates || [])[0] || '';
    var detailTrainList = function (numbers, clickable) {
      return '<span class="detail-train-list">' + numbers.map(function (trainNumber) {
        if (!clickable) return '<span class="detail-train-name">' + esc(trainNumber) + '</span>';
        return '<button type="button" class="detail-train-link" data-detail-train="' + esc(trainNumber) + '" data-detail-date="' + esc(detailTrainDate) + '">' + esc(trainNumber) + '</button>';
      }).join('') + '</span>';
    };
    var scope = trains.length
      ? detailTrainList(trains, true) + '<small>共 ' + trains.length + ' 个（只抢这些）</small>'
      : (excepts.length
        ? '排除 ' + detailTrainList(excepts, false) + '<small>其余均抢</small><span id="dTrainScope"><small>正在准备实际车次与经停站…</small></span>'
        : '<span id="dTrainScope">不限车次<small>正在准备区间车次与经停站…</small></span>');
    $('dFacts').innerHTML =
      dvGroup('行程') +
      dv('查询方式', queryStationSummary(isTrainMode, j.station_mode || 'exact')) +
      dv('区间', (routes.join('；') || '—') + '<small>' + (j.stations || []).length + ' 组，依次轮询</small>') +
      dv('出行日期', esc((j.left_dates || []).map(shortDate).join('、') || '—') +
        '<small>共 ' + (j.left_dates || []).length + ' 天</small>') +
      dv('车次范围', scope) +
      dvGroup('席别与乘客') +
      dv('席别优先级', seatPri || '—') +
      dv('乘车人', members.length
        ? esc(clipList(members, 12)) + '<small>' + members.length + ' 人 · ' +
          (j.allow_less_member ? '允许部分先行' : '余票不足则不提交') + '</small>'
        : '<span style="color:var(--faint)">未选乘客</span>') +
      dvGroup('执行参数') +
      dv('查询时段', esc(j.period.from) + ' – ' + esc(j.period.to) +
        (isTrainMode ? '<small>车次已指定，引擎强制全天</small>' : '<small>按出发时刻筛选</small>')) +
      dv('查询间隔', '<b>' + esc(ivMin) + '–' + esc(ivMax) + '</b> 秒<small>本任务专用；待引擎支持后生效</small>') +
      dv('开始时间', (j.start_at ? '北京时间 ' + esc(j.start_at) : '立即开始') +
        (j.start_at ? '<small>到点触发查询（UTC+8）</small>' : ''));
    if (!trains.length) loadDetailRangeTrains(j);
    // ---------- 量化指标（全宽带）----------
    var m = j.metrics || {};
    var stat = function (k, v, sub, cls) {
      return '<div class="card detail-stat ' + (cls || '') + '"><span>' + k + '</span><b>' + v +
        '</b>' + (sub ? '<em>' + sub + '</em>' : '') + '</div>';
    };
    var payLeft = '';
    if (j.order_paying && j.order_elapsed != null && j.pay_window) {
      payLeft = '剩 ' + Math.max(0, Math.ceil((j.pay_window - j.order_elapsed) / 60)) + ' 分';
    }
    $('dStats').innerHTML =
      stat('已查询', fmtNum(m.query_count || 0), '次请求') +
      // 命中率只在「查询次数 ≥ 命中次数」时才有意义：老数据的命中发生在计数功能上线之前，
      // 直接相除会得到 >100% 的荒谬值（实测 36/1 = 3600%）。
      stat('命中', fmtNum(m.hit_count || 0),
        (m.query_count && m.query_count >= m.hit_count)
          ? '命中率 ' + (m.hit_count / m.query_count * 100).toFixed(2) + '%'
          : (m.hit_count ? '次命中（早于计数统计）' : '尚未命中'),
        m.hit_count ? 'hot' : '') +
      stat('命中→下单', m.hit_to_order == null ? '—' : fmtDurSec(m.hit_to_order),
        m.hit_to_request == null ? '尚未成单' : '受理耗时 ' + fmtDurSec(m.hit_to_request)) +
      stat('每轮请求', fmtNum(m.requests_per_round || 0),
        (j.stations || []).length + ' 区间 × ' + (j.left_dates || []).length + ' 日期') +
      stat('运行时长', m.alive == null ? '—' : fmtDurSec(m.alive), j.status === 'running' ? '仍在运行' : '已计') +
      stat('最后命中', m.since_last_hit == null ? '—' : fmtDurSec(m.since_last_hit) + '前',
        j.last_hit_at ? esc(String(j.last_hit_at).slice(5, 16)) : '尚未命中') +
      stat('支付剩余', payLeft || '—', j.order_success ? '30 分钟支付窗口' : '未出票');
    // 命中表
    $('dHits').innerHTML = (j.hits || []).length ? j.hits.map(function (h) {
      var train = esc(h.train_number || '');
      var date = esc(h.left_date || detailTrainDate || '');
      var link = h.train_number
        ? '<button type="button" class="detail-train-link" data-detail-train="' + train + '" data-detail-date="' + date + '">' + train + '</button>'
        : '—';
      return '<tr><td>' + link + '</td><td>' + esc(h.seat) + '</td><td>' + esc(h.num) + '</td><td>' + esc(h.left_date) + '</td><td style="color:var(--sub)">' + esc(h.at) + '</td></tr>';
    }).join('') : '<tr><td colspan="5" style="color:var(--faint);text-align:center">暂无命中记录</td></tr>';
    // 下单阶段时序（命中 → 受理 → 确认页 → 校验 → 排队 → 确认 → 成单/失败）
    // 每条带「距上一步耗时」，直接看出卡在哪一步。
    var evs = j.events || [];
    if (!evs.length) {
      $('dStages').innerHTML = '<div class="dv-empty">还没有下单动作。命中余票后，这里会按时间依次列出下单各阶段与每步耗时。</div>';
    } else {
      var prevAt = null;
      $('dStages').innerHTML = evs.slice(-30).map(function (e) {
        var t = String(e.at || '').slice(5, 19);
        var gap = '';
        if (prevAt) {
          var d = (Date.parse(e.at.replace(' ', 'T')) - Date.parse(prevAt.replace(' ', 'T'))) / 1000;
          if (!isNaN(d)) gap = '<em>+' + fmtDurSec(d) + '</em>';
        }
        prevAt = e.at;
        return '<div class="it ev-' + esc(e.kind) + '"><time>' + esc(t) + '</time><i class="fdot"></i><div>' +
          '<b>' + esc(e.label) + '</b> ' + esc(e.message || '') + gap + '</div></div>';
      }).join('');
    }
    // 执行轨迹：下单阶段 / 命中轨迹 共用一张卡片（分段切换）。
    // 默认优先显示下单阶段（它是「为什么没买到票」的直接答案）；没有阶段事件时回落到命中轨迹。
    JOB_DETAIL_EVENTS = !!evs.length;
    if (!TRACK.userSet) TRACK.mode = JOB_DETAIL_EVENTS ? 'stage' : 'hit';
    applyTrackMode();
    // 命中轨迹
    $('dTimeline').innerHTML = (j.hit_timeline || []).length ? j.hit_timeline.slice(0, 15).map(function (h) {
      return '<div class="it"><time>' + esc(String(h.at).slice(5, 16)) + '</time><i class="fdot"></i><div><b class="hit-train">' + esc(h.train_number) + '</b><div class="hit-meta">命中 <b>' + esc(h.seat) + '</b> × ' + esc(h.num) + ' <span style="color:var(--faint)">(' + esc(shortDate(h.left_date)) + ')</span></div></div></div>';
    }).join('') : '<div class="dv-empty">还没有命中记录。任务启动后这里会实时展示查询与命中轨迹。</div>';
    bindDetailTrainStops(j);
    // 日志（后端已按任务名过滤且取最新，见 routes_jobs._job_logs）
    var logs = j.logs || [];
    if ($('dLogSub')) $('dLogSub').textContent = logs.length ? '最新 ' + logs.length + ' 行 · 已按任务名过滤' : '';
    $('dLog').innerHTML = logs.length ? logs.map(function (l) { return '<div class="' + logLineClass(l) + '">' + esc(l) + '</div>'; }).join('') : '<div style="color:var(--faint)">暂无日志</div>';
  }).catch(function (e) { toast(e.message, 'err'); go('jobs'); });
}

function loadDetailRangeTrains(job) {
  var box = $('dTrainScope');
  if (!box) return;
  var catalog = job.train_catalog || {};
  if (catalog.state === 'building' || catalog.state === 'pending' || catalog.state === 'missing') {
    box.innerHTML = '<small>车次与经停站缓存准备中，请稍后刷新任务详情</small>';
    return;
  }
  var items = catalog.items || [];
  if (!items.length) {
    var message = catalog.message || (catalog.state === 'failed'
      ? '车次与经停站缓存生成失败'
      : '当前任务区间、日期及筛选条件下没有查询到车次');
    if (catalog.state === 'failed') {
      box.innerHTML = '<span class="detail-catalog-warning">⚠ 车次与经停站缓存生成失败：' + esc(message) + '</span>';
    } else if (catalog.state !== 'building' && catalog.state !== 'pending' && catalog.state !== 'missing') {
      box.innerHTML = '<span class="detail-catalog-warning">⚠ 条件筛选未找到有效车次</span>';
    } else {
      box.innerHTML = '<small>' + esc(message) + '</small>';
    }
    return;
  }
  box.innerHTML = '<span class="detail-train-list">' + items.map(function (item) {
      return '<button type="button" class="detail-train-link" data-detail-train="' +
        esc(item.train_number) + '" data-detail-date="' + esc(item.date) + '">' +
        esc(item.train_number) + '<small>' + esc(shortDate(item.date)) + '</small></button>';
    }).join('') + '</span><small>' + (job.except_train_numbers && job.except_train_numbers.length
      ? '排除规则过滤后' : '不限车次，区间内') + '共 ' + items.length + ' 个车次（含经停站缓存）</small>';
  bindDetailTrainStops(job);
}

function bindDetailTrainStops(job) {
  document.querySelectorAll('#dFacts [data-detail-train], #dHits [data-detail-train]').forEach(function (button) {
    button.onclick = function () {
      openDetailTrainStops(job, button.dataset.detailTrain, button.dataset.detailDate);
    };
  });
}

function openDetailTrainStops(job, trainNumber, date) {
  if (!trainNumber || !date) {
    toast('缺少车次或日期信息', 'err');
    return;
  }
  var items = (job.train_catalog && job.train_catalog.items) || [];
  var item = items.find(function (x) {
    return String(x.train_number) === String(trainNumber) && String(x.date) === String(date);
  });
  if (!item) {
    toast('任务缓存中没有车次 ' + trainNumber + ' 的经停站，请编辑并保存任务刷新缓存', 'err');
    return;
  }
  if (!item.stops_data || !(item.stops_data.stops || []).length) {
    toast(item.stops_error || '该车次的经停站缓存暂不可用，请编辑并保存任务重建缓存', 'err');
    return;
  }
  var leg = {
    n: item.train_number,
    no: item.train_no,
    f: item.from_station,
    to: item.to_station,
    d: item.departure,
    a: item.arrival,
    m: item.duration
  };
  openStopsForLeg(leg, null, item.date, item.stops_data);
}

// 执行轨迹的租户：TRACK.mode = 'stage'（下单阶段）| 'hit'（命中轨迹）。
// userSet 记录「用户主动切过」，避免每次轮询刷新都把选择重置回默认值。
var TRACK = { mode: 'stage', userSet: false };
var JOB_DETAIL_EVENTS = false;
function applyTrackMode() {
  var stage = TRACK.mode === 'stage';
  var s = $('dStages'), h = $('dTimeline');
  if (s) s.hidden = !stage;
  if (h) h.hidden = stage;
  var seg = document.querySelectorAll('#dTrackSeg .seg-btn');
  for (var i = 0; i < seg.length; i++) seg[i].classList.toggle('on', seg[i].dataset.track === TRACK.mode);
  if ($('dTrackSub')) {
    $('dTrackSub').textContent = stage
      ? '命中 → 成单 · 含耗时'
      : '最近 15 次命中';
  }
}
// 每次进详情页都重新绑定（事件委托在 document 上，只需绑一次）
document.addEventListener('click', function (e) {
  var b = e.target.closest && e.target.closest('#dTrackSeg .seg-btn');
  if (!b) return;
  TRACK.mode = b.dataset.track;
  TRACK.userSet = true;
  applyTrackMode();
});
function queryStationSummary(isTrainMode, stationMode) {
  if (isTrainMode) {
    return '车次查询 · 指定车次<small>车次白名单与实际上下车站均需匹配</small>';
  }
  var method = '区间查询';
  var methodNote = '查询区间内全部车次';
  var station = stationMode === 'expand' ? '同城站扩展' : '仅指定站名';
  var stationNote = stationMode === 'expand'
    ? '城市名匹配该城市全部车站；具体站只匹配自己'
    : '只匹配与输入完全同名的站';
  return method + ' · ' + station + '<small>' + methodNote + '；' + stationNote + '</small>';
}

// 配置行：<span>标题</span><b>值 + 可选小字说明</b>
function dv(k, v) {
  return '<div class="detail-fact"><span>' + k + '</span><b>' + v + '</b></div>';
}
// 配置分组标题（行程 / 席别与乘客 / 执行参数 / 时间）
function dvGroup(title) {
  return '<div class="dv-group">' + title + '</div>';
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
  // 只保留**一个**未开售日期：后面每天都是同样的「未开售」，全列出来只是白占横向空间
  // （实测 20 天里 5 天未开售）。留一个当「还有更多、但还没开售」的提示，
  // 点它会 toast 说明，且 tooltip 会带出剩余天数。
  var openL = DATES.all.filter(function (x) { return x.open !== false; });
  var blockedL = DATES.all.filter(function (x) { return x.open === false; });
  var list = openL.concat(blockedL.slice(0, 1));
  var extraClosed = Math.max(0, blockedL.length - 1);
  box.innerHTML = list.map(function (x) {
    var blocked = x.open === false;
    // 「未开售」不再单独占一行：第三行会让日期片高度明显变高、整条日期栏变厚。
    // 改为中划线（app.css 的 .date.dis::after）+ 灰化 + tooltip，信息不丢。
    var tip = blocked
      ? ('尚未开售' + (extraClosed ? '（其余 ' + extraClosed + ' 天同样未开售）' : ''))
      : x.date;
    return '<div class="date' + (blocked ? ' dis' : '') + (x.date === cur ? ' on' : '') +
      '" data-date="' + x.date + '" data-open="' + (blocked ? '0' : '1') +
      '" title="' + esc(tip) + '">' +
      '<b>' + esc(x.weekday) + '</b><small>' + esc(x.date.slice(5)) + '</small>' +
      '</div>';
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
    // 账号就绪表：创建任务前用它校验（避免选中一个已掉线的账号）
    APP.accReady = {};
    list.forEach(function (a) { APP.accReady[a.key] = !!a.is_ready; });
    var opts = '<option value="">（需先添加并登录账号）</option>' + list.map(function (a) {
      return '<option value="' + a.key + '" ' + (!a.is_ready ? 'disabled' : '') + '>' + esc(a.user_name) + (a.is_ready ? '（在线 · ' + a.passenger_count + ' 位乘客）' : '（离线，未就绪）') + '</option>';
    }).join('');
    // ⚠️ 重建 innerHTML 会把 selectedIndex 重置到第 0 项（= 空选项），
    // 而本函数现在会被轮询反复调用 → 必须先记住当前选择，重建后再恢复，
    // 否则用户选好的账号每 5 秒被清一次。
    var ntSel = $('ntAccount'), oSel = $('oAccount');
    var ntPrev = ntSel.value, oPrev = oSel.value;
    ntSel.innerHTML = opts;
    oSel.innerHTML = opts;
    if (ntPrev && APP.accReady[ntPrev]) ntSel.value = ntPrev;
    if (oPrev && APP.accReady[oPrev]) oSel.value = oPrev;
    // ⚠️ 必须在恢复之后用 **重建前的选择** 判断是否掉线：
    // 上面「仍在线才恢复」的写法会让掉线账号的 value 静默变回 ''，
    // 于是后面 `if (cur && !ready[cur])` 永不成立 → 乘车人一直留着旧账号的人
    // （用户报的「账号离线后乘车人还是旧的那批」）。
    var dropped = (ntPrev && !APP.accReady[ntPrev]) ? ntPrev : '';
    // 编辑态：账号列表可能比 applyJobToForm 晚到，这里补选任务原账号
    if (APP.pendingAccount) {
      var want = APP.pendingAccount;
      APP.pendingAccount = null;
      if (APP.accReady[want]) {
        ntSel.value = want;
        loadPassengersFor(want);
        return;
      }
      // 任务原账号已掉线：不选中（它是 disabled 项），并本轮直接走掉线分支
      dropped = dropped || want;
    }
    // 冷启动默认选中第一个在线账号，减少手动步骤（只做一次，之后尊重用户选择）
    if (!APP.accInit) {
      APP.accInit = 1;
      var first = Array.prototype.find.call(ntSel.options, function (o) { return o.value && !o.disabled; });
      if (first) { ntSel.value = first.value; loadPassengersFor(first.value); return; }
    }
    // 选中的账号已掉线（或本就选中一个掉线账号）→ 必须清空账号与乘车人。
    // 不清空的话：提交时会带一个不可用账号，任务建好后卡在引擎的
    // wait_for_ready()，界面毫无提示（用户报的「卡住」）。
    var lost = dropped || (function () {
      var c = ntSel.value;
      return (c && !APP.accReady[c]) ? c : '';
    })();
    if (lost) {
      var hit = list.filter(function (a) { return a.key === lost; })[0] || {};
      ntSel.value = '';
      clearNtPassengers('账号未登录');
      if (APP.accWarned !== lost) {
        APP.accWarned = lost;
        toast('账号「' + (hit.user_name || lost) + '」当前未登录，已取消选择；请到「账号管理」重新登录', 'err', 5000);
      }
    } else if (APP.accWarned && (!ntSel.value || APP.accReady[ntSel.value])) {
      APP.accWarned = null;   // 恢复在线后允许下次再提醒
    }
  }).catch(function () { });
}
// 清空乘车人（账号不可用时必须走这里，避免残留上一个账号的人）
function clearNtPassengers(reason) {
  APP.paxAll = []; APP.paxSel = [];
  var box = $('ntPassengers');
  if (box) {
    box.innerHTML = '<span style="color:var(--faint);font-size:12.5px">'
      + (reason ? esc(reason) + '，乘车人不可用' : '请先在上方选择账号') + '</span>';
  }
  if ($('ntPaxHint')) $('ntPaxHint').textContent = reason || '需选择账号后加载';
  updateNtSummary();
}
function loadPassengersFor(key) {
  if (!key) {
    clearNtPassengers('');
    return;
  }
  // ⚠️ 账号未就绪时不该展示乘车人：引擎此时取不到乘客，界面却列着一批人，
  // 用户会以为可选（然后建出的任务卡在 wait_for_ready）。
  // 在这里统一兜住，比在每个调用点判更可靠 —— 轮询/编辑回填/默认选中都会经过它。
  if (APP.accReady && APP.accReady[key] === false) {
    clearNtPassengers('账号未登录');
    return;
  }
  var requestSeq = (APP.passengerLoadSeq || 0) + 1;
  APP.passengerLoadSeq = requestSeq;
  APP.paxAll = []; APP.paxSel = [];
  $('ntPassengers').innerHTML = '<span style="color:var(--faint);font-size:12.5px">加载中…</span>';
  $('ntPaxHint').textContent = '';
  api('/api/accounts/' + encodeURIComponent(key) + '/passengers').then(function (d) {
    // 编辑初始化和账号轮询可能同时触发多次请求，旧响应不能覆盖最新选择。
    if (APP.passengerLoadSeq !== requestSeq) return;
    // 异步返回时账号可能已经掉线 → 结果作废，避免又把乘车人填回来
    if (APP.accReady && APP.accReady[key] === false) {
      clearNtPassengers('账号未登录');
      return;
    }
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
    // 默认座次（用户指定 2026-09）：二等座 + 无座；都取不到才回落到第一个席别
    var prefer = ['二等座', '无座'];
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
  // 每个站名输入都带自己的联想框（与车票查询页的起终点输入框一致），
  // 以及一行「这个输入会匹配哪些站」的说明 —— 12306 查询会做同城站扩展，
  // 不写出来用户根本不知道「广州」= 10 个站、「广州南」= 只 1 个站。
  row.innerHTML =
    '<div class="stn-wrap"><input class="stn" type="text" data-role="left" value="" placeholder="出发站">' +
      '<div class="stn-suggest hidden"></div></div>' +
    '<button type="button" class="pair-swap" title="交换出发站和到达站" aria-label="交换出发站和到达站"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg></button>' +
    '<div class="stn-wrap"><input class="stn" type="text" data-role="arrive" value="" placeholder="到达站">' +
      '<div class="stn-suggest hidden"></div></div>' +
    '<span class="del">✕</span>' +
    '<div class="pair-note" data-note="left" hidden></div>' +
    '<div class="pair-note" data-note="arrive" hidden></div>';
  $('ntPairs').appendChild(row);
  if (left) row.querySelector('[data-role=left]').value = left;
  if (arrive) row.querySelector('[data-role=arrive]').value = arrive;
  wireNtPair(row);
  refreshPairNotes();
}
function wireNtPair(row) {
  var swap = row.querySelector('.pair-swap');
  if (swap && !swap.dataset.wired) {
    swap.dataset.wired = '1';
    swap.addEventListener('click', function () {
      var left = row.querySelector('[data-role=left]');
      var arrive = row.querySelector('[data-role=arrive]');
      var value = left.value;
      left.value = arrive.value;
      arrive.value = value;
      refreshNtQueryLoad();
      updateNtSummary();
      refreshPairNotes();
    });
  }
  row.querySelector('.del').addEventListener('click', function () {
    row.remove();
    if (!$('ntPairs').querySelector('.pair')) { var d = monitorRouteDefaults(); addNtPair(d.left, d.arrive); }
    refreshNtQueryLoad();
    updateNtSummary();
    refreshPairNotes();
  });
  // 输入站点后需要刷新「每轮请求」预估（空区间会被 ntPairs() 过滤，所以必须监听输入）
  row.querySelectorAll('.stn').forEach(function (inp) {
    if (inp.dataset.ntWired) return;
    inp.dataset.ntWired = '1';
    inp.addEventListener('input', function () {
      refreshNtQueryLoad();
      updateNtSummary();
      scheduleePairNotes();
    });
    inp.addEventListener('change', function () { refreshPairNotes(); });
  });
  bindStationSuggest(row.querySelectorAll('.stn'), {
    onPick: function () { refreshNtQueryLoad(); updateNtSummary(); refreshPairNotes(); }
  });
}
function loadStationsForPairs() {
  $('ntPairs').querySelectorAll('.pair').forEach(wireNtPair);
  refreshPairNotes();
}
var pairNoteTimer = 0;
// 站点匹配方式：exact=仅指定站名（默认，只认完全同名的站）/ expand=同城站扩展（城市名=该城市全部车站）。
// 与引擎侧 `webx/stations.expand()`、任务表的 `station_mode` 同一套语义。
function ntStnMode() {
  var box = $('ntStnMode');
  var on = box && box.querySelector('.seg-btn.on');
  return on ? on.dataset.stnMode : 'exact';
}
function setNtStnMode(mode) {
  var seg = $('ntStnMode'); if (!seg) return;
  seg.querySelectorAll('.seg-btn').forEach(function (b) {
    b.classList.toggle('on', b.dataset.stnMode === (mode || 'exact'));
  });
  if ($('ntStnModeHint')) {
    $('ntStnModeHint').textContent = ntStnMode() === 'exact'
      ? '只认完全同名的站：填「广州」只抢广州站'
      : '城市名（广州）= 该城市全部车站';
  }
  refreshPairNotes();
  updateNtSummary();
}
function bindStnMode() {
  var seg = $('ntStnMode'); if (!seg || seg.dataset.bound) return;
  seg.dataset.bound = '1';
  seg.querySelectorAll('.seg-btn').forEach(function (b) {
    b.addEventListener('click', function () { setNtStnMode(b.dataset.stnMode); });
  });
}
function scheduleePairNotes() {
  clearTimeout(pairNoteTimer);
  pairNoteTimer = setTimeout(refreshPairNotes, 350);
}
// 区间输入 → 实际匹配车站。规则与引擎侧 `webx/stations.expand()` **完全同源**
// （同一个接口 + mode 参数），所以界面写什么，引擎就按什么过滤。
function refreshPairNotes() {
  var box = $('ntPairs'); if (!box) return;
  var rows = Array.prototype.slice.call(box.querySelectorAll('.pair'));
  if (!rows.length) return;
  var inputs = [], seen = {};
  rows.forEach(function (r) {
    ['left', 'arrive'].forEach(function (role) {
      var inp = r.querySelector('[data-role=' + role + ']');
      var v = (inp.value || '').trim();
      if (v && !seen[v]) { seen[v] = 1; inputs.push(v); }
    });
  });
  function hideAll() {
    rows.forEach(function (r) {
      r.querySelectorAll('.pair-note').forEach(function (n) { n.hidden = true; n.innerHTML = ''; });
    });
  }
  if (!inputs.length) { hideAll(); return; }
  var mode = ntStnMode();
  api('/api/stations/expand?mode=' + encodeURIComponent(mode) + '&q=' + encodeURIComponent(inputs.join('|'))).then(function (d) {
    var byInput = {};
    (d.list || []).forEach(function (x) { byInput[x.input] = x; });
    rows.forEach(function (r) {
      // 说明**分别**挂在出发站 / 到达站自己的输入框下方（见 app.css 的 [data-note] 列定位）
      ['left', 'arrive'].forEach(function (role) {
        var note = r.querySelector('.pair-note[data-note="' + role + '"]');
        if (!note) return;
        var v = (r.querySelector('[data-role=' + role + ']').value || '').trim();
        var info = v ? byInput[v] : null;
        if (!info) { note.hidden = true; note.innerHTML = ''; return; }
        var html, cls = 'pair-note';
        if (!info.known) {
          html = '<b>' + esc(v) + '</b> 未收录，请检查拼写'; cls += ' bad';
        } else if (mode === 'exact' && !info.exact) {
          html = '<b>' + esc(v) + '</b> 不是完整站名，请从下拉里选'; cls += ' bad';
        } else if (mode === 'exact') {
          // 「仅指定站名」：完整站名当然只匹配自己 → 不再显示注释，只保留上面的错误提示
          note.hidden = true; note.innerHTML = ''; note.title = '';
          return;
        } else {
          // 「同城站扩展」：展示全部会匹配到的站名（匹配：站名），不截断
          var ms = info.matches || [];
          html = '<b>' + esc(v) + '</b> 匹配：' + esc(ms.join('、'));
          if (ms.length > 1) cls += ' wide';
        }
        note.hidden = false;
        note.className = cls;
        note.innerHTML = html;
        note.title = info.known ? ((info.matches || []).join('、') || '') : '';
      });
    });
  }).catch(function () { hideAll(); });
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
// 金额（单个乘车人）：取「优先级最高的席别」在已选车次里的**真实票价**。
// 价格来自 12306（loadPrices 已缓存到 MON.prices）；还没查到就返回 null。
function ntEstimateUnitPrice() {
  var seats = APP.selSeats || [];
  var picked = APP.taskPicked || [];
  if (!seats.length || !picked.length) return null;
  for (var i = 0; i < seats.length; i++) {
    var k = SEAT_KEY[seats[i]];
    if (!k) continue;
    for (var j = 0; j < picked.length; j++) {
      var leg = picked[j] && picked[j].leg;
      if (leg && seatOffered(leg, k)) {
        var p = priceOf(leg, k);
        if (p != null) return { price: p, seat: seats[i], train: leg.n || leg.tn || '' };
      }
    }
  }
  return null;
}
function ntEstimateLabel() {
  var unit = ntEstimateUnitPrice();
  var pax = (APP.paxSel || []).length;
  if (!unit) {
    return '<span style="color:var(--faint)">—</span><small>' +
      (ntMode() === 'train' ? '票价加载中或该席别无报价' : '区间模式未定车次，无法给出金额') + '</small>';
  }
  var total = unit.price * (pax || 1);
  return '<b style="color:var(--red)">¥' + fmtNum(Math.round(total * 10) / 10) + '</b>' +
    '<small>' + esc(unit.seat) + ' ¥' + fmtPrice(unit.price) + ' × ' + (pax || 1) +
    ' 人（12306 实际票价，按首选席别）</small>';
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
  bindStnMode();
  syncNtRangeFromMonitor();
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
function monitorRouteDefaults() {
  var left = (($('mFrom') || {}).value || '').trim();
  var arrive = (($('mTo') || {}).value || '').trim();
  return { left: left || '北京', arrive: arrive || '深圳' };
}
function syncNtRangeFromMonitor() {
  if (APP.editJobId || ntMode() !== 'range') return;
  var d = monitorRouteDefaults();
  var pair = $('ntPairs') && $('ntPairs').querySelector('.pair');
  if (!pair) return;
  pair.querySelector('[data-role=left]').value = d.left;
  pair.querySelector('[data-role=arrive]').value = d.arrive;
}
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
    row('查询方式', queryStationSummary(train, ntStnMode())) +
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
    row('开始时间', esc(ntStartLabel()) + '<small>秒级调度 · 北京时间 UTC+8</small>') +
    row('查询间隔', iv.min + '–' + iv.max + ' 秒<small>本任务专用；需引擎支持后生效</small>') +
    row('每轮请求', load.perRound ? '<b>' + load.perRound + '</b> 次<small>' + load.stations + ' 区间 × ' + load.dates + ' 日期</small>' : '—') +
    row('参考金额', ntEstimateLabel());
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
   开始时间由 WebX 调度器按北京时间精确到秒触发；任务级查询间隔仍待引擎支持。 */
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
  // datetime-local step=1 给到秒；兼容浏览器/旧数据省略秒的值，统一存为秒级北京时间。
  var v = ($('ntStartAt') || {}).value || '';
  if (v && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) v += ':00';
  return v ? v.replace('T', ' ') : '';
}
function scheduleRemaining(value) {
  if (!value) return '';
  var ms = Date.parse(String(value).replace(' ', 'T') + '+08:00');
  if (!isFinite(ms)) return '';
  var seconds = Math.max(0, Math.ceil((ms - Date.now()) / 1000));
  return seconds ? '还有 ' + fmtDurSec(seconds) : '即将启动';
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
  return v ? ('北京时间 ' + v) : '定时开始（未填时间）';
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
var SUG_SEQ = 0;
// 联想框的位置：车票查询页用固定 id，其余（新建任务页的区间输入框）用同级的 .stn-suggest。
// 早先这里对非 mFrom/mTo 直接 `return`（注释写「直接输入即可」），
// 结果是区间输入框没有任何提示，用户只能盲打站名 —— 而站名打错在引擎侧是**静默失败**。
function suggestBoxOf(inp) {
  var id = inp.id === 'mFrom' ? 'mFromSug' : inp.id === 'mTo' ? 'mToSug' : null;
  if (id) return $(id);
  var wrap = inp.parentElement;
  return wrap ? wrap.querySelector('.stn-suggest') : null;
}
function bindStationSuggest(inputs, opts) {
  opts = opts || {};
  (inputs.length ? inputs : [inputs]).forEach(function (inp) {
    if (inp.dataset.sugBound) return;
    inp.dataset.sugBound = '1';
    if (!inp.dataset.sugKey) inp.dataset.sugKey = 'sg' + (++SUG_SEQ);
    var boxKey = inp.dataset.sugKey;
    var box = function () { return suggestBoxOf(inp); };
    inp.addEventListener('input', function () {
      clearTimeout(sugTimers[boxKey]);
      var el0 = box();
      if (!el0) return;
      if (!inp.value.trim()) { el0.classList.add('hidden'); return; }
      sugTimers[boxKey] = setTimeout(function () {
        api('/api/stations?q=' + encodeURIComponent(inp.value.trim())).then(function (d) {
          var list = d.list || [];
          var el = box();
          if (!el) return;
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
              if (opts.onPick) opts.onPick(inp.value);
            });
          });
        }).catch(function () { });
      }, 300);
    });
    inp.addEventListener('blur', function () {
      setTimeout(function () { var el = box(); if (el) el.classList.add('hidden'); }, 150);
    });
  });
}

/* ---------- 5. 车票查询 ---------- */
var MON = { rows: [], batch: false, sel: {}, selSeats: {}, selBy: {}, selOrder: [], sort: null, stationOpts: { from: {}, to: {} },
            // 真实票价缓存：key = `train_no:上站电报码:下站电报码` → {seat_key: 元}
            // 由 loadPrices() 从 /api/tickets/prices 拉取后填充
            prices: {},
            // 出发时间区间（整点，0~24）：from=0 且 to=24 表示不限。与 MON.filters.hour 联动
            hourFrom: 0, hourTo: 24,
            searched: false,
            filters: { types: [], fromSt: [], toSt: [], seats: [], hour: '', bookable: false } };
APP.taskPicked = []; // 新建任务：从车票查询勾选的车次（含席别）
var PICK_SEAT_KEYS = ['business', 'first', 'second', 'hardSleeper', 'hardSeat', 'noSeat', 'softSleeper', 'special'];
function renderTaskPicked() {
  var list = $('taskSelectionList');
  if (!list) return;
  var sels = APP.taskPicked || [];
  var taskDate = (APP.selDates || [])[0] || (($('mDate') || {}).value || '');
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
      // 展示格式：座次（票数） 价格。票数就是接口原值（有 / 无 / 数字 / 候补），
      // 不再用「等待放票」这种额外文案 —— 无票就是「无」，含义已经足够清楚。
      var vTxt = (v == null || v === '') ? '—' : esc(String(v));
      // 价格用 12306 真实票价（loadPrices 已填充）；没查到就不显示
      var price = priceOf(leg, k);
      return '<label class="task-seat-option"><input type="checkbox" data-tn="' + esc(leg.n) + '" data-k="' + k + '" ' + (on ? 'checked' : '') + '>' +
        SEAT_NAME[k] + '（' + vTxt + '）' +
        (price != null ? '<em class="tk-price">¥' + fmtPrice(price) + '</em>' : '') + '</label>';
    }).join('');
    return '<div class="task-selection-item" data-tn="' + esc(leg.n) + '">' +
      // 车次号可点：与车票查询列表一致，打开经停站；在这里还能改「上车 / 下车」站
      '<button class="train task-train-stops" type="button" data-tn="' + esc(leg.n) + '"'
        + (leg.no ? ' title="查看经停站，可改上车站 / 下车站"' : ' title="该车次缺少 12306 内部编号"') + '>'
        + '<b>' + esc(leg.n) + '</b><small>' + esc(leg.tn) + '</small></button>' +
      '<div class="route"><b>' + esc(leg.f) + ' ' + esc(leg.d) + ' → ' + esc(leg.to) + ' ' + esc(leg.a) + '</b><small>' + esc(taskDate) + ' · ' + fmtDur(leg.m) + '</small></div>' +
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
  // 车次号 → 经停站（可改上/下车；改完重绘卡片与推导区间）
  list.querySelectorAll('.task-train-stops').forEach(function (b) {
    b.addEventListener('click', function () {
      var ix = findByTn(b.dataset.tn);
      if (ix < 0) return;
      openStopsForLeg(APP.taskPicked[ix].leg, function () { renderTaskPicked(); });
    });
  });
  renderNtDerived();
  updateNtSummary();
}

function enterPickMode() {
  // 从新建任务页「继续添加」进入：直接开启批量模式，右侧复选框才可用
  MON.batch = true;
  $('mPanel').classList.add('task-pick-mode', 'batch-mode');
  syncModeSeg();
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
  MON.sel = {}; MON.selSeats = {}; MON.selBy = {}; MON.selOrder = [];
  (APP.taskPicked || []).forEach(function (s) {
    MON.rows.forEach(function (r, i) {
      if (r.n !== s.leg.n) return;
      MON.sel[i] = true;
      rememberSelection(i);
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
  MON.rows.forEach(function (r, i) { if (!(r.n in idx) || MON.sel[i]) idx[r.n] = i; });
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
  MON.sel = {}; MON.selSeats = {}; MON.selBy = {}; MON.selOrder = [];
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
  MON.filters.hour = readHourRange();
  MON.filters.bookable = $('mAvailable').checked;
}
/* ---------- 出发时间：双点滑动条 ----------
   输出仍然是 matchHour() 认的 `'HH:00-HH:00'` 单区间（数组只有一个元素），
   全量 [0,24] 输出 []（= 不限），因此下游无需改动。 */
function hourText(h) { return pad2(h) + ':00'; }
function hourIsAll() { return MON.hourFrom <= 0 && MON.hourTo >= 24; }
function readHourRange() {
  if (hourIsAll()) return [];
  return [hourText(MON.hourFrom) + '-' + hourText(MON.hourTo)];
}
function renderHourRange() {
  var box = $('mHourRange'); if (!box) return;
  var pct = function (h) { return (h / 24) * 100; };
  var fill = $('mHourFill');
  if (fill) { fill.style.left = pct(MON.hourFrom) + '%'; fill.style.width = (pct(MON.hourTo) - pct(MON.hourFrom)) + '%'; }
  [['mHourFrom', MON.hourFrom], ['mHourTo', MON.hourTo]].forEach(function (p) {
    var el = $(p[0]); if (!el) return;
    el.style.left = pct(p[1]) + '%';
    el.setAttribute('aria-valuenow', String(p[1]));
    el.setAttribute('aria-valuetext', hourText(p[1]));
  });
  var all = hourIsAll();
  if ($('mHourVal')) {
    // 「不限」在轨道左侧（与其他筛选行的「全部」同位）；这里只显示当前区间。
    // 不限时留空但保留槽位（CSS min-width），避免切换时轨道宽度跳动
    $('mHourVal').textContent = all ? '' : (hourText(MON.hourFrom) + ' - ' + hourText(MON.hourTo));
    $('mHourVal').classList.toggle('on', !all);
  }
  if ($('mHourReset')) $('mHourReset').classList.toggle('on', all);
}
// 不变量：0 <= from < to <= 24（至少 1 小时的窗口），所以两端拖动永远不会交叉 / 互换
function setHourFrom(h) { MON.hourFrom = Math.max(0, Math.min(MON.hourTo - 1, Math.round(h))); }
function setHourTo(h) { MON.hourTo = Math.max(MON.hourFrom + 1, Math.min(24, Math.round(h))); }
function applyHourRange() { syncMonitorFilters(); applyMonitor(); }
function resetHourRange(opts) {
  MON.hourFrom = 0; MON.hourTo = 24;
  renderHourRange();
  if (!opts || opts.apply !== false) applyHourRange();
}
function bindHourRange() {
  var box = $('mHourRange'); if (!box) return;
  var rail = box.querySelector('.hr-rail');
  if (!rail) return;
  renderHourRange();
  function hourAt(clientX) {
    var r = rail.getBoundingClientRect();
    if (!r.width) return 0;
    var x = Math.max(0, Math.min(r.width, clientX - r.left));
    return (x / r.width) * 24;
  }
  // 拖动过程中只更新视觉（便宜），松手才重新筛选 —— 否则每一像素都要重建整张表
  function drag(which, startEvent) {
    var move = function (ev) {
      if (which === 'from') setHourFrom(hourAt(ev.clientX)); else setHourTo(hourAt(ev.clientX));
      renderHourRange();
    };
    var up = function () {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      document.body.classList.remove('hr-dragging');
      applyHourRange();
    };
    move(startEvent);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.body.classList.add('hr-dragging');
  }
  [['mHourFrom', 'from'], ['mHourTo', 'to']].forEach(function (p) {
    var el = $(p[0]); if (!el) return;
    el.addEventListener('pointerdown', function (e) { e.preventDefault(); drag(p[1], e); });
    el.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowLeft' ? -1 : (e.key === 'ArrowRight' ? 1 : 0);
      if (!d) return;
      e.preventDefault();
      if (p[1] === 'from') setHourFrom(MON.hourFrom + d); else setHourTo(MON.hourTo + d);
      renderHourRange(); applyHourRange();
    });
  });
  // 点轨道：把最近的一端移过来（否则轨道几乎只能用来拖）
  rail.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    var h = hourAt(e.clientX);
    drag(Math.abs(h - MON.hourFrom) <= Math.abs(h - MON.hourTo) ? 'from' : 'to', e);
  });
  if ($('mHourReset')) $('mHourReset').addEventListener('click', function () { resetHourRange(); });
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
  bindHourRange();
  if ($('mAvailable')) $('mAvailable').addEventListener('change', function () { syncMonitorFilters(); applyMonitor(); });
  if ($('mFilterClear')) $('mFilterClear').addEventListener('click', function () {
    ['mType', 'mFromStation', 'mToStation', 'mSeatFilter'].forEach(function (id) {
      var box = $(id); if (!box) return;
      box.querySelectorAll('input').forEach(function (i) { i.checked = (i.value === 'all'); });
    });
    resetHourRange({ apply: false });
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
  if ($('mSortAction')) $('mSortAction').addEventListener('click', function () {
    if (MON.sort) setMonSort(null);
  });
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
function monitorRouteStorageKey() {
  var user = localStorage.getItem(USERNAME_KEY) || 'default';
  return 'webx_monitor_route_v1:' + encodeURIComponent(user);
}
function restoreMonitorRoute() {
  try {
    var saved = JSON.parse(localStorage.getItem(monitorRouteStorageKey()) || 'null');
    var from = String(saved && saved.from || '').trim();
    var to = String(saved && saved.to || '').trim();
    if (!from || !to) return false;
    $('mFrom').value = from;
    $('mTo').value = to;
    return true;
  } catch (e) { return false; }
}
function rememberMonitorRoute(from, to) {
  from = String(from || '').trim();
  to = String(to || '').trim();
  if (!from || !to) return;
  try {
    localStorage.setItem(monitorRouteStorageKey(), JSON.stringify({ from: from, to: to }));
  } catch (e) { }
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
      rememberMonitorRoute(left, arrive);
      MON.rows = d.rows || [];
      MON.searched = true;
      MON.sel = {}; MON.selSeats = {}; MON.selBy = {}; MON.selOrder = [];
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
  // 筛选项来自余票结果中的实际站名，选择哪个站就只保留该站，不能按城市名前缀扩展。
  return list.indexOf(String(val || '')) >= 0;
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
  var sortStatus = $('mSortStatus');
  var sortAction = $('mSortAction');
  var sorted = !!MON.sort;
  if (sortStatus) sortStatus.setAttribute('aria-label', sorted ? '即时结果，点击清除排序' : '即时结果，点击表头排序');
  if (sortAction) {
    sortAction.classList.toggle('is-sorted', sorted);
    sortAction.disabled = !sorted;
    sortAction.title = sorted ? '清除当前排序' : '请点击表头排序';
    sortAction.setAttribute('aria-label', sorted ? '清除排序' : '表头排序提示');
    sortAction.textContent = sorted ? '清除排序' : '表头排序';
  }
}
function applyMonitor() {
  var F = MON.filters;
  var rows = MON.rows.filter(function (leg) {
    if (F.types.length && F.types.indexOf(trainTypeOf(leg.n)) < 0) return false;
    if (!matchStation(leg.f, F.fromSt)) return false;
    if (!matchStation(leg.to, F.toSt)) return false;
    if (F.seats.length) {
      var hasAny = F.seats.some(function (k) {
        return seatHasTicket(leg && leg.s ? leg.s[k] : undefined);
      });
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
  // 真实票价是异步拉的：先出列表，拿到价格再就地回填（有 6h 缓存，重复搜索几乎瞬时）
  loadPrices();
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
      if (b.dataset.act === 'stops') {
        openStops(i);
      } else if (b.dataset.act === 'book') {
        // 席别可以在下单页面里选（renderOrderView 的席别 chip 可点）→ 这里不再强制
        orderPush(MON.rows[i]);
        go('order');
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
      if (!inBatchUI()) clearOtherSeatSelections(i);
      MON.selSeats[i] = MON.selSeats[i] || {};
      if (MON.selSeats[i][k]) delete MON.selSeats[i][k]; else MON.selSeats[i][k] = true;
      td.classList.toggle('seat-selected', !!MON.selSeats[i][k]);
      var tr = td.closest('tr');
      // 批量界面下：点席别即自动勾选该行；取消全部席别后自动取消勾选
      if (inBatchUI()) {
        syncRowCheckFromSeats(i, tr);
        // 逐个点席别 = 「已明确指定」语义：提交时不做默认补全
      }
      syncSelCount();
      // 不实时写草稿：由底部「添加到任务」显式提交
    });
  });
  syncSelCount();
}

/* ---------- 经停站（点击车次号打开） ----------
   数据源：GET /api/tickets/stops?train_no=<12306 内部车次号>&date=
   只展示 12306 真实返回的字段（到站/出发/停留/累计历时）。
   **不展示票价**：分站票价接口已不可用，估算值对用户弊大于利（会误以为可据此决策）。

   编辑能力：可以在列表里把「上车站 / 下车站」改成任一中间站。
   典型场景 —— 全程区间没票，但中间某段有票（例如 深圳东→三亚 无票，
   但 东莞→海口 有票）。改完点「应用」把区间写回该车次：
   站名、到发时刻、历时都按新上下车点重算，票价估算与推导区间随之更新。

   `leg` 对象是 `MON.rows` / `APP.taskPicked` 共享的引用，所以改一处两边都变。 */
var STOPS = { leg: null, data: null, from: -1, to: -1, onApply: null };

function openStops(i) { openStopsForLeg(MON.rows[i], null); }

function openStopsForLeg(leg, onApply, dateOverride, cachedStops) {
  if (!leg) return;
  if (!leg.no) { toast('该车次缺少 12306 内部编号，无法查询经停站', 'err'); return; }
  STOPS.leg = leg;
  STOPS.data = null;
  STOPS.from = -1;
  STOPS.to = -1;
  STOPS.onApply = onApply || null;
  $('stopsTitle').textContent = (leg.n || '') + ' 经停站';
  $('stopsSum').innerHTML =
    '<span class="tag info">' + esc(leg.f) + ' → ' + esc(leg.to) + '</span>' +
    '<span class="tag muted">' + esc(leg.d) + ' 开 · 全程 ' + fmtDur(leg.m) + '</span>';
  $('stopsBody').innerHTML = '<tr><td colspan="7" class="stops-msg">正在获取经停站…</td></tr>';
  $('stopsNote').innerHTML = '';
  $('stopsPick').innerHTML = '';
  $('stopsModal').classList.add('open');
  var date = dateOverride || (($('mDate') || {}).value || '');
  if (cachedStops) {
    STOPS.data = cachedStops;
    syncStopsSelection();
    renderStops();
    return;
  }
  api('/api/tickets/stops?train_no=' + encodeURIComponent(leg.no) +
      '&date=' + encodeURIComponent(date))
    .then(function (d) {
      STOPS.data = d;
      syncStopsSelection();
      renderStops();
    })
    .catch(function (e) {
      $('stopsBody').innerHTML = '';
      $('stopsNote').innerHTML = '<b>获取失败：</b>' + esc(e.message);
    });
}

function closeStops() { $('stopsModal').classList.remove('open'); }

/**
 * 把上/下车选中态同步到 `STOPS.leg` 当前的区间。
 * 两处用它：① 弹窗刚打开（高亮车次现有区间）；② 点「恢复原区间」。
 * ⚠️ 「恢复原区间」指的是**恢复成该车次当前的上/下车站**，不是重置成 12306 的
 * 始发→终点 —— 用户改了区间后想反悔，期望回到改之前的样子，而不是被丢到全程。
 */
function syncStopsSelection() {
  var d = STOPS.data, leg = STOPS.leg;
  var stops = (d && d.stops) || [];
  if (!stops.length || !leg) return;
  STOPS.from = -1;
  STOPS.to = -1;
  for (var k = 0; k < stops.length; k++) {
    if (STOPS.from < 0 && stops[k].name === leg.f) STOPS.from = k;
    if (stops[k].name === leg.to) STOPS.to = k;
  }
  // 匹配不上（站名不一致）时退回「第 2 站 → 最后 1 站」这种可见的范围，
  // 而不是全程：全程区间通常是用户想避开的那一段
  if (STOPS.to < 0) STOPS.to = STOPS.from >= 0 ? stops.length - 1 : stops.length - 1;
  if (STOPS.from < 0) STOPS.from = 0;
  // 上车站必须在下车站之前
  if (STOPS.from >= STOPS.to) {
    STOPS.to = Math.min(stops.length - 1, STOPS.from + 1);
    if (STOPS.from >= STOPS.to) STOPS.from = Math.max(0, STOPS.to - 1);
  }
}

function renderStops() {
  var d = STOPS.data;
  if (!d) return;
  var stops = d.stops || [];
  // 表格窄，时长去空格更紧凑（`5小时56分`），否则「累计」列会溢出版面
  var compact = function (min) {
    if (min == null) return '—';
    return fmtDur(min).replace(/\s+/g, '');
  };
  $('stopsBody').innerHTML = stops.map(function (s, i) {
    var isFrom = i === STOPS.from, isTo = i === STOPS.to;
    var offL = i >= STOPS.to, offR = i <= STOPS.from;   // 不允许越界：上车必须早于下车
    return '<tr class="' + (isFrom || isTo ? 'stop-sel' : '') + '">' +
      '<td class="sn">' + esc(s.no || '') + '</td>' +
      '<td class="sname">' + esc(s.name || '') + '</td>' +
      '<td>' + esc(s.arrive || '—') + (s.day_diff ? '<i class="day-diff">+' + s.day_diff + '</i>' : '') + '</td>' +
      '<td>' + esc(s.start || '—') + '</td>' +
      '<td>' + (s.stay == null ? '—' : s.stay + '分') + '</td>' +
      '<td>' + compact(s.elapsed) + '</td>' +
      '<td class="spick">' +
        '<button type="button" class="pick-btn' + (isFrom ? ' on' : '') + '"' +
          (offL ? ' disabled' : '') + ' data-pick="from" data-i="' + i + '"' +
          ' title="' + (offL ? '上车站必须早于下车站' : '设为上车站') + '">上</button>' +
        '<button type="button" class="pick-btn' + (isTo ? ' on to' : '') + '"' +
          (offR ? ' disabled' : '') + ' data-pick="to" data-i="' + i + '"' +
          ' title="' + (offR ? '下车站必须晚于上车站' : '设为下车站') + '">下</button>' +
      '</td>' +
      '</tr>';
  }).join('');
  $('stopsBody').querySelectorAll('.pick-btn').forEach(function (b) {
    if (b.disabled) return;
    b.addEventListener('click', function () {
      var i = +b.dataset.i;
      if (b.dataset.pick === 'from') { STOPS.from = i; if (STOPS.to <= i) STOPS.to = i + 1; }
      else { STOPS.to = i; if (STOPS.from >= i) STOPS.from = i - 1; }
      renderStops();
    });
  });
  var picked = stopsPickSummary();
  $('stopsPick').innerHTML = picked
    ? '已选区间：<b>' + esc(picked.f) + ' → ' + esc(picked.to) + '</b>' +
      '<small>' + picked.d + ' 开 · 历时 ' + fmtDur(picked.m) + '</small>'
    : '';
  $('stopsNote').innerHTML = '共 <b>' + stops.length + '</b> 站 · 全程 <b>' +
    (d.total_minutes == null ? '—' : fmtDur(d.total_minutes)) + '</b>（12306 经停站数据）' +
    '<br>席别余票是<b>原查询区间</b>的数据；改成中间站区间后，实际余票请以 12306 为准。';
}

/** 由当前上/下车选择推导出区间（站名 + 到发时刻 + 历时）。分钟数都是相对始发站。 */
function stopsPickSummary() {
  var d = STOPS.data;
  if (!d) return null;
  var stops = d.stops || [];
  var a = stops[STOPS.from], b = stops[STOPS.to];
  if (!a || !b || STOPS.from >= STOPS.to) return null;
  // 上车站用「出发」时刻，下车站用「到达」时刻（与 12306 列表口径一致）
  var dep = a.start || a.arrive || '';
  var arr = b.arrive || b.start || '';
  var m = (b.elapsed != null && a.elapsed != null) ? (b.elapsed - a.elapsed) : null;
  return { f: a.name, to: b.name, d: dep, a: arr, m: m };
}

/** 把弹窗里选的区间写回 leg（站名 / 时刻 / 历时），并刷新所有依赖它的界面 */
function applyStopsPick() {
  var leg = STOPS.leg, p = stopsPickSummary();
  if (!leg || !p) { toast('请先选择上车站与下车站', 'err'); return; }
  if (p.f === leg.f && p.to === leg.to) { closeStops(); return; }
  leg.f = p.f;
  leg.to = p.to;
  if (p.d) leg.d = p.d;
  if (p.a) leg.a = p.a;
  if (p.m != null) leg.m = p.m;
  // 上/下站变了 → 原电报码已不再描述这对站，清掉；
  // priceKey() 会退化成用站名，后端解析后重新查真实票价。
  leg.f_code = '';
  leg.to_code = '';
  $('stopsSum').innerHTML =
    '<span class="tag info">' + esc(leg.f) + ' → ' + esc(leg.to) + '</span>' +
    '<span class="tag muted">' + esc(leg.d) + ' 开 · 全程 ' + fmtDur(leg.m) + '</span>';
  // 席别余票属于原区间，改区间后清掉「可订」标记，避免继续显示成可订
  leg.bookable = false;
  refreshAfterLegChange(STOPS.onApply);
  toast(leg.n + ' 区间已改为 ' + leg.f + ' → ' + leg.to, 'ok');
  closeStops();
}

/** leg 变更后统一刷新：车票列表、任务卡片、推导区间、摘要 */
function refreshAfterLegChange(extra) {
  try {
    if ((MON.rows || []).length) applyMonitor();   // 内部会调 loadPrices() 重拉新区间票价
    if (typeof renderTaskPicked === 'function') renderTaskPicked();
    if (typeof renderNtDerived === 'function') renderNtDerived();
    if (typeof updateNtSummary === 'function') updateNtSummary();
  } catch (e) { /* 刷新失败不影响数据正确性 */ }
  if (typeof extra === 'function') { try { extra(); } catch (e) { } }
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
    var hasRows = !!document.querySelector('#mResults tr[data-i]');
    var bh = barVisible && hasRows ? selBar.offsetHeight : 0;
    // bh 为 0 说明面板当前不可见（如还在别的视图），交给 CSS 兜底值
    scrollBox.style.paddingBottom = barVisible ? (bh ? (bh + 32) + 'px' : '0px') : '';
  }
  // 「重置选择」贴在「已选 N 条」计数旁（2026-09 重设计）：只有在真有可清的勾选时出现，
  // 平时不占位；非批量模式下悬浮栏本身只在勾选后才显示，批量模式下栏常驻但计数为 0 时隐藏按钮。
  $('mSelReset').style.display = c > 0 ? '' : 'none';
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
    // 含 无座（表格 6 列之外的席别也可能买，统一从 12306 全席别里给）
    var seats = ['business', 'first', 'second', 'hardSleeper', 'hardSeat', 'softSleeper', 'special', 'noSeat'];
    var names = { business: '商务座', first: '一等座', second: '二等座', hardSleeper: '硬卧', hardSeat: '硬座', softSleeper: '软卧', special: '特等座', noSeat: '无座' };
    return '<div class="task-selection-item" data-idx="' + idx + '">' +
      '<div class="train"><b>' + esc(leg.n) + '</b><small>' + esc(leg.tn) + '</small></div>' +
      '<div class="station"><b>' + esc(leg.f) + '  ' + esc(leg.d) + '</b><small>→ ' + esc(leg.to) + '  ' + esc(leg.a) + '</small></div>' +
      '<div class="task-seat-options">' + seats.map(function (k) {
        var v = leg.s ? leg.s[k] : '';
        var on = s.seats[k];
        var offered = seatOffered(leg, k);
        var tip = '点选/取消该席别；' + (v === '无' ? '当前无票，任务会等待放票' : (offered ? '' : '该车次不设此席别'));
        return '<span class="task-seat-option chip ' + (on ? 'on' : '') + '" data-k="' + k + '" title="' + esc(tip) + '" style="margin:0;background:' + (on ? 'var(--red-bg)' : 'var(--line-soft)') + ';border-radius:6px;font-size:11.5px;cursor:' + (offered ? 'pointer' : 'not-allowed') + ';color:' + (offered ? 'var(--text)' : 'var(--faint)') + ';display:flex;align-items:center;justify-content:center;height:30px"><span>' + names[k] + (offered ? '<small style="opacity:.7"> ' + esc(v === '有' ? '有' : v) + '</small>' : '') + '</span></span>';
      }).join('') + '</div>' +
      '<div style="display:flex;align-self:center"><button class="btn btn-ghost btn-sm" data-rm="' + idx + '">移除</button></div></div>';
  }).join('');
  $('oSelections').querySelectorAll('[data-rm]').forEach(function (b) {
    b.addEventListener('click', function () { APP.orderSel.splice(+b.dataset.rm, 1); renderOrderView(); });
  });
  // 席别 chip 可点选（「预定」入口不再强制先在表格里选席别）
  $('oSelections').querySelectorAll('.task-seat-option[data-k]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      var item = chip.closest('.task-selection-item');
      var s = item && (APP.orderSel || [])[+item.dataset.idx];
      if (!s) return;
      var k = chip.dataset.k;
      if (!seatOffered(s.leg, k)) { toast('该车次不设此席别', 'err'); return; }
      if (s.seats[k]) delete s.seats[k]; else s.seats[k] = true;
      renderOrderView();
    });
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
      if (s.seats[k]) { var p = priceOf(s.leg, k); if (p != null) { total += p; cnt++; } }
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
    row('预计金额', t.cnt ? '¥' + fmtNum(Math.round(t.total * (ps.length || 1) * 10) / 10)
                      : '<span style="color:var(--faint)">票价加载中</span>');
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
  if (!f.seats.length) { toast('请点选上面车次卡片里的席别（如「二等座」）', 'err'); return; }
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
  query_mode 已保存的任务恢复原查询方式；旧任务按是否存在车次白名单兼容推断。 */
function jobEdit(id) {
  api('/api/jobs/' + encodeURIComponent(id)).then(function (j) {
    APP.editJobId = id;
    go('new', { keepEdit: true, job: j });
  }).catch(function (e) { toast(e.message, 'err'); });
}

function applyJobToForm(j) {
  // 新任务保存了明确查询模式；旧任务没有该字段时，用车次白名单兼容推断。
  var savedMode = j.query_mode === 'train' || j.query_mode === 'range'
    ? j.query_mode
    : ((j.train_numbers || []).length ? 'train' : 'range');
  // 数据库只保存车次号、区间、日期和席别，不保存查票响应里的完整 leg。
  // 编辑旧任务时用这些持久字段重建最小卡片，避免车次列表为空；余票未知时显示“—”。
  APP.taskPicked = savedMode === 'train' ? restoreTaskTrains(j) : [];
  APP.pickOrder = APP.taskPicked.map(function (s) { return s.leg.n; });
  setNtMode(savedMode);
  if ($('ntName')) $('ntName').value = j.job_name || '';
  // 区间地点
  $('ntPairs').innerHTML = '';
  var st = (j.stations && j.stations.length) ? j.stations : [{ left: '', arrive: '' }];
  st.forEach(function (p) { addNtPair(p.left || '', p.arrive || ''); });
  // 站点匹配方式（exact / expand）—— 必须回填，否则编辑既有任务会被静默改回默认值
  setNtStnMode(j.station_mode || 'exact');
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
  // 编辑时保留原始计划时间（包括已经触发/过去的时间），便于查看和按需修改。
  setNtStartAt(j.start_at || '');
  if (savedMode === 'train') {
    syncSeatsFromPicked();
    renderTaskPicked();
    refreshTaskTrainData(j);
  }
  renderNtDates();
  renderNtSeats();
  updateNtSummary();
}

function restoreTaskTrains(j) {
  var pair = (j.stations && j.stations[0]) || {};
  var seats = (j.seats || []).slice();
  var seatMap = {};
  seats.forEach(function (name) {
    var key = SEAT_KEY[name];
    if (key) seatMap[key] = '—';
  });
  return (j.train_numbers || []).map(function (number) {
    return {
      leg: {
        n: String(number), tn: '', f: pair.left || '', d: '',
        to: pair.arrive || '', a: '', m: null, s: seatMap
      },
      seats: seats.slice()
    };
  });
}

function refreshTaskTrainData(j) {
  var numbers = (j.train_numbers || []).map(function (n) { return String(n); });
  var pairs = j.stations || [], dates = j.left_dates || [], requests = [];
  pairs.forEach(function (pair) {
    dates.forEach(function (date) {
      if (pair.left && pair.arrive && date) requests.push({ left: pair.left, arrive: pair.arrive, date: date, station_mode: j.station_mode || 'exact' });
    });
  });
  if (!numbers.length || !requests.length) return;
  var querySeq = (APP.taskTrainQuerySeq || 0) + 1;
  APP.taskTrainQuerySeq = querySeq;
  Promise.all(requests.map(function (q) {
    return api('/api/tickets?' + new URLSearchParams(q).toString())
      .then(function (d) { return d.rows || []; })
      .catch(function () { return []; });
  })).then(function (groups) {
    if (APP.taskTrainQuerySeq !== querySeq || !APP.editJobId) return;
    var latest = {};
    groups.forEach(function (rows) {
      rows.forEach(function (leg) {
        var number = String(leg.n || '');
        if (number && numbers.indexOf(number) >= 0 && !latest[number]) latest[number] = leg;
      });
    });
    APP.taskPicked = numbers.map(function (number) {
      var leg = latest[number];
      if (leg) return { leg: leg, seats: (j.seats || []).slice() };
      // 接口暂时没有返回该车次时仍保留任务白名单，避免编辑后误删车次。
      return restoreTaskTrains({ stations: pairs, train_numbers: [number], seats: j.seats || [] })[0];
    });
    APP.pickOrder = numbers.slice();
    syncSeatsFromPicked();
    renderTaskPicked();
    loadPrices(APP.taskPicked.map(function (s) { return s.leg; }), dates[0]);
  });
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
  var value = at ? String(v).replace(' ', 'T') : '';
  if (at && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) value += ':00';
  if ($('ntStartAt')) $('ntStartAt').value = value;
  syncNtStartMode();
}

// 编辑态：标题与主按钮文案随编辑态切换，并显示「取消编辑」
function setEditMode(on) {
  var h = $('newTitle'), c = $('newSub'), btn = $('taskFlowNext'), cancel = $('taskFlowCancel');
  if (h) h.textContent = on ? '编辑抢票任务' : '新建抢票任务';
  if (c) c.textContent = on ? '保存后立即热重载；原任务的启用状态保持不变' : '保存后立即生效；定时任务按北京时间到秒启动';
  if (btn) btn.textContent = on ? '保存修改' : '创建任务';
  if (cancel) cancel.classList.toggle('hidden', !on);
}
function clearJobEdit() {
  APP.editJobId = null;
  APP.pendingAccount = null;
  APP.pendingPax = null;
  // 任务名回到空：否则新建任务会沿用上一个任务的名字（用户报的「默认使用上一个名称」）
  if ($('ntName')) $('ntName').value = '';
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
    query_mode: train ? 'train' : 'range',
    account_key: $('ntAccount').value || '',
    left_dates: (APP.selDates || []).slice(),
    // 顺序即优先级（引擎 handle_seats 按序尝试）
    stations: ntPairs(),          // 车次查询模式下由车次推导（见 pickedPairs）
    // 站点匹配方式：引擎按它过滤行的实际到发站（见 AGENTS.md §5.25）
    station_mode: ntStnMode(),
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
    start_mode: ntStartMode(),
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
  // 账号未就绪时任务会卡在引擎 wait_for_ready()，一条查询也发不出去 → 提前拦住
  if (APP.accReady && APP.accReady[f.account_key] === false) {
    toast('所选账号当前未登录，创建后任务不会查询。请先到「账号管理」完成登录', 'err', 5000);
    return;
  }
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
      toast(editing ? '任务已保存' : (f.start_at ? '任务已创建，等待定时启动' : '任务已创建并开始抢票'), 'ok');
      go('jobs');
    })
    .catch(function (e) { toast(e.message, 'err'); })
    .finally(function () { if (btn) btn.disabled = false; });
}
// 表格展示的席别列（单一事实来源）：列渲染、可选席别、任务席别来源均用它，
// 保证「看到的 / 能点的 / 会带进任务的」完全一致
var MON_SEAT_KEYS = ['business', 'first', 'second', 'hardSleeper', 'hardSeat', 'noSeat'];
var SEAT_NAME = { business: '商务座', first: '一等座', second: '二等座', hardSleeper: '硬卧', hardSeat: '硬座', softSleeper: '软卧', special: '特等座', noSeat: '无座' };
// 中文名 → key（席别优先级存的是中文名，算价要用 key）
var SEAT_KEY = (function () {
  var m = {};
  Object.keys(SEAT_NAME).forEach(function (k) { m[SEAT_NAME[k]] = k; });
  return m;
})();
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
    var sections = [];
    function fldLabel(label, path, extra) {
      extra = extra || {};
      var v = deepGet(c, path);
      var isSecret = !!deepGet(st, path);
      var stv = deepGet(st, path) || {};
      var field;
      var numPaths = ['query.interval', 'user.heartbeat_interval', 'query.request_max_retry', 'query.job_timeout', 'query.presale_days', 'cdn.check_time_out', 'server.port', 'cluster.redis_port'];
      var isBool = extra.type === 'bool' || typeof v === 'boolean' || /enabled|allow/.test(path) || (typeof v === 'number' && numPaths.indexOf(path) < 0);
      if (isBool) {
        var on = v === 1 || v === true || v === '1';
        return '<div class="setting-toggle"><div><b>' + esc(label) + '</b>' + (extra.hint ? '<small>' + esc(extra.hint) + '</small>' : '') + '</div><label class="tgl"><input type="checkbox" aria-label="' + esc(label) + '" data-path="' + path + '"' + (extra.inputAttrs ? ' ' + extra.inputAttrs : '') + (on ? ' checked' : '') + '><i></i></label></div>';
      } else if (extra.options) {
        field = '<select class="ctl" data-path="' + path + '">' + extra.options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(v == null ? '' : v) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
      } else if (typeof v === 'number') {
        field = '<input class="ctl" type="number" step="any" data-path="' + path + '" value="' + esc(v) + '">';
      } else {
        var input = isSecret
          ? '<input class="ctl" type="password" data-path="' + path + '" data-configured="' +
            (stv.configured ? '1' : '0') + '" placeholder="' +
            (stv.configured ? '已配置 ' + esc(stv.tail || '') + '（留空不改）' : '未配置') + '">'
          : '<input class="ctl" type="text" data-path="' + path + '" value="' + esc(v || '') + '">';
        field = input;
      }
      return '<label class="setting-field"' + (extra.relatedTo ? ' data-related-to="' + extra.relatedTo + '"' : '') + '><span>' + esc(label) + (extra.hint ? '<small>' + esc(extra.hint) + '</small>' : '') + '</span>' + field + '</label>';
    }
    function intervalControl() {
      var raw = deepGet(c, 'query.interval');
      var min = raw && typeof raw === 'object' ? Number(raw.min) : Number(raw || 1) / 2;
      var max = raw && typeof raw === 'object' ? Number(raw.max) : Number(raw || 1);
      if (!isFinite(min) || !isFinite(max)) { min = 0.5; max = 1; }
      var preset = Math.abs(min - 0.5) < 0.001 && Math.abs(max - 1) < 0.001 ? 'default' : (Math.abs(min - 1) < 0.001 && Math.abs(max - 1) < 0.001 ? 'fixed' : 'custom');
      return '<div class="interval-setting"><label class="setting-field"><span>查询间隔<small>每次查询随机落在所选区间内</small></span><select class="ctl" id="settingsIntervalPreset"><option value="default"' + (preset === 'default' ? ' selected' : '') + '>0.5 - 1 秒（默认）</option><option value="fixed"' + (preset === 'fixed' ? ' selected' : '') + '>1 秒</option><option value="custom"' + (preset === 'custom' ? ' selected' : '') + '>自定义</option></select></label><div class="interval-custom"' + (preset === 'custom' ? '' : ' hidden') + '><label class="setting-field"><span>最小值（秒）</span><input class="ctl" type="number" min="0.1" step="0.1" data-path="query.interval.min" value="' + esc(min) + '"></label><label class="setting-field"><span>最大值（秒）</span><input class="ctl" type="number" min="0.1" step="0.1" data-path="query.interval.max" value="' + esc(max) + '"></label></div></div>';
    }
    function section(id, title, desc, content) {
      sections.push('<section class="settings-section" id="' + id + '"><div class="settings-section-head"><h3>' + title + '</h3><p>' + desc + '</p></div>' + content + '</section>');
    }
    function channel(title, desc, enabledPath, required, fields) {
      return '<article class="setting-channel" data-required-paths="' + required.join(',') + '"><div class="channel-head"><div><h4>' + title + '</h4><p>' + desc + '</p></div><div class="channel-actions">' + fldLabel('启用', enabledPath, { type: 'bool', inputAttrs: 'data-channel-enabled' }) + '<button type="button" class="channel-config" data-channel-toggle aria-expanded="false">设置</button></div></div><div class="channel-fields" hidden>' + fields + '</div></article>';
    }
    section('set-query', '查询与运行', '影响查询节奏、账号心跳和运行时资源使用。', '<div class="settings-grid">' +
      intervalControl() +
      fldLabel('请求重试次数', 'query.request_max_retry') +
      fldLabel('任务超时（秒）', 'query.job_timeout') +
      fldLabel('账号心跳间隔（秒）', 'user.heartbeat_interval') +
      fldLabel('多线程查询', 'query.thread_enabled', { type: 'bool', hint: '每个任务独立线程查询' }) +
      '<div class="setting-pair setting-cdn-pair">' + fldLabel('启用 CDN', 'cdn.enabled', { type: 'bool' }) + fldLabel('CDN 检测超时（秒）', 'cdn.check_time_out', { relatedTo: 'cdn.enabled' }) + '</div>' +
      fldLabel('日志写入文件', 'log.to_file', { type: 'bool' }) + '</div>');
    section('set-notify', '通知渠道', '每个渠道独立配置；开关只控制当前渠道，不会影响其他提醒方式。', '<div class="channel-grid">' +
      channel('短信语音', '验证码或重要状态的语音提醒', 'notification.voice_code.enabled', ['notification.voice_code.app_code', 'notification.voice_code.phone'], fldLabel('服务商', 'notification.voice_code.type', { options: [['dingxin', '鼎信'], ['yiyuan', '易源']] }) + fldLabel('AppCode', 'notification.voice_code.app_code') + fldLabel('手机号', 'notification.voice_code.phone')) +
      channel('钉钉机器人', '向钉钉群机器人发送命中与下单提醒', 'notification.dingtalk.enabled', ['notification.dingtalk.webhook'], fldLabel('Webhook 地址', 'notification.dingtalk.webhook')) +
      channel('Telegram', '通过 Bot API 推送消息', 'notification.telegram.enabled', ['notification.telegram.bot_api_url'], fldLabel('Bot API 地址', 'notification.telegram.bot_api_url')) +
      channel('Server酱', '通过 SendKey 推送到微信', 'notification.serverchan.enabled', ['notification.serverchan.key'], fldLabel('SendKey', 'notification.serverchan.key')) +
      channel('PushBear', '通过 Key 推送到微信', 'notification.pushbear.enabled', ['notification.pushbear.key'], fldLabel('PushBear Key', 'notification.pushbear.key')) +
      channel('Bark', '推送到 iPhone 的 Bark 地址', 'notification.bark.enabled', ['notification.bark.push_url'], fldLabel('Push URL', 'notification.bark.push_url')) +
      channel('邮件', '使用 SMTP 发送通知邮件', 'notification.email.enabled', ['notification.email.sender', 'notification.email.receiver', 'notification.email.host', 'notification.email.user', 'notification.email.password'], fldLabel('发件人', 'notification.email.sender') + fldLabel('收件人', 'notification.email.receiver') + fldLabel('SMTP 主机', 'notification.email.host') + fldLabel('SMTP 账号', 'notification.email.user') + fldLabel('SMTP 密码', 'notification.email.password')) + '</div>');
    section('set-service', '服务与登录', '管理台监听、验证码平台与登录凭据。', '<div class="settings-grid">' +
      '<div class="setting-field"><span>管理台用户名<small>不可修改</small></span><input class="ctl" type="text" value="' + esc(c.web.username) + '" disabled></div>' +
      fldLabel('重置管理台密码', 'web.password', { hint: '留空表示不修改' }) +
      '<div class="setting-pair">' + fldLabel('服务监听地址', 'server.host') + fldLabel('服务端口', 'server.port') + '</div>' +
      '<div class="setting-pair setting-auth-pair">' + fldLabel('验证码平台', 'auth_code.platform') + fldLabel('验证码 API 地址', 'auth_code.api') + '</div>' +
      '<div class="setting-pair setting-auth-pair">' + fldLabel('验证码账号', 'auth_code.account.user') + fldLabel('验证码密码', 'auth_code.account.pwd') + '</div></div>');
    section('set-cluster', '集群与设备', '集群节点和 RAIL 设备缓存配置。未启用集群时，节点字段不会参与本地查询。', '<div class="settings-grid">' +
      fldLabel('启用集群', 'cluster.enabled', { type: 'bool' }) + fldLabel('本节点可当选 Master', 'cluster.node_is_master', { type: 'bool' }) +
      fldLabel('从节点可晋升', 'cluster.node_slave_can_be_master', { type: 'bool' }) + fldLabel('节点名', 'cluster.node_name') +
      fldLabel('Redis 主机', 'cluster.redis_host') + fldLabel('Redis 端口', 'cluster.redis_port') + fldLabel('Redis 密码', 'cluster.redis_password') +
      '<div class="setting-pair setting-rail-pair">' + fldLabel('缓存 RAIL 设备 ID', 'rail.cache_enabled', { type: 'bool', hint: '启用后才使用右侧设备参数' }) +
      fldLabel('设备 ID', 'rail.device_id', { relatedTo: 'rail.cache_enabled' }) + fldLabel('设备过期值', 'rail.expiration', { relatedTo: 'rail.cache_enabled' }) + '</div></div>');
    $('setGrid').innerHTML = '<div class="settings-layout"><div class="settings-main">' + sections.join('') + '</div><div class="settings-note">配置持久化于 <b>runtime/webx.json</b>；密钥字段留空表示保持原值。日志：' + esc((c.log.path || '') + (c.log.path_exists ? '（存在）' : '（未生成）')) + '</div></div>';
    var intervalPreset = $('settingsIntervalPreset');
    if (intervalPreset) intervalPreset.addEventListener('change', function () {
      var custom = intervalPreset.value === 'custom';
      var box = document.querySelector('#view-settings .interval-custom');
      if (box) box.hidden = !custom;
      if (!custom) {
        var minInput = document.querySelector('[data-path="query.interval.min"]');
        var maxInput = document.querySelector('[data-path="query.interval.max"]');
        if (minInput) minInput.value = intervalPreset.value === 'fixed' ? '1' : '0.5';
        if (maxInput) maxInput.value = '1';
      }
    });
    document.querySelectorAll('#view-settings [data-channel-toggle]').forEach(function (button) {
      button.addEventListener('click', function () {
        var card = button.closest('.setting-channel');
        var fields = card && card.querySelector('.channel-fields');
        if (!fields) return;
        fields.hidden = !fields.hidden;
        card.classList.toggle('open', !fields.hidden);
        button.setAttribute('aria-expanded', String(!fields.hidden));
        button.textContent = fields.hidden ? '设置' : '收起';
      });
    });
    function channelReady(card) {
      return (card.dataset.requiredPaths || '').split(',').every(function (path) {
        var input = card.querySelector('[data-path="' + path + '"]');
        return input && (String(input.value || '').trim() || input.dataset.configured === '1');
      });
    }
    function syncRelatedFields() {
      document.querySelectorAll('#view-settings [data-related-to]').forEach(function (field) {
        var input = field.querySelector('[data-path]');
        var controller = document.querySelector('#view-settings [data-path="' + field.dataset.relatedTo + '"]');
        var disabled = controller && !controller.checked;
        if (input) input.disabled = disabled;
        field.classList.toggle('is-disabled', disabled);
      });
    }
    document.querySelectorAll('#view-settings [data-channel-enabled]').forEach(function (input) {
      if (input.checked && !channelReady(input.closest('.setting-channel'))) input.checked = false;
    });
    document.querySelectorAll('#view-settings [data-channel-enabled], #view-settings [data-path="cdn.enabled"], #view-settings [data-path="rail.cache_enabled"]').forEach(function (input) {
      input.addEventListener('change', function () {
        var card = input.closest('.setting-channel');
        if (input.hasAttribute('data-channel-enabled') && input.checked && !channelReady(card)) {
          input.checked = false;
          toast('请先点击“设置”填写完整的通知配置', 'err');
          var button = card && card.querySelector('[data-channel-toggle]');
          if (button && card.querySelector('.channel-fields').hidden) button.click();
          return;
        }
        syncRelatedFields();
      });
    });
    syncRelatedFields();
  }).catch(function (e) { toast(e.message, 'err'); });
}
function deepGet(obj, path) {
  var cur = obj;
  path.split('.').forEach(function (p) { cur = (cur == null || typeof cur !== 'object') ? undefined : cur[p]; });
  return cur;
}
/* ---------- 站点绑定（静态） ---------- */
function wireStatic() {
  // 导航
  document.querySelectorAll('[data-view]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      var v = a.dataset.view;
      if (v === 'new') { prefillNewFromMonitor(); resetNtTaskName(); }
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
  function setBatchMode(on) {
    MON.batch = !!on;
    if (MON.batch) syncBatchChecksFromSeats();
    if (!MON.batch) keepOnlyOneSelection();
    $('mPanel').classList.toggle('batch-mode', MON.batch);
    syncModeSeg();
    // 任务添加态本质就是「批量模式」：关掉批量即结束本次添加（复选框与悬浮栏一起消失，保持一致）
    if (!MON.batch && inTaskPick()) exitPickMode();
    syncSelCount();
  }
  // 操作列表头：点击「批量」切换批量选择模式
  $('mBatchToggle').addEventListener('click', function () { setBatchMode(MON.batch ? false : true); });
  $('mFloatBind').addEventListener('click', openTaskBindModal);
  // 任务上下文（从新建任务页进来）：「添加到任务」= 保存本次修改，然后返回
  $('mFloatAddTask').addEventListener('click', function () {
    // 兜底：这个按钮只在「任务上下文」下可见，但若被程序化触发（或状态残留）时
    // syncDraftFromSelection() 会因 inTaskPick() 为假直接返回，
    // 结果是「提示已保存、其实什么都没加」。此时按「新建任务」处理才符合直觉。
    if (!inTaskPick()) { pickAddToTask(); return; }
    commitPick();
    // 勾选已转入任务，查询页的临时勾选清掉：否则会残留「看不见的选中态」，
    // 让「重置选择」按钮一直亮着
    MON.sel = {}; MON.selSeats = {}; MON.selBy = {}; MON.selOrder = [];
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
    MON.sel = {}; MON.selSeats = {}; MON.selBy = {}; MON.selOrder = [];
    applyMonitor();
  });
  // 批量关联弹窗
  $('closeTaskModal').addEventListener('click', function () { closeTaskBindModal(); });
  $('cancelTaskModal').addEventListener('click', function () { closeTaskBindModal(); });
  $('confirmTaskBind').addEventListener('click', confirmTaskBind);
  // 经停站弹窗：点遮罩/关闭按钮/按 Esc 退出
  $('closeStops').addEventListener('click', closeStops);
  $('stopsModal').addEventListener('click', function (e) {
    if (e.target === $('stopsModal')) closeStops();
  });
  // 「应用区间」把上/下车选择写回车次；「恢复原区间」回到该车次当前区间
  $('stopsApply').addEventListener('click', applyStopsPick);
  $('stopsReset').addEventListener('click', function () {
    syncStopsSelection();
    renderStops();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && $('stopsModal').classList.contains('open')) closeStops();
  });
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
// 用户**显式**点「新建任务」时把任务名重置为空。
// 否则会沿用上一次输入（甚至上一个任务的名字）——用户很容易把新任务建在旧名字下。
// ⚠️ 只在导航入口调用：从车票查询「添加到任务/取消」返回的是「继续编辑同一个草稿」，
//    那时候清空会把用户刚填好的名字抹掉。
function resetNtTaskName() {
  if (APP.editJobId) return;            // 编辑态保留回填的配置
  setNtStartAt('');                     // 新任务默认立即开始，不继承上一任务的定时点
  var n = $('ntName');
  if (n) n.value = '';
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
