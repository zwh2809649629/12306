# AGENTS.md — py12306 / webx 二次开发协作指南

> 面向**任何 AI agent 或新加入的开发者**的项目交接文档。
> 读这一份就能上手：改了哪些东西、为什么这么改、哪些坑踩过、怎么验证。
>
> 最后更新：2026-09-16 · Python 3.12.14 · Flask 3.1.3

---

## 0. TL;DR（30 秒版）

- 这是 **py12306**（12306 抢票助手）的**二次开发**：保留了原引擎，外面套了一套新的 Web 管理台（代号 **webx**）。
- **入口是 `main_web.py`**（不是 `main.py`）。访问 `http://127.0.0.1:8600`，账号 `admin` / 见 `runtime/webx.log`。
- **第一铁律：绝不修改 `py12306/` 下的原生文件**（`app.py`/`config.py`/`user/`/`query/`/`order/`/`helpers/`/`log/`，以及 `main.py`）。
  所有扩展都放 `py12306/webx/`，对原引擎用**包装（wrapper）**方式介入，见 §4。
- 新代码全部在 `py12306/webx/` + `main_web.py`。**唯一被修改的原生文件是零个**（`main_web.py` 也是新增的）。
- 前端是**无框架的单个 IIFE**（`static/main.js`，2674 行），没有模块系统、没有构建步骤。改了就刷新。

---

## 1. 环境与启动

### 解释器
```
D:\Anaconda\envs\12306\python.exe     # conda env "12306"，Python 3.12.14
```
`.vscode/settings.json` 已固化 `python.defaultInterpreterPath`。

### 依赖
```powershell
D:\Anaconda\envs\12306\python.exe -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple `
  requests requests-html flask PyJWT redis pypng lxml lxml_html_clean `
  DingtalkChatbot lightpush
```
- ⚠️ **`lxml_html_clean` 必须装**。lxml 6.x 移除了 `lxml.html.clean`，而 `requests-html 0.10.0`
  顶层 `from lxml.html.clean import Cleaner` → 不装则 `import py12306.helpers.request` 直接失败。
- ⚠️ **`requirements.txt` 已失效**（`Jinja2==2.10` / `MarkupSafe==1.1.0` / `itsdangerous==1.1.0` /
  `Click==7.0` 与 Flask 3.1.3 冲突）。**不要** `pip install -r requirements.txt`。

### 启动 / 停止
```powershell
# 启动（推荐：VS Code 集成终端；不弹外部窗口）
D:\Anaconda\envs\12306\python.exe main_web.py

# 仅起管理台、不跑抢票任务（测试用）
D:\Anaconda\envs\12306\python.exe main_web.py -t

# 健康检查（不依赖浏览器）
curl -s -m 8 -o nul -w "%{http_code}" http://127.0.0.1:8600/api/boot   # 期望 200
```
**启动方式约定（用户明确要求）**：
- ✅ 跑在 **VS Code 集成终端**里（终端面板收起即"隐藏"，不弹外部窗口）。
- ❌ 不要用 `cmd /c start "" /min python.exe main_web.py` —— **会弹一个控制台窗口**。
- ❌ 不要用 `pythonw.exe`（虽然无窗口，但用户也不想要）。
  `main_web.py` 里留了 `_ensure_streams()` 作为安全网：`pythonw` 下 `sys.stdout/stderr` 是 `None`，
  werkzeug / click / 原版 `print` 会抛异常；该函数把为 `None` 的流重定向到 `runtime/console.log`
  （**刻意不写进 `webx.log`**，否则每秒轮询的访问日志会淹没引擎日志）。终端模式下不触发。

### ⚠️ 重启时务必确认没有两个实例并存
`wmic process where "..." get ProcessId /value | findstr ProcessId` 在 cmd 里**经常静默失败**
（报「无效查询」或啥也不输出）→ 旧实例没死、新实例又起 → **两个进程同时监听 8600**
（Windows 允许），两边都写同一份 `webx.log` 和 `daily_query` 表 → 日志错乱 + 日计数翻倍。

```powershell
# 1) 拿 PID（应只有一行）
netstat -ano | Select-String ':8600' | Select-String 'LISTENING'
# 2) 杀
taskkill /PID <pid> /F
# 3) 确认端口已释放
netstat -ano | Select-String ':8600' | Select-String 'LISTENING'
# 4) 核对没有多余实例（可只留着 pythonw；python.exe 那个可能是别的工具）
Get-Process python*,pythonw* | Select-Object Id, ProcessName, MainWindowTitle
```
⚠️ `python.exe` 里可能混着 **ms-python.isort 的 LSP**（`lsp_server.py`），与本项目无关，**别误杀**。

---

## 2. 项目结构

```
main.py                    原版入口（不要改）
main_web.py                ★ webx 入口（我们新增的唯一入口文件）
env.py.example             原版配置模板（webx 不使用 env.py）
runtime/                   运行时数据（见 §7）
py12306/                   原版引擎（不要改）
  ├ app.py / config.py / helpers/ / user/ / query/ / order/ / log/ / cluster/
  └ webx/                  ★ 所有二次开发代码都在这
      ├ config_store.py        webx.json 读写（原子写 + 密钥脱敏）
      ├ db.py                  SQLite 封装（唯一数据源）
      ├ sync.py                webx(db/json) → 原版 Config 的桥接
      ├ webx12306.py           独立 12306 登录助手（扫码/密码/乘客）
      ├ engine_hooks.py        ★ 包装原引擎方法（不改原文件的扩展方式）
      ├ presale.py             预售期唯一事实来源
      ├ server/                Flask 蓝图（REST API）
      └ static/                前端 SPA（index.html + main.js + app.css，无框架）
reference_template/        设计稿（前端对齐它的视觉）
```

文件规模参考（便于判断改动影响面）：

| 文件 | 行数 | 说明 |
|---|---|---|
| `py12306/webx/static/main.js` | 2674 | 前端全部逻辑（单 IIFE） |
| `py12306/webx/static/index.html` | 726 | 页面骨架 + webx 补充样式块 |
| `py12306/webx/static/app.css` | 747 | 样式（前半我们的规则 + **后半是设计稿残留，坑多**） |
| `py12306/webx/engine_hooks.py` | 437 | 引擎包装，见 §4 |
| `py12306/webx/db.py` | 300 | 表结构 + 迁移 |
| `py12306/webx/webx12306.py` | 289 | 12306 登录助手 |

---

## 3. 架构：webx 与原引擎的关系

```
       浏览器 (8600)
            │
   ┌────────▼─────────┐
   │  webx Flask 服务  │  server/*.py（REST API）
   └────────┬─────────┘
            │ 读写
   ┌────────▼─────────┐
   │  runtime/webx.db │  ← 唯一数据源（job / account / order_log / hit_log / …）
   └────────┬─────────┘
            │ ConfigSync.publish_*()  （"保存即生效"）
   ┌────────▼─────────┐
   │  原版 Config     │  ← 后台代码只读 Config（webx.json + db 覆盖冷读值）
   └────────┬─────────┘
            │
   ┌────────▼──────────────────────────────────┐
   │  原版引擎：User.run() / Query.run() / Cdn  │
   │   ↑ engine_hooks 包装其方法落库            │
   └───────────────────────────────────────────┘
```

关键设计决策：

1. **配置源唯一是 webx**（`runtime/webx.json` + `webx.db`），**`env.py` 完全不参与**。
   `main_web._ensure_env_stub()` 把 `Config.CONFIG_FILE` 指向 `runtime/.webx_env` 空 stub
   （原版 `Config.__init__` 需要 `getmtime` 一个存在的文件）。
2. **"保存即生效"**：网页每次保存动作显式调用
   `ConfigSync.apply_settings()` / `publish_accounts()` / `publish_jobs()`，
   它们写 `Config` 并触发原版的 `update_*_configs_from_remote` 同款刷新入口，**不重启**。
3. **不用文件监视、不做漂移检测**：webx 是唯一写方，没必要。

### 启动顺序（`main_web.main()`，顺序有讲究）
```
load_argvs → CommonLog.print_welcome → App.run → CommonLog.print_configs → App.did_start
  → ConfigSync.startup()          # webx.json + db → Config（first=True，只写值不发请求）
  → install_engine_hooks()        # 包装引擎方法（见 §4）
  → WebX.run()                    # Flask 起在后台线程（0.0.0.0:8600）
  → App.run_check()
  → _start_webx_daemons()         # ★ 必须在 Query.run() 之前！见下
  → User.run()                    # ★ 账号心跳：必须在查询初始化之前
  → Cdn.run()
  → Query.check_before_run()      # 12306 查询初始化（频控时可能很慢）
  → Query.run()                   # ★ 内部 while True，永不返回
  → while True: sleep            # 主线程驻留
```
两个顺序都是**踩坑换来的**，改动前务必读 §5.1 和 §5.8：
- `_start_webx_daemons()` 若排在 `Query.run()` 后 → 永不执行（`Query.run()` 不返回）→ 日计数恒 0。
- `Query.check_before_run()` 若排在 `User.run()` 前 → 12306 频控时长时间阻塞主线程 → 账号心跳根本不启动。

---

## 4. ★ 核心约束与扩展手法

### 铁律：不修改原引擎文件

`py12306/` 下的原版文件（除 `webx/` 子目录）**一律不改**。理由是保持可升级、可对照排查。
需要改变引擎行为时，用 **`engine_hooks.py` 里的猴子补丁包装**：

```python
def _hook_something():
    from py12306.user.job import UserJob
    if getattr(UserJob.method, '_webx_wrapped', False):   # 幂等
        return
    original = UserJob.method

    def method(self, *a, **kw):
        try:
            ...我们的逻辑...
        except Exception:
            pass                    # ★ 包装内异常绝不能影响抢票主流程
        return original(self, *a, **kw)

    method._webx_wrapped = True
    method._webx_original = original
    UserJob.method = method
```
约定：标记 `_webx_wrapped` / `_webx_original`；`install()` 幂等；回调内 `try/except` 兜底。

### 当前已装的 9 个钩子（`engine_hooks.install()`）

| 钩子 | 目的 |
|---|---|
| `Request.request` → 挂 `Request.json` | **最关键**：修复 `response.json()` 不返回 `Dict`（§5.2） |
| `Job.do_order` | 余票命中落库 → `hit_log` + `order_log(submitted)` |
| `Order.order_did_success` | 下单成功 → `order_log(success)` + 停用 `[即时]` 任务 |
| `UserJob.save_user` | **空会话落盘守卫**（§5.3） |
| `Query/UserJob.request_device_id(_2)` | 防无界递归（§5.4） |
| `UserJob.qr_login` | 让位给网页扫码，避免死循环占住心跳线程 |
| `UserJob.get_user_info` | 登录态确认改用「能拉到乘客」判定（§5.1） |
| `UserJob.get_user_passengers` | 顾客原始字段 + 防递归 |
| `UserJob.can_access_passengers` | 就绪探针走 webx 策略 |

---

## 5. 踩坑档案（★ 改代码前必读）

> 这些都是**实测确认**过的根因，不是猜测。每条都写了「症状 → 根因 → 修法」。
> 遇到相似症状先来这里对号入座，能省掉几小时。

### 5.1 账号一直显示「离线」（6 个独立成因，全部已修）

**症状**：扫码登录成功、看到真实用户名，但状态永远「离线 · 待恢复」，乘客数永远 0，日志刷
「用户状态已过期，正在重新登录」。

按重要性排序，**每个都要修**：

| # | 根因 | 修法 |
|---|---|---|
| **A** | **`response.json()` 返回普通 `dict` 而非 `py12306.app.Dict`**（见 §5.2） | `_hook_response_json()` |
| B | `account.user_name` 落的是 **key 占位**（不是真实名），而 cookie 存成 `<真实名>.cookie` → 引擎找不到 | `_post_login_finalize` 落库真实名；`_acc_name()` 把 `user_name == key` 视为未知 |
| C | `User` 单例**提前实例化** → `user_accounts` 固化成空列表 | `publish_accounts` 里显式 `User().user_accounts = new` |
| D | `User.refresh_users` 遇到 old 有、`users` 没有的 key 时直接 `.init_data()` → `NoneType` 崩溃 → **整批刷不进去** | `_live_accounts(old)` 只传「users 里确实存在的」 |
| E | `users` 只增不减，`get_user()` 返回**第一个**匹配（可能是已 destroy 的死对象）→ `wait_for_ready()` 无限递归 → 下单卡死 | `_prune_dead_users()` 发布前摘掉 `is_alive=False` |
| F | 就绪探针 `UserJob.can_access_passengers()` 打的接口 302；`get_user_info()` 打的接口**已下线** | 见 §5.6 |

### 5.2 ★★★ `response.json()` 不是 `Dict` —— 「离线」的真正根因

**根因**：引擎到处用**点号路径**取值（`result.get('data.is_login')`、`result.get('data.normal_passengers')`），
这要求 `json()` 返回 `py12306.app.Dict`（其 `get` 会把 `'a.b'` 拆两层）。
该能力原本由 `Request._handle_response → expand_class(response, 'json', Request.json)` 提供，
但**在当前 `requests_html` 版本下 `_handle_response` 不生效**：

```
r.json.__qualname__ == 'Response.json'      # 没被替换
hasattr(r, 'old_json') == False
type(r.json()) == <class 'dict'>            # 普通 dict → 点号 key 查不到 → 永远 None
```
→ `check_user_is_login()` 的 `None == 'Y'` 恒 False → 「已过期」死循环 → 账号永远离线。

**修法**：`_hook_response_json()` 包 `Request.request`，响应上若 `'json' not in response.__dict__`
就 `expand_class(response, 'json', Request.json)`。

🔎 **排查窍门**：引擎只要出现「判过期 / 判没乘客」，**第一步先打印 `type(r.json())`**。
不是 `py12306.app.Dict` 就是这个坑。

### 5.3 ⚠️ 空会话落盘会把已登录的 cookie 文件写空（最阴的一个）

`UserJob.save_user()` **无条件** pickle `self.session.cookies` 到 `runtime/user/<user_name>.cookie`。
而引擎里一堆失败路径都会走到它（`check_user_is_login` / `get_user_info` /
`User.refresh_users → init_data()` 把 session 换成**空的新 Request** 之后）
→ 刚登录成功的会话文件被覆盖成空 jar → 账号彻底掉线。
（实测 `卓文颢.cookie` 被反复写成 0 字节 / 0 个 cookie。）

**修法**：hook `UserJob.save_user` —— **空会话绝不落盘**，并把调用点（文件:行）打进日志。
验证：空 session 调 `save_user()` 不覆盖、有 session 时正常写入。

### 5.4 `request_device_id` 无界递归（启动卡顿的真凶）

`API_GET_BROWSER_DEVICE_ID = 'https://12306-rail-id-v2.pjialin.com/'` **已下线**（ConnectTimeout），
而引擎两个实现都是「请求失败 → 递归调用自身」，**没有 base case**：
`if response.status_code != 200: return self.request_device_id()` → 1000 层后
`maximum recursion depth exceeded`，期间不断向 kyfw 发请求**把 IP 打到限流**，
连带让同时进行的 `/otn/login/conf` 取不到 `is_login='Y'` → 账号被判「已过期」。

**修法**：hook 成「配了 rail 缓存才走原实现，否则直接 `return None`」。
（12306 已不校验 `RAIL_DEVICEID`，真实浏览器访问 `leftTicket/init` 也不下发。）

### 5.5 `RAIL_DEVICEID` 是伪线索（别在这上面浪费时间）

- 真实浏览器访问 `kyfw.12306.cn/otn/leftTicket/init` → **不下发** `RAIL_DEVICEID`。
- 第三方签发服务 `12306-rail-id-v2.pjialin.com` → **已挂**（ConnectTimeout）。
- **余票查询不需要它**。
- 它唯一真实的危害就是 §5.4 的无限递归。

### 5.6 当代 12306 端点实测结论（务必记住）

| 调用 | 实测结果 |
|---|---|
| `GET /otn/login/conf` | 200，`data.is_login = 'Y'/'N'` ✅ 可用 |
| `POST /otn/confirmPassenger/getPassengerDTOs` | 302 → `/otn/safeguard/init` ❌ |
| `POST /otn/confirmPassenger/initDc` | 302 → **登录页** ❌ **会清掉 otn 会话！** |
| `POST /otn/passengers/query` | 200 → `data.datas` 乘客数组 ✅ **唯一可用** |
| `POST /otn/modifyUser/initQueryUserInfoApi`（`API_USER_INFO`） | **已下线**（跳错误页）❌ |

⚠️ **千万不要调 `initDc` / `/otn/login/userLogin` / `/otn/index/initMy12306`**：
它们 302 到登录页，拿着浏览器 cookie 去调反而会把 otn 会话清掉，
导致随后的 `passengers/query` 前几次返回空（**实测踩过**）。

`fetch_passengers` 因此收敛为：**只用 `/otn/passengers/query`**，`getPassengerDTOs` 仅作兜底。

### 5.7 ⚠️⚠️ 乘客数据必须存「原始」12306 字段，不能归一化

`UserJob.get_passengers_by_members(members)` 是按**原始字段名**取值的：
```python
passenger = array_dict_find_by_key_value(self.passengers, 'passenger_name', member)
new_member = {'name': passenger.get('passenger_name'),
              'type': passenger.get('passenger_type'),
              'enc_str': passenger.get('allEncStr'), ...}   # ← 这是**输出**结构，不是输入！
```
所以 `self.passengers` 必须保持 12306 `normal_passengers` **原样**。
一旦先归一化成 `{name,type,id_card,enc_str}`，引擎就找不到乘客 → 日志
「乘客信息校验失败，在账号 X 中未找到该乘客: Y」→ `check_passengers()` 调 `destroy()`
→ **任务刚建好就「已结束」**。

归一化**只用于 web 界面**（`routes_accounts._normalize_passengers` 自己做）。

### 5.8 `_start_webx_daemons()` 必须在 `Query.run()` 之前

`Query.run()` 内部是 `while True`（`Job.run()` 各自死循环）**永不返回**。
放在它后面 → 线程从未启动 → `daily_query` 表 0 行 → 总览「今日查询次数」恒为 0
（而「累计」由 `QueryLog().data.query_count` 实时读，一直在涨）→ 看起来像计数器坏了，**实际是空表**。
🔎 排查手法：`SELECT * FROM daily_query` —— 空表就是守护没起。

### 5.9 日志会整段重复（原版日志层的线程不安全，非我们的 bug）

`py12306/log/base.py`：
```python
class BaseLog:
    quick_log = []                      # 类级共享 list，无锁
    @classmethod
    def add_quick_log(cls, c): cls().quick_log.append(c)
    @classmethod
    def flush(cls, ...):
        logs = cls().get_logs()         # 拿到的就是那个共享 list
        print(*logs, ..., file=file)
        cls().empty_logs(logs)          # self.quick_log = [] → 写在临时实例上，
                                        #   退化成实例属性，没清掉类级 list
```
两个线程紧邻着并发 `add_quick_log(...).flush()` → 两边各写一遍同一份缓冲 → **日志整段重复**。

**修法（不改原文件）**：需要打日志的守护线程，把日志改到**主线程**打。
🔎 排查窍门：**只有某个线程打的日志重复、主线程日志正常** → 就是这个问题。

### 5.10 账号行会重复 / 删行会误删共用 cookie

- 账号行在「点生成二维码」时就先建了（此时还不知道用户名）→ 同一账号点两次「添加账号」就有两行
  → 两个 `UserJob` 抢同一个 cookie 文件 → 双双离线。
  修：`_dedupe_by_name(key, real_name)` 登录成功时摘掉同名重复行（用 `db.account_delete`，
  **不走 `_clear_cookie`**，否则会删掉幸存者赖以工作的 `<real_name>.cookie`）。
- `_clear_cookie` 改为**共享感知**：若还有其它行共用同一 `user_name`，只删 `<key>.cookie`。
  （踩过：删掉重复行把还在用的账号一起踢下线。）

### 5.11 `seat_tiers` 有三种数据形态

`_job_view.seat_tiers` 曾是「有列就用、没列回落成 `json.loads(seats)`」—— 后者是**一维**
（`["二等座"]`），而前端按**二维**处理 → `list.forEach is not a function`（点「编辑」直接报错）。
根本原因是 `create_job` **从来没把 `seat_tiers` 写进库**（一直 NULL）。

**修法（三处一起改，缺一不可）**：
- `routes_jobs_write.create_job` 落库**二维** `seat_tiers`（非法/为空则回落 `[seats]`）。
- `routes_jobs._seat_tiers()` **统一归一成二维**（兼容 NULL / 一维 / 二维）。
- 前端 `applyJobToForm` / `loadDetail` / `updateNtSummary` 三处都加 `Array.isArray` 防御。

### 5.12 「重新扫码」按钮点了没反应

`accAction` 的 `rescan` 分支成功后只调 `openQrPanel(key)` —— 它只切标签 / 设 `QR.key`，**不出二维码**。
改成成功后直接 `runQrSession(key)` 立即出码。
（这也是账号行重复的诱因：用户改点「生成登录二维码」。）

### 5.13 12306 余票字段的**三种**含义（不能压成两种）

| 原始值 | 含义 | 我们显示 |
|---|---|---|
| `''` / `'N'` | **该车不设此席别** | `/`（灰、不可点、无票价） |
| `'无'` | 有该席别但当前无票 | `无` + 票价估算（**可选中**） |
| `'有'` / 数字 | 有票 | 有 / 数字 + 票价 |

后端 `routes_tickets` 写 `seat_map[key] = '/' if raw in ('', 'N') else raw`。
前端两个判据（`main.js`）：
```js
seatOffered(leg,k)   = v && v !== '/'                            // 是否提供该席别（可参与等待）
seatHasTicket(v)     = v && v !== '/' && v !== '无' && v !== '候补'  // 当前是否真有票
```
判「可售/可点」用 `seatOffered`，判「立即能买」用 `seatHasTicket`。
**不要再用 `v !== '无'` 这种混用判断。**
业务含义：**无票也可选**（任务会持续查询、放票后自动抢）；不设座不可选（等不到）。

### 5.14 `Job.is_trains_number_valid()` 的顺序陷阱

```python
if left_time < self.from_time or left_time > self.to_time: return False      # 先判时间
if self.allow_train_numbers: return self.get_info_of_train_number() in ...   # 再判车次号
```
时段是 **AND 条件且优先级高于车次白名单** → 能**静默否决**已明确要抢的车次。
所以「车次查询」模式一律强制全天时段。

### 5.15 静默失效三连（都是"看着成功、实际没生效"）

1. `sync.job_info_dict()` 曾把 JSON **文本**交给引擎 → `string indices must be integers`。
   必须 `json.loads` 后再给（`_json_list`）。
2. `pickAddToTask()` 只拿**第一行车次**的区间填 `ntPairs`。引擎是
   `for station in stations: for date in left_dates` 发请求，`train_numbers` **只在返回结果里过滤**
   → 跨线路多选时，除首条线路外其余车次永远查不到，界面完全看不出来。
3. `ntTags()` 读 `.t` 的 **textContent**，而标签 DOM 是「车次号 + 删除按钮 ✕」
   → 提交成 `"G79 ✕"`，白名单永远匹配不上。**必须读 `t.dataset.t`**。

### 5.16 原型残留 CSS 的坑（`app.css` 后半）

`app.css` 后半是设计稿「中转方案 / task-pick-mode」的样式，**作用域写得过宽，会静默压掉前面的规则**：

| 规则 | 危害 | 处置 |
|---|---|---|
| `.results-panel.batch-mode .batch-operation{display:none}` | 「批量关联/新建」按钮永久不可见 | 限定 `.task-pick-mode` |
| `.results-panel.batch-mode .row-check{visibility:hidden}` | 开了批量也点不了复选框 | 限定 `.task-pick-mode` |
| `.results-panel .table col:nth-child(2){width:14%!important}` | 盖掉 colgroup 内联宽度 | 删除该规则 |
| `.results-panel th:first-child/td:first-child{display:none}` | **首列（车次）消失** | 删除 |
| `.route-input svg{position:absolute;right:10px;top:10px}` | 让放进 `.route-input` 的按钮内 svg 脱离文档流 → 居中永久失效 | 按钮内 svg 显式 `position:static` |

教训：**改这批表/控件样式前，先确认没有更靠后的同族规则把它覆盖**；
排查时看 `getComputedStyle` 的**计算值**，而非源码顺序。

### 5.17 前端状态与 DOM 的若干陷阱

- **`.selection-bar` 在 `:not(.batch-mode)` 时是 `display:none!important`**（原型 CSS）。
  判断悬浮栏是否可见**不能用 `classList.contains('open')`**，要读 `getComputedStyle(bar).display !== 'none'`。
- **悬浮栏 `position:fixed; bottom:18px` 会盖住列表最后一行**，且到底后无法再滚。
  必须按**栏的实际高度**动态写内联 `paddingBottom = barH + 32`
  （窄屏 `flex-wrap` 换行后高 81px 而非 54px，固定值不够）。
  `offsetHeight` 为 0 表示面板不在当前视图 → 清空内联值让 CSS 兜底。
- **懒初始化的模块级状态别假设已初始化**：`APP.selSeats` 原本只在 `buildNtSeats()` 里创建，
  冷启动直接点「新建任务」会抛 `Cannot read properties of undefined (reading 'indexOf')`。
  已在 `var APP = {...}` 处预置 `selSeats/selDates/paxAll/paxSel/dates/openDates`。
- **"全选/不限"这类互斥复选框组必须基于事件目标判断**（`e.target`），
  不能靠扫描当前勾选状态反推意图 —— 否则会出现「永远切不回去」。
- `go('monitor')` 会 `MON.batch = false`。所以「点座次」在**离开再进入**监控页后会失效
  （`inBatchUI()` 为 false → 不写 `MON.sel`/`selBy`）。测试时注意，否则会误判成逻辑 bug。

---

## 6. 前端（`static/`）协作要点

### 结构
- **无框架、无构建、无模块**：`main.js` 是一个 IIFE，`'use strict'`，内部函数靠提升互相调用。
  全局状态挂在 IIFE 内的 `APP` / `MON` / `DATES` / `QR` / `JOB_INDEX` 等对象上。
- **`app.css`（基础） + `index.html` 内的 `<style>`（webx 补充）** 双层。
  webx 补充块用更高特异性（如 `.view#view-monitor .results-panel ...`）压过 `app.css`。
- 视图切换：`go(view, ctx)` → `.view.is-active` + 导航 `.on` + `viewTitle` 文本，
  并按 view 派发对应的 `loadXxx()`。**新增视图要在这里登记**。

### 关键常量（改这里就够，别散落硬编码）
```js
var MON_SEAT_KEYS = ['business','first','second','hardSleeper','hardSeat','noSeat'];   // 表格 6 列
var PICK_SEAT_KEYS = [...MON_SEAT_KEYS, 'softSleeper','special'];                       // 卡片 8 个
var SEAT_NAME  = { business:'商务座', first:'一等座', second:'二等座', hardSleeper:'硬卧',
                   hardSeat:'硬座', softSleeper:'软卧', special:'特等座', noSeat:'无座' };
var SEAT_ORDER = ['商务座','一等座','二等座','硬卧','软卧','硬座','无座','特等座'];
```

### ⚠️ 席别有两个来源，语义不同（靠 `MON.selBy[i]` 区分）

| 入口 | `selBy` | 语义 |
|---|---|---|
| 勾**复选框** | `'check'` | **默认全部** → 提交时补上表格没列的软卧/特等座 |
| 逐个**点席别** | `'seat'` | **已明确指定** → 只取点的那些，**不补软卧** |

设置点：`selectRow(on)` → `'check'`；座次单元格点击（`inBatchUI()` 内）→ 同车次所有行 `'seat'`；
`applyPickToRows()`（恢复草稿）→ `'seat'`。**清空 `MON.sel/selSeats` 的地方都要一并清 `MON.selBy`**。

`syncDraftFromSelection()` 的三段逻辑（`seatsOfTrain(n, prevSeats, defaultAll)`）：
1. 表格能表达的席别 → 以表格勾选为准
2. 表格表达不了的 + **该车已在草稿里** → 沿用卡片状态（用户可能特意取消了）
3. 表格表达不了的 + **新加入的车次** → 只有 `defaultAll`（复选框入口）才补

⚠️ `#mFloatAddTask` 的 handler **只调 `commitPick()`，不调 `pickAddToTask()`**，
所以「默认纳入非表格席别」的逻辑必须放在 `seatsOfTrain` 里，光放在 `pickAddToTask` 不够。

### 双模式新建任务页（车次查询 / 区间查询）
- `#taskFlow` 加 `.mode-train` / `.mode-range`，CSS `[data-zone="range"|"train"]{display:none}` 控显隐。
- 由顶部「查询方式」**手动切换**（`APP.ntMode`），不再由「有没有已选车次」推断。
- 车次模式下「区间 / 时段 / 车次范围」全部由已选车次**推导且只读** —— 用户随手改任一项
  都可能把刚导入的车次静默排除（见 §5.14）。

### 席别优先级配色
**一个颜色 = 一个优先级**（同色即同级）。调色板 8 色（`--red/--info/--warn/--ok/--pri5..--pri8`），
取 `ti % 8 + 1`。摘要、推导行、详情页三处都按此渲染，**不带序号**（顺序由芯片排列表达）。

---

## 7. 数据与运行时状态

### `runtime/` 内容（都是运行时数据，**不要手删**）
| 路径 | 说明 |
|---|---|
| `webx.db` + `-wal` + `-shm` | **唯一数据源**（SQLite WAL） |
| `webx.json` | webx 全部设置（含密钥，chmod 600） |
| `webx.log` | 引擎 + 管理台的有意义日志（无轮转） |
| `console.log` | 仅 `pythonw` 模式下产生（werkzeug 输出兜底） |
| `user/<名>.cookie` | 12306 会话（pickle 的 `RequestsCookieJar`），**引擎靠它恢复登录** |
| `user/<名>_passengers.json` | 乘客缓存（原始 12306 字段） |
| `query/status.json` | 原版引擎的查询进度 |
| `.webx_env` | 空 stub，喂给原版 `Config.CONFIG_FILE` |

### 数据库表
```
job           抢票任务（含 seat_tiers 二维优先级、start_at、interval_min/max、is_active）
account       12306 账号（key / user_name / password / type / login_ok / active）
user_login    管理台账号（pbkdf2(salt, hash)，无明文）
order_log     下单记录（queued → submitted → success / cancelled）
hit_log       余票命中记录
daily_query   按天查询次数（由守护线程每 30s 轮询 QueryLog 差值累加）
kv            杂项（JWT secret 等）
```

### ⚠️ DB 迁移的坑
`db.py` 的幂等迁移（加列）**必须用 `cur.execute('PRAGMA table_info(...)')`，不能用 `self.query()`** ——
`query()` 会去抢同一把 `threading.Lock`，而 `_init_schema()` 已持有它 → **死锁**。

### 账号表字段含义
- `user_name`：**真实 12306 用户名**。若等于 `key` 说明还是「未知占位」（`_acc_name()` 会这么判定）。
- `login_ok` / `active`：扫码成功前不发布给引擎（防与 `UserJob` 心跳并发抢登录）。

---

## 8. 常见任务手册

### 8.1 加一个 REST 接口
1. 在 `py12306/webx/server/` 现有蓝图里加，或新建 `routes_xxx.py`。
2. **在 `server/app.py` 里注册蓝图**。
3. 鉴权是 `before_request` 白名单制（`PUBLIC_PATHS = {'/api/auth/login','/api/auth/me','/api/boot'}`），
   新接口默认**需要** JWT。
4. 返回统一格式 `{'code': 0, 'msg': '', 'data': {...}}`；错误用 `code: 1` + HTTP 状态码。
5. **写操作**记得调 `ConfigSync.publish_*()`（否则"保存了但不生效"）。

### 8.2 改引擎行为
读 §4 —— 写在 `engine_hooks.py`，包装 + 幂等 + `try/except`，**不要碰原文件**。

### 8.3 改前端
- 只改 `static/` 下三个文件，改完刷新页面（无构建）。
- 新增视图：`index.html` 加 `<section class="view" id="view-xxx">` + 导航 `<a data-view="xxx">`，
  `main.js` 的 `TITLES` / `go()` 里登记。
- 改表格/控件样式前，先读 §5.16（原型残留 CSS 会静默覆盖）。

### 8.4 排查一个"没生效"的问题
按这个顺序，能覆盖本项目 90% 的坑：
1. **先确认没有两个实例**（§1）→ 再看 `runtime/webx.log` 尾部。
2. 若是**引擎侧判过期/判没数据** → 打印 `type(r.json())`（§5.2）。
3. 若是**"保存了但没生效"** → 检查是否调了 `ConfigSync.publish_*()`。
4. 若是**前端"看着成功没生效"** → 读 §5.15 静默失效三连 + §5.16 CSS 覆盖。
5. 若是**计数器/统计恒为 0** → 直接查对应的 DB 表（空表 = 写入方没跑）。

### 8.5 验证改动（不依赖浏览器）
```python
import sys; sys.argv = ['main_web.py', '-t']
import main_web as M; M._ensure_env_stub()
from py12306.webx.sync import ConfigSync; ConfigSync.startup()
from py12306.webx.server.app import create_app
c = create_app().test_client()          # 然后 c.get('/api/xxx')
```

---

## 9. 调试工具与技巧

### 9.1 浏览器自动化（Playwright）的坑 ★
本会话大量使用，**页面 `hidden` 时有两个必踩的坑**：
- `waitForFunction` 默认用 **rAF 轮询**，标签页 hidden 时 rAF **完全暂停** → 条件已满足也永不返回。
  **必须传 `{polling: 250}`**。
- `page.click()` 会等元素 "stable"（连续两帧 rAF 比对位置）→ hidden 页面上**必然超时**。
  改用 `page.evaluate(() => el.click())` 触发 DOM click，绕开可操作性检查。
- `page.screenshot()` 在 hidden 页面上可能返回**空白图** → **别依赖截图**，
  用 `getBoundingClientRect` + `getComputedStyle` 度量作为证据。
- `page.evaluate` 只接受**一个**参数；IIFE 内的 `const`/`var` 不在 `window` 上，取不到内部状态
  （`APP`/`MON` 都在闭包里）→ **只能靠 DOM 观察**。

### 9.2 临时脚本约定
- 命名 `_xxx.py` / `_xxx.out`（下划线开头，便于一眼识别 + 批量清理）。
- **收尾必须删干净**（用户会检查；`_*.out` 还会残留在编辑器标签里）。
- 输出中文到终端容易乱码 → **写进 `.out` 文件再用读文件工具看**，更可靠。
- 一次性清理（**PowerShell 最稳，cmd 里引号容易被吃**）：
  ```powershell
  Remove-Item -Force '_a.out','_b.py' -ErrorAction SilentlyContinue
  Get-ChildItem -Recurse -Force -Directory -Filter '__pycache__' | Remove-Item -Recurse -Force
  ```
- ⚠️ **别删用户数据**：`runtime/*` 全部是运行时数据；DB 里的 `job` 行也可能是用户自己建的
  （曾误以为某任务是垃圾，实际是用户刚创建的）→ **删任何数据前先确认来源**。

### 9.3 终端工具会"哑火"
本会话多次遇到终端命令**返回空输出**（并非命令失败）。此时：
- 改用「创建并运行任务」的方式执行，或
- 让脚本把结果写进文件，再用读文件工具读取。

---

## 10. 已知限制 / 待办

| 项 | 状态 |
|---|---|
| **任务级「开始时间」「查询间隔」** | 已落库（`job.start_at` / `interval_min/max`）+ UI 已标注「待引擎支持」，但**引擎侧尚未消费**。需要：`sync.job_info_dict()` 加 `interval`/`start_at` 键 → 会改变 `Job.id`（md5 of info dict）→ **一次性任务重建**；`Job.update_interval()` 优先用任务级间隔；调度层支持 `start_at`。 |
| **候补购票** | 引擎不支持（`Job.is_has_ticket` 要求 `order_text == '预订'`），接口不提供 waiting 模式。 |
| **中转方案** | `routes_tickets` 只返回直达。 |
| **票价估算** | 按「历时 × 单价」估算，**长距离明显偏低**（如 G1025 二等座约 ¥554 vs 实际约 ¥1050）。仅参考。 |
| **监控表格只 6 个席别列** | 后端已返回 `softSleeper`/`special`，表格未展示（这也是 §6 里 `MON.selBy` 那套语义存在的原因）。 |
| **`requirements.txt`** | 已失效，未重写。 |
| **`webx.log` 无轮转** | 账号离线时引擎每 3s 刷一行，会持续增长（目前 100KB 量级，暂时无害）。 |
| **12306 每日维护窗口 1:00–5:00** | `app_available_check()` 会 `sleep` 到 5:00（**日志文案写"6 点"，代码实际是 5 点**）。凌晨调试时任务"看起来没跑"，**不是 bug**。 |
| **账号掉线时日志刷屏** | `UserJob.wait_for_ready()` 无限递归每 3s 刷「账号正在登录中，3 秒后自动重试」。属引擎既有行为，重新扫码即停。 |

---

## 11. 变更清单（相对原始 py12306）

> 当前分支 `dev`，基线提交 `e3e7fe0 feat: 新增webx管理网页端`（webx 骨架已在该提交里）。
> 下面的「新增 / 修改」是**相对该基线**的。

**本会话新增的文件**
```
py12306/webx/engine_hooks.py         ★ 引擎包装（9 个钩子）—— 整个"不碰原文件"扩展方案的核心
py12306/webx/presale.py              预售期唯一事实来源（原来 3 处各自硬编码 32 天）
py12306/webx/server/routes_orders.py 下单链路 REST（GET/POST /api/orders，取消）
AGENTS.md                            本文档
```

**本会话修改的文件**
```
main_web.py                          启动顺序（User.run 前移、守护前移）、_ensure_streams、装钩子
py12306/webx/config_store.py
py12306/webx/db.py
py12306/webx/sync.py                 publish_accounts（单例同步 + _live_accounts + _prune_dead_users）
py12306/webx/webx12306.py            fetch_passengers 收敛、_post_login_finalize、_acc_name
py12306/webx/server/app.py
py12306/webx/server/routes_accounts.py
py12306/webx/server/routes_accounts_write.py   _do_login_success / _clear_cookie / _dedupe_by_name
py12306/webx/server/routes_jobs.py             _seat_tiers 归一化
py12306/webx/server/routes_jobs_write.py       seat_tiers 落库 / PATCH 收 name+start_at
py12306/webx/server/routes_tickets.py
py12306/webx/static/index.html
py12306/webx/static/main.js
py12306/webx/static/app.css
```

**原版 py12306 文件：未改动（零个）**
`py12306/app.py`、`config.py`、`user/*`、`query/*`、`order/*`、`helpers/*`、`log/*`、`cluster/*`、
`vender/*` 以及 `main.py` 全部保持原样。所有扩展都通过 §4 的包装方式介入。

> ⚠️ 涉及二进制/pickle 的运行时数据（`runtime/*`）**不入版本库**，见 `runtime/.gitignore`。

---

## 12. 给下一个 agent 的建议

1. **先读 §5 踩坑档案**，再动手。这里面每一条都是花了几小时定位的，重复踩一遍很浪费。
2. **改前先跑健康检查 + 看日志尾部**，确认当前状态是干净的（没有双实例、没有残留任务）。
3. **验证要有证据**：本项目多次出现"看起来修好了、其实没有"的情况
   （静默失效三连、日志重复、空会话落盘…）。用**实测数据**（真实 API 响应、computed style、
   DB 查询结果）而不是"应该可以了"来下结论。
4. **区分「代码错」和「状态脏」**：同一个 bug 修好后仍复现，先怀疑现场数据被污染
   （cookie 被写空、双实例、DB 里的脏行）。
5. **兜底之前先找根因**：曾给引擎加"乘客拿不到就按就绪处理"的兜底，
   而真正的根因是 `response.json()` 返回类型不对（§5.2）；找到后兜底就变得可有可无。
6. **改共享资源前先问"还有谁在用"**：`_clear_cookie` 删文件那次，把一个还在用的账号一起踢下线了。
