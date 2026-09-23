# AGENTS.md — py12306 / webx 二次开发协作指南

> 面向**任何 AI agent 或新加入的开发者**的项目交接文档。
> 读这一份就能上手：改了哪些东西、为什么这么改、哪些坑踩过、怎么验证。
>
> 最后更新：2026-09-17 · Python 3.12.14 · Flask 3.1.3

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
# 启动（完整后台：Cdn / User / Query + 管理台）
D:\Anaconda\envs\12306\python.exe main_web.py

# 仅起管理台、不跑抢票任务（测试用）
D:\Anaconda\envs\12306\python.exe main_web.py -t

# 健康检查（不依赖浏览器）
curl -s -m 8 -o nul -w "%{http_code}" http://127.0.0.1:8600/api/boot   # 期望 200
```

停止：按端口找 PID 后 `taskkill /PID <pid> /F`（**别用进程名盲杀**，`python.exe` 里可能混着
编辑器/语言服务的进程，见下）。重启后务必确认没有两个实例并存。

> `main_web.py` 的 `_ensure_streams()` 是给「无控制台解释器」（如 `pythonw.exe`，此时
> `sys.stdout/stderr` 为 `None`）准备的兜底：werkzeug / click / 原版 `print` 都会写这两个流，
> 为 `None` 时会抛异常。该函数把为 `None` 的流重定向到 `runtime/console.log`
> （**刻意不写进 `webx.log`**，否则每秒轮询的访问日志会淹没引擎日志）。用 `python.exe`
> 启动时不触发，属安全网。

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
# 4) 核对没有多余实例（python.exe 里可能混着编辑器/语言服务，别按名字盲杀）
Get-Process python*,pythonw* -ErrorAction SilentlyContinue |
  Select-Object Id, ProcessName, StartTime
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
      ├ sync.py                webx(db/json) → 原版 Config 的桥接      ├─ stations.py            ★ 站名解析（本地表 ∪ 12306 官方表；同城站前缀展开）
      ├ task_catalog.py         任务创建/更新时预取车次与经停站，详情页只读缓存
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

### 当前已装的 16 个钩子（`engine_hooks.install()`）

| 钩子 | 目的 |
|---|---|
| `Request.request` → 挂 `Request.json` | **最关键**：修复 `response.json()` 不返回 `Dict`（§5.2） |
| `Job.do_order` | 余票命中落库 + 按账号串行下单、失败退避 |
| `Order.order_did_success` | 下单成功 → `order_log(success)` + 停用 `[即时]` 任务 |
| `UserJob.save_user` | **空会话落盘守卫**（§5.3） |
| `Query/UserJob.request_device_id(_2)` | 防无界递归（§5.4） |
| `UserJob.qr_login` | 让位给网页扫码，避免死循环占住心跳线程 |
| `UserJob.get_user_info` | 登录态确认改用「能拉到乘客」判定（§5.1） |
| `UserJob.get_user_passengers` | 顾客原始字段 + 防递归 |
| `UserJob.can_access_passengers` | 就绪探针走 webx 策略 |
| `Query.start/update_query_jobs` | 零任务启动后，启用任务自动重启查询循环 |
| `Job.query_by_date` | 按任务统计「已查询」次数 |
| `Job.destroy` | 结束状态 + 原因落库 |
| `Job.init_data` | 把 webx 自有任务字段（`webx_station_mode`）挂到实例上（§5.25） |
| `Job.is_trains_number_valid` | ★ **只抢指定车站**：修 12306 同城站扩展导致的错站下单（§5.25） |
| `is_main_thread`（多模块同名全局） | ★ 查询循环线程的日志落盘（§5.26） |
| `UserJob.wait_for_ready` | ★ 账号等待限频 + 自愈（§5.27） |
| `User.get_passenger_for_members` | ★ 跳过僵尸账号对象（§5.27） |
| `Request/UserJob/Order` 下单状态机 | 诚实阶段日志、initDc 保护、防重和失败落库（§5.18） |
| `QueryLog.print_job_start` | 查询开始日志使用该 Job 的 `query_count`，不再显示进程全局序号 |

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
（实测：该账号的 cookie 文件被反复写成 0 字节 / 0 个 cookie。）

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
| `'无'` | 有该席别但当前无票 | `无` + 真实票价（**可选中**） |
| `'有'` / 数字 | 有票 | 有 / 数字 + 真实票价 |

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

### 5.18 「下单请求已受理」不等于生成订单

原版 `submitOrderRequest` 只要返回 `data='0'` 就打「提交订单成功」，但后面仍需
`initDc 令牌 → checkOrderInfo → getQueueCount → confirmSingleForQueue → 订单号`。
旧实现在 `initDc` 302/缺 token 时静默返回，导致日志看似成功、App 却无订单，
并且每轮查询都重复提交。

当前修法在 `engine_hooks._hook_order_flow_guard()`：
- 仍使用原生 `requests_html` 会话，为下单端点补齐 Referer / Origin / Accept。
- `initDc` 禁止自动跟随 302，防止跳登录页损坏会话；失败明确打状态/跳转目标。
- 按当前协议处理 `ticketInfoForPassengerForm`；`getQueueCount.data.ticket` 是下一步
  `leftTicketStr` 凭据，**不是余票数量**，不得拆逗号后判无票。
- 无座编码：G/D/C 使用 `O`，普速使用 `1`；排队日期使用「中国标准时间」格式。
- 同账号下单串行化；失败退避 30s，退避日志限频。
- `order_log` 状态为 `queued → submitted → success/failed/unknown`；**只有取得订单号才算 success**。
- ⚠️ **「服务端明确拒单」≠「状态不明」，不能一概停任务**（本节最容易踩的坑）。
  `confirmSingleForQueue` 成功后若拿不到订单号，服务端**可能已占座** → 必须停任务防重复下单，
  标记 `unknown` 并让人去 12306 官方订单页核对。
  但如果排队轮询**明确返回了拒单原因**（实测：「没有足够的票!」「排队人数现已超过余票数」，
  以及 `waitTime = -2/-3` 失败/已撤销、`messages` 字段），说明 12306 **一张票都没出** ——
  这时候停任务是大错：用户看到「排队失败」下一秒就是「任务已结束」，再也不查询了。
  - 实现：`Order.query_order_wait_time` 被复刻包装，把结论写进 `self._webx_wait_outcome`：
    `'ordered'`（拿到订单号）/ `'rejected'`（明确拒单，未成单）/ `'unknown'`（超时或异常）。
  - 判定集中在 `engine_hooks._must_stop_job(order)`：
    仅当「已 `_webx_queue_confirmed`」**且**「outcome ≠ rejected」才停任务。
  - `rejected` 时：`order_log` 记 `failed` + 原因，写一条 `job_event`，按账号退避 30s，
    **任务保持运行继续下一轮查询下单**。
  - ⚠️ **退避必须覆盖所有「未成单」路径**。`confirmSingleForQueue` 返回 False
    （日志「出票失败，错误原因 排队人数现已超过余票数…」）这条路径原本**没人调
    `_order_flow_fail`** → 完全没有退避。实测（查询间隔 1s、余票一直挂着）会变成
    **每 1~2 秒**打一遍 `submitOrderRequest → initDc → confirmSingleForQueue`，
    直接触发 12306 的「由于您取消次数过多，今日将不能继续受理您的订票请求」。
    现在 `normal_order` 的「不停任务」分支统一调 `_order_flow_fail` + 记 `failed`。
  - 该阶段的日志原文**不带任务名**（`MESSAGE_QUERY_ORDER_WAIT_TIME_INFO/FAIL`），
    而详情页日志是按任务名子串过滤的 → 「第 N 次排队」「排队失败，错误原因 …」在任务详情里
    **根本看不到**。包装里已补 `_jn()` 前缀。
- **不引入 Playwright / 无头浏览器等额外依赖**：协议修正后的原 `requests_html` 会话是唯一下单主路径。

### 5.19 服务以 0 个任务启动后，新建任务不查询

`Query.start()` 在 `self.jobs` 为空时会直接 `break` 返回（单线程模式）。
服务启动时没有任务 → 循环退出；之后网页新建任务只调 `Query.update_query_jobs()`，
又因为 `QUERY_JOB_THREAD_ENABLED = 0` 不会建线程 → **新 Job 进了内存但永远不发查询**。

修法：`engine_hooks._hook_query_loop()` 同时包装 `Query.start` / `update_query_jobs`
——用锁与运行标记保证同一时刻只有一个查询循环；任务变更后若存在可运行 Job
且循环已退出，则以 daemon 线程重启 `start()`；刷新前先摘掉已 `destroy` 的 Job，
使「暂停后再启用」能重建实例。

### 5.20 ★ 任务只能用 `Job.id` 定位，不能用 `job_name`

**症状**：两个同名任务（用户很容易建两个「广州南→马踏·2026/10/01」）时
「显示已暂停，后台还在运行」、命中/查询次数记到错的任务上、结束原因写错行。

**根因**：`Job.id = md5(job_info_dict)`，而 `job_info_dict` 原来**没有任何唯一字段** →
  - 配置完全相同的两个任务会算出**同一个 md5** → `Query.refresh_jobs()` 按 id 匹配，
    第二行复用第一行的 Job 实例（其中一个永不运行）；暂停其中一个时另一个仍在
    `QUERY_JOBS` → 引擎继续查询那个「已暂停」的任务。
  - webx 侧一律用 `db.job_id_by_name()` 反查任务行 →
    同名任务全部落到「最新那一行」（`ORDER BY id DESC LIMIT 1`）→
    命中/查询/事件/结束状态**全记到错的任务上**。

**修法**（两处必须一起改）：
1. `sync.job_info_dict()` 加 `'webx_id': job_id` → 每行的 `Job.id` 唯一。
   （副作用：既有任务 id 变化 → 引擎一次性重建，无害。）
2. `sync.ConfigSync.engine_job_index()` 提供 `{Job.id: db job_id}`；
   `engine_hooks._job_id_for(job)` / `routes_jobs._job_alive()` 改用它。
   **所有落库点都传 Job 实例**（`_record_hit` / `_record_success` / `_record_job_finished` /
   `_order_attempt_update` / `_hook_query_count` / `_evjob`），不再传 job_name。
   `job_id_by_name()` 只作为「拿不到 Job.id」时的兜底。
3. `routes_jobs._engine_jobs()` 改为 `{Job.id: is_alive}`（原来按 job_name，
   同名任务共享同一个存活状态），并在 `_job_view` 暴露 `engine_alive` 便于核对。

**自愈兜底**：`main_web._reconcile_paused_jobs()`（挂在 30s 守护里）——
若有「引擎里存活、但 db 已不是 active」的任务就重新 `publish_jobs()` 摘掉并记日志。
对付「暂停时引擎正卡在长耗时下单/排队链路（`query_order_wait_time` 最长 60s×3s sleep），
`is_alive=False` 要等该链路返回才被循环检查到」。

### 5.21 账号登录后要立刻显示「已登录」

**症状**：扫码/密码登录成功，界面仍显示「离线」，要过一会儿（最长 2 分钟）才翻过来。

**根因**：界面「在线」取自引擎 `UserJob.is_ready`，而它只在
`check_heartbeat() → user_did_load()` 里被置 True。但 `check_heartbeat()` 开头有短路：

```python
if self.get_last_heartbeat() and (time_int() - self.get_last_heartbeat()) < Config().USER_HEARTBEAT_INTERVAL:
    return True          # ← 连 check_user_is_login() 都不调，更不会置 is_ready
```

`USER_HEARTBEAT_INTERVAL` 默认 **120 秒**（实测确认：故意把心跳设新 → `calls=[]`、
`is_ready` 仍为 False）。重新登录后上次心跳可能还在窗口内 → 界面「离线」最长 2 分钟。

**修法**：
- `routes_accounts_write._force_engine_ready(key)`：清心跳时间戳（解除短路）+
  让引擎读一次刚落盘的 cookie（`load_user() → did_loaded_user() → user_did_load()`
  → `is_ready=True`）。`_do_login_success()` 里在 `publish_accounts()` 之后调用。
  实测：`is_ready` 立即变 True。
- `routes_accounts.accounts_list()`：引擎里**还没有该账号对象**时（全新账号刚扫码、尚未发布到引擎）
  用 db 的 `login_ok && active` 兜底。⚠️ **只在引擎没有该对象时兜底** ——
  引擎有对象且 `is_ready=False` 说明会话真的失效，不能谎报在线（否则掉线被静默掩盖）。
- 前端 `checkQr()` 在 `state=success` 时已经立即调 `loadAccounts()`，无需改动。

### 5.22 经停站与票价

车次列表点**车次号**会打开「经停站」弹窗（`GET /api/tickets/stops`）。接口实测结论（2026-09）：

| 接口 | 结果 |
|---|---|
| `GET /otn/queryTrainInfo/query?leftTicketDTO.train_no=..&leftTicketDTO.train_date=..&rand_code=` | ✅ 200 JSON，`data.data[]` 含 station_name / station_no / arrive_time / start_time / arrive_day_str / arrive_day_diff / running_time |
| `GET /otn/cndata/queryByTrainNo?...` | ❌ 返回 **HTML 错误页**（`Content-Type: text/html`） |
| `GET /lcquery/queryTrainStopTime?...` | ❌ 返回 `{"status":true,"data":"","errorMsg":"url error"}` |
| `GET /otn/leftTicket/queryTicketPrice?...&to_station_no=..` | ❌ **只返回 `train_no`，没有任何价格**（补 Referer / X-Requested-With / 各种 seat_types 都试过） |
| `GET /otn/leftTicketPrice/query?leftTicketDTO.train_no=..&from_station=..&to_station=..&train_date=..&rand_code=` | ✅ **真实票价**（本条即 `PRICE_URL`） |
| `GET /otn/leftTicketPrice/queryAllPublicPrice` | ❌ 405，**没有批量接口**，只能逐车次查 |

- ⚠️ **`train_no` 不是车次号**：车次号是 `t[3]`（`Z8006`），`train_no` 是 `t[2]`（`65000Z80060Y`）。
  停靠站与票价接口都只认后者。`/api/tickets` 的每行因此新增 `no` / `from_no` / `to_no` /
  `seat_types` / `f_code` / `to_code`（`t[2]` / `t[16]` / `t[17]` / `t[15]` / `t[6]` / `t[7]`）。

#### ★ 真实票价：已彻底取代「历时 × 单价」估算

**为什么必须换**：估算按**历时**，而真实票价按**里程** —— 同样 1 分钟，跑 200km/h 的
深茂铁路比跑 350km/h 的京沪高铁走得短得多，于是估算在两个方向上都会错很多：

| 车次 | 区间 | 历时 | 旧估算 | 12306 真实 | 误差 |
|---|---|---|---|---|---|
| G531 | 北京南→上海虹桥 | 5:56 | ¥292 | **¥661** | 低 56% |
| G5148 | 深圳→马踏 | 2:35 | ¥127 | **¥278** | 低 54% |
| G5148 | 深圳→茂名南 | 2:50 | ¥139 | **¥308** | 低 55% |
| Z8006 | 深圳东→三亚 | 19:08 | ¥241 | **¥267.5** | 低 10% |

（正是用户报的「G5148 票价和 12306 不一致、低了一半」的根因。）

- 前端 `priceOf(leg, k)` 返回 `数字 | null`，**永不估算**；拿不到就显示 `—`。
  旧函数 `seatPrice` / `isHighSpeed` / `HIGH_SPEED_TYPES` 已删除，不要再加回来。
- 接口 `GET /api/tickets/prices?date=&items=train_no:from:to|...`（最多 150 项）→
  `{ "train_no:from:to": {seat_key: 元} }`。前端 `MON.prices` + `loadPrices()`（差量拉取，
  已缓存的 key 不重复请求）+ `paintPrices()`（**原地**改 `td.seat` 里的 `small.seat-price`，
  不重建整表，避免打断勾选状态）。
- 服务端 `_PRICE_CACHE`（TTL 6h，4 线程并发）；**只缓存非空结果** —— 空结果可能是临时失败。
- 价格字段是**「角」的字符串**，需 `/10`：`'02780'` → `278.0`；`'--'` → 该席别不适用（不展示）。
- 请求必须带 `Referer: <init 页>?linktypeid=dc&date=<日期>&flag=N,N,Y` + `X-Requested-With`，
  否则 302 / 空数据。单次约 **125ms**。

⚠️ **必须用「行自己的」电报码**（`t[6]`/`t[7]`），**不能用查询时输入站的电报码**。
踩过：用查询站（深圳北=IOQ）去查 G5148 拿到 `{"status":true,"data":[]}`，一度误判
「接口已下线」。实际是 12306 做了**同城站扩展** —— 行的实际站是 深圳=SZQ，接口只认行自己的站码。
（站码写错**不报错**，只返回空数组 —— 这就是它容易被误判成「接口挂了」的原因。）

#### ★ 站名 → 电报码：三级兜底（`routes_tickets._to_code()`）

「在经停站里改成中间站」之后，行里原有的电报码已不再描述这对站，我们**只剩站名**。
而本地 `data/stations.txt` **不含新开站**（实测「湛江北」「茂名南」都查不到）→ 必须兜底：

1. 本地站点表 `Station.get_station_key_by_name()`（快，但缺新站）；
2. 余票响应的 `data.map`（电报码→站名）—— 每次查询累积进 `_STATION_CODES`，**免费**，
   但只含**本次查询涉及的站**（实测 深圳北→茂名 的 map 里「茂名南」有、「湛江北」没有）；
3. **12306 官方站名表** `https://kyfw.12306.cn/otn/resources/js/framework/station_name.js`
   —— 3385 站、**含全部新站**，用 `station_names\s*=\s*'(.*?)'` 抠出 `@` 分隔的
   `拼音|站名|电报码|...`。懒加载（只在前面都解析不出来时才请求）+ 落盘缓存
   `runtime/station_codes.json`（TTL 7 天，失败 300s 后重试）。

实测：接入后「深圳→湛江北」从 `—` 变为 商务座 ¥1240 / 一等座 ¥561 / 二等座 ¥366 / 无座 ¥366，
与直接打接口一致。

- **经停站弹窗不展示价格**（`/api/tickets/stops` 不返回 `price`/`seat`/`high_speed`）：
  票价的正确性依赖「行自己的站码 + 可售区间」，弹窗里的中间站组合未必可售，
  展示容易误导。弹窗只展示 12306 真实返回的字段（到站 / 出发 / 停留 / 累计历时）。
  ⚠️ 后续不要再把价格加回经停站面板。
- ⚠️ **弹窗必须放在所有 `.view` 之外**（`index.html` 里 `#stopsModal` / `#taskModal` 放在 `#app`
  之后、与 `.toast` 同级）。`.view{display:none}`，弹窗原本嵌在 `#view-monitor` 里 →
  切到新建任务页时 `#view-monitor` 是 `display:none`，**`position:fixed` 也逃不出
  `display:none` 的祖先** → 弹窗被整个隐藏（`class` 上有 `open`、DOM 内容也对，但用户看不到）。
  症状就是「在新建任务页点车次号没有任何窗口」。🔎 排查手法：沿 `parentElement` 链数
  `getComputedStyle(el).display`，找出第一个 `none`；**别只看弹窗自己的 display**。
  推论：正因为弹窗现在在 `.view` 之外，CSS 只需**单 id** 前缀
  （曾经的冲突源 `.view#view-monitor .table{min-width:1100px}` 已命中不到它）。
  **若日后又把弹窗移回某个 `.view` 内，必须改回两级 id 才能压过它。**
- 弹窗内时长文案去掉空格（`5小时56分`）以免窄列溢出；「站名」列用 `auto` 吃剩余宽度，
  否则「上海虹桥」这类 4 字站名会被 `text-overflow:ellipsis` 截断。
- **可在列表里改「上车站 / 下车站」**（车票查询页与新建任务页两处入口都可）：
  典型场景是全程区间没票、但中间某段有票（如 深圳东→三亚 无票，东莞→海口 有票）。
  - 每行两个按钮（上 / 下）；`i >= STOPS.to` 的行「上」禁用、`i <= STOPS.from` 的行「下」禁用，
    从 UI 上保证「上车必须早于下车」（比事后报错体验好）。
  - 选择是**暂存**的，点「应用区间」才写回；「恢复原区间」= 回到**该车次当前区间**
    （不是重置成 12306 的始发→终点 —— 用户改完想反悔，期望回到改之前的样子）。
  - 写回时**站名 / 到发时刻 / 历时一起重算**（上车用该站「出发」、下车用「到达」，
    历时 = 两站 `elapsed` 之差）。只改站名不改时间会让卡片自相矛盾。
  - 同时把 `leg.bookable = false` 清掉可订标记：`leg.s`（席别余票）是**原区间**的数据，
    改区间后已不再适用（弹窗里有文案说明）。
  - `leg` 是 `MON.rows` 与 `APP.taskPicked[].leg` **共享的引用**，所以改一处两边同时生效；
    `pickedPairs()` 推导的任务区间、`updateNtSummary()` 的预估金额也跟着变。
  - 刷新统一走 `refreshAfterLegChange()`（车票列表 / 任务卡片 / 推导行 / 摘要）。
- 新建任务页的**车次卡片里车次号同样是按钮**（`.task-train-stops`），样式与原纯文本一致，
  只是多了虚线底边与 hover 底色提示可点。

### 5.23 表头固定：`overflow-x:auto` 会让元素变成滚动容器

**症状**：给 `thead th` 加了 `position:sticky; top:0`，页面滚动时表头**照样被卷走**。

**根因**：CSS 规范规定「一轴非 `visible` 时另一轴不能是 `visible`」——
`.scroll{overflow-x:auto}` 会让 `overflow-y` **计算成 `auto`**，于是 `.scroll` 自己就是滚动容器。
它没有高度约束时不会竖向滚动，sticky 便相对它的 scrollport 定位 → 页面滚动时毫无效果。

**修法（★ 2026-09 最终版：自然流 + 大高度上限，「单屏锁定/flex 填充」方案已废弃）**。
用户最终要求：① 不压缩查询/筛选头部 ② 不强制一页 ③ 拖列表时表头固定 ④ 列表多显示行、
不挤占原空间。因此放弃了两版「铺满单屏」：
- ~~v1 写死 `calc(100vh - 485px)`（后改 438px）~~ ——「列表以外占多少」的常数，头部一变就失准；
- ~~v2 flex 自适应填充单屏~~（`.main{height:100vh}` + `#view-monitor.is-active{display:flex}`
  整条链 + `.scroll{flex:1 1 auto}`）——满足「几乎铺满」但把页面**锁死一屏**，且 768 下
  `min-height:320px` 会把最后一行裁到视口外（`scrollBottom 781 > 768` 而 `pageScroll=0`，
  裁切不产生页面滚动，很隐蔽）。
最终方案只有一条核心规则（`app.css`）：
```css
.view#view-monitor .results-panel .scroll{max-height:calc(90vh - 40px)}
.view#view-monitor .results-panel thead th{position:sticky;top:0;z-index:3;background:#fff}
```
- 页面保持**自然流**（不锁一屏）：查询/日期/筛选面板按内容高度正常排布，列表在其下方。
- 列表行数少 → 高度就是行高本身（不撑不压）；行多 → 封顶 **`90vh - 40px`** 后列表**内部滚**，
  `thead`（sticky）钉在列表面板顶，滚列表时表头不动（对列方便）。
- 滚轮：列表内先消耗列表自身滚动量，滚到边界后按浏览器默认 **scroll chaining** 放行给页面，
  不会把滚轮「困」在列表里。**不要加 `overscroll-behavior:contain`**（会吞掉边界处滚轮）。
- **一级滚动到底时表头被顶栏盖住**不是 sticky 失效，也不应靠降低列表高度修：默认
  `.content` 底部 `padding:40px` + 最后一个 `.panel` 的 `margin-bottom:16px` 会让页面额外
  下滚 56px。只在车票页设
  `.content:has(#view-monitor.is-active){padding-bottom:0}` 和
  `#view-monitor > .panel:last-child{margin-bottom:0}`，即可让列表顶停在顶栏下方，同时保留
  `90vh - 40px` 列表高度。实测 1680×768：修前页面到底 `listTop=20`（表头被 60px 顶栏盖住），
  修后 `listTop=76`、`theadTop=77`；二级列表滚到 `scrollTop=900` 后仍 pinned。
- 列表高度只为结果条预留固定的 40px，头部内容仍保持自然流；查询/筛选头部变化不会被压缩。
  可见行数（≈18 行 @1080、≈12 行 @768，行高 53px）实测（2026-09-21）：1080 屏 54 行结果
  `clientH=931=90vh-40px`、`scrollTop=800` 时 `theadTop=listTop+0`（sticky 成立）；其他视图
  （dashboard/jobs/new/accounts/logs/settings）display 全部恢复原始（grid/block）。
- batch 模式的「悬浮栏遮最后一行」padding 补丁仍生效（`:not(.batch-mode)` 隐藏，
  `.batch-mode .scroll{padding-bottom:86px}`，实测滚到底后最后一行与悬浮栏 `overlapPx = 0`）。
- ⚠️ 历史教训（仍有效）：表头背景**必须不透明**（`#fff`），否则行会从固定表头下透出；
  `#view-monitor` 若在 ID 选择器上单独写 `display:flex` 会永久压过 `.view{display:none}`
  （ID 优先级更高）→ 视图切换报废。

### 5.24 车票查询页头部压缩（一屏布局 + 双点滑动条）

**背景**：用户先报「出发时间的最右端太宽了，要两点滑动条」+「压缩页面头部（出发地 / 预售日期）空间，
上方占比太大」；随后明确要求**保留设计稿排布**（标签在输入框上方、筛选项纵向排开）——
所以最终方案是：**不动排布，只压行高 / 内边距 / 日期片宽度 / 结果条**。
改前实测 1440×800：`.panel` 464px（占满屏 **58%**），
其中 `.query` 116 / `.dates` 103 / `.filter` 245；列表 `.scroll` **592** 但页面另滚 336px。

**改动（按收益排序）**：

| 项 | 改前 | 改后 | 手段 |
|---|---|---|---|
| `.query` | 116 | **70** | 去掉自占一行的预售期提示（-29）；标签 `margin-bottom` 6→3、输入框 36→32、上下内边距 30→19 |
| `.dates` | 103 | **45** | 日期片 3 行 → 2 行（「未开售」不再单独占一行，改成中划线 + 灰化 + tooltip）；**片宽 76→37px** 使 20 天在 ≥1280px 下**无需横向滚动**；滚动条 16→6px |
| `.filter` | 245 | **203** | 行高 34→27、分段控件 36→26、底栏 34→28（**纵向排布不变**） |
| `.bar` | 56 | **38** | 路线 + 车次数由两行合成一行（基线对齐）；按钮 30→26、padding 15→6 |
| 上下空白 | — | **-54** | `> .panel:last-child{margin-bottom:0}`；`:has(#view-monitor.is-active){padding-bottom:16px}` |
| **`.panel` 合计** | **464** | **317** | -32% |
| 车次行高 | 70 | **53** | 见下「顺带修的既有问题」 |
| 可见车次行数 | 8（但要滚整页、表头被卷走） | 列表 `max-height:calc(90vh - 40px)`：行少=自然高度，行多=封顶内部滚、表头 sticky（768→约 12 行、1080→约 17 行） | |

**⚠️ 踩坑与要点**：

- **CSS 改在哪**：这批规则写在 `index.html` 的**内联 `<style>` 块**里（不是末尾也行，只要在 `<link>` 之后），
  因为 `.view#view-monitor .query .field.route-pair` 等规则在 `app.css` 里**同特异性**，
  只能靠「更靠后」取胜（内联 `<style>` 在 `<link>` 之后解析）。
  列表**高度**在 `app.css` 一条：`.scroll{max-height:calc(90vh - 40px)}`（为结果条预留 40px，见 §5.23）。
- **`scrollbar-width:thin` 会让 `::-webkit-scrollbar` 失效**。Chromium 121+ 下一旦设置了标准属性，
  同一元素上的 webkit 伪元素被忽略，`thin` 实测 11px（日期条 61px）→ 去掉后
  `::-webkit-scrollbar{height:6px}` 生效（日期条 45px）。
  （⚠️ `app.css` 里 `.date-strip` 也写了 `scrollbar-width:thin`，那是原型残留、本页不用。）
- **日期片宽度决定「要不要横向滚动」**：`.date{min-width:0;flex:0 0 auto;padding:3px 5px}` +
  字号 12/10 → 单片 37px，20 片 + 19 个 6px 间隔 ≈ 854px，1440/1366/1280 下
  `scrollWidth - clientWidth = 0`（实测）。**改间距/字号后要重新量这个差**。
- **查询行是 12 列网格 + `align-items:end`**：写完新字段后仍要保持
  `.field{span 2}` / `.field.route-pair{span 4}` / `.btn{span 2}` 之和 = 12，
  否则会折行。`.btn` 用 `align-self:end` 与输入框**底对齐**（标签在上，网格底边才是输入框底）。
- **「交换」按钮用嵌套网格 `1fr auto 1fr`**，按钮占一个真实列 → 与输入框**零重叠**
  （实测两侧各留 6px）。`.swap-btn{margin-bottom:3px}` 是让 26px 按钮在 32px 输入框里垂直居中。
- **双点滑动条是自己画的**（`#mHourRange` + 两个 `<button role="slider">`，pointer 拖拽），
  不是两个叠起来的 `input[type=range]` —— 后者依赖 `::-webkit-slider-thumb` 的
  `pointer-events` 才能两个都拖得到，跨浏览器不稳。
  不变量是 `0 <= from < to <= 24`（**至少 1 小时窗口**），所以两端永不交叉/互换。
  `readHourRange()` 仍输出 `matchHour()` 认的 `['HH:00-HH:00']`（全量输出 `[]`），下游无需改动。
  **拖动中只更新视觉，`pointerup` 才重新筛选** —— 否则每个像素都要重建整张表。
  「**不限**」按钮在轨道**左侧**（与其他筛选行的「全部」芯片同位，默认点亮）；
  右侧 `#mHourVal` 只显示当前区间，不限时留空但保留 `min-width`（避免切换时轨道宽度跳动）。
- ⚠️ **Playwright 的 `page.mouse` 在 hidden 页面上不投递**（和 `page.click()` 超时同源）。
  验证滑动条要用 `dispatchEvent(new PointerEvent('pointerdown'|'pointermove'|'pointerup'))`
  + 先 `document.elementFromPoint(x,y)` 确认命中的是哪个元素。
- 🔎 **`page.screenshot()` 也不可靠**：本会话里它只截到窗口物理尺寸的那一块，
  且**不跟随 `setViewportSize` 的模拟滚动**。结论一律以
  `getBoundingClientRect` / `getComputedStyle` **度量**为准。
- 🔎 **量列表高度**：行少时 `.scroll` 高度 = 行高本身（不撑）；行多时 = `90vh - 40px` 封顶
  （`clientHeight ≈ 0.9 × innerHeight`，列表内部滚）。**历史教训**：`.main{height:100vh}`
  那版单屏方案会把超出视口的部分**裁切**而非产生页面滚动（`pageScroll` 恒 0 也可能裁掉了
  最后一行，768 实测 `scrollBottom 781 > 768`）——已废，但排查「最后一行看不到」时仍要先
  确认 `scrollBottom ≤ 所在滚动容器底`。

**顺带修的既有问题**：`td.train` 的内边距被后来的表格规则压掉了 ——
`app.css` 里 `.results-panel td.train{padding-top:0;padding-bottom:0}`（本意是让
`.train-stops` 按钮自己给内边距）特异性 131，但 `index.html` 里后写的
`.results-panel .table td{padding:9px 8px}` 也是 131 且更靠后 → 两者相加 18px，
**行高从 52px 虚涨到 70px**（800px 高的窗口里少显示 2 行车次）。
修法是显式压过：`.results-panel .table td.train{padding-top:0;padding-bottom:0}`（特异性 141）。
这是 §5.16「原型/后写规则静默覆盖」的又一例 —— **改表格样式前先确认没有更靠后的同族规则**。

### 5.25 ★★★ 区间设了「深圳北 → 广州南」，却下单了「深圳北 → 广州东」

**症状**：用户在新建任务页的**区间查询**里填「深圳北 → 广州南」，
结果买到了**深圳北 → 广州东**（实测订单号 `E920286710` / `E970909022`，且连续三笔）。
这不是「偶发」，是**必然**：只要那个区间里有票，引擎就会买错站。

**根因**：12306 的余票查询会做**同城站扩展**，而引擎只按「时段 + 车次白名单」过滤、**不校验行的实际到发站**。

实测：查「深圳北 → 广州南」返回 **567 条**结果，其中

| 到达站 | 条数 | | 出发站 | 条数 |
|---|---|---|---|---|
| 广州南 | 208 | | 深圳北 | 277 |
| 广州东 | 132 | | 深圳 | 205 |
| 新塘 | 87 | | 福田 | 64 |
| 广州 | 55 | | 深圳东 | 16 |
| 广州白云 / 广州北 / 番禺 / 花都 | 42 / 38 / 3 / 2 | | 深圳机场 | 5 |

而 `Job.is_trains_number_valid()` 只看「出发时间在不在时段内 + 车次在不在白名单」，
`is_has_ticket()` 只看 `canWebBuy == 'Y'` 且 `order_text == '预订'` ——
于是「深圳北 → 广州东」的 C8012 完全符合条件。任务表里 `train_numbers = []`（不限车次）时必然中招。

**修法（两个层面）**：

1. **引擎侧（核心）**：`engine_hooks._hook_station_filter()` 包装 `Job.is_trains_number_valid`，
   在原有判断之上再加一道**站点校验** —— 行的实际到发站必须落在用户输入的「前缀展开集合」里。
   判断逻辑在 `py12306/webx/stations.py`：

   | 输入 | 实际允许的站 | 说明 |
   |---|---|---|
   | `深圳北` | `[深圳北]` | 具体站只匹配自己 ★ 这是修复的关键 |
   | `广州南` | `[广州南]` | 同上 |
   | `广州` | `广州 / 广州东 / 广州北 / 广州南 / 广州西 / 广州新塘 / 广州白云 / 广州长隆 / 广州大学城 / 广州莲花山` | 城市名保留「全站」语义 |
   | `北京` | 9 个北京站 | 同上 |
   | `番寓`（打错） | `None` → **不过滤** | 宁可少管，也不能把「打错字」变成「一条也抢不到」的静默失败 |

   - 站名解析走 `webx/stations.py`：本地 `data/stations.txt` → 余票响应 `data.map` → 12306 官方站名表
     （`station_name.js`，3385 站，含新站；懒加载 + `runtime/station_codes.json` 缓存 7 天）。
     ⚠️ 本地表**缺新站**：实测余票响应里出现过本地表没有的电报码 `PYA`（=番禺），
     此时引擎的 `get_info_of_left_station()` 会直接抛 `AttributeError` ——
     所以过滤**先拿行的原始电报码自己解析**，不要依赖那个方法。
   - 首批余票响应处理完成后，如果有车次被拦，会写一条 `job_event`（kind `skip`，标签「站点过滤」）
     和一条汇总日志：`已按站点过滤 N 条非目标车站的车次`。每个引擎 Job 实例只输出一次，
     后续轮询继续累计过滤，但不重复刷屏；任务重新创建后重新统计。

2. **界面侧**：区间输入框从「纯文本盲打」升级为
   - 带**车站联想下拉**（与车票查询页起终点输入框同一套：`bindStationSuggest` 已泛化，
     用同级的 `.stn-suggest` 定位，不再只认 `mFrom`/`mTo`）；
   - **每个站名输入框正下方跟一句「实际匹配规则」**（`GET /api/stations/expand?mode=&q=A|B`
     返回 `stations.describe()`）：
     `深圳北 只匹配这一站`（挂在出发站下面）、`广州 会匹配 10 个站：广州、广州东…`（挂在到达站下面）。
     ⚠️ **必须分成两条、各自挂在自己那个输入下方**（`[data-note="left"]` → 网格第 1 列、
     `[data-note="arrive"]` → 第 3 列），不要合成一条横跨整行 —— 那样用户得自己猜
     「哪半句说的是哪个站」。城市名/前缀用警示色，未收录/不完整站名用红色。
     半行宽写不下 10 个站名 → 列表只列前 5 + `等 N 个`，完整列表放 `title` 里；
   - 建任务时 `create_job` **校验站名存在**（不存在直接 400，并回 `station_notes`），
     避免站名写错变成「任务在跑但永远没结果」。

3. **可按任务选「站点匹配方式」**（`job.station_mode`，UI 在「区间地点」卡里）：

   | 取值 | 含义 | 例（输入 `广州`） |
   |---|---|---|
   | `exact`（**默认**，UI 在**左**侧） | 仅指定站名：只认完全同名的站 | 只 1 个（广州站） |
   | `expand`（UI 右侧） | 同城站扩展：城市名匹配该城市全部车站，具体站只匹配自己 | 10 个广州站 |

   - 默认取 `exact`：最不容易买错站（就是 §5.25 这个 bug 的根因所在）。
   - `exact` 下输入不是**完整站名**（如 `番`）时 `create_job` 直接 400 ——
     否则任务会一条也抢不到（静默失败）；
   - 链路：`db.job.station_mode` → `sync.job_info_dict()['webx_station_mode']` →
     `_hook_job_init_data`（挂到 Job 实例）→ `_hook_station_filter` 读取。
     ⚠️ 该键参与 `md5(info)` → **改 mode 会重建 Job 实例**（无害）；
   - **默认值分两层，别改乱**：
     「新建任务时的默认」= `exact`（前端 `ntStnMode()` 兜底 + `create_job` 缺字段时）；
    「读不到存值时引擎侧兜底」= `expand`（`sync._station_mode` / `engine_hooks._job_station_mode` /
     `routes_jobs._job_view`）—— 因为该列是后加的，历史任务本来就是按 expand 语义跑的，
     **不要在旧对象上把语义骤变成 exact**；
   - 实测（查“深圳北→广州”的 567 行真实结果，打桩 `do_order`）：
     `expand` 放行 **247 行**（广州南/广州东/广州/广州白云…），
     `exact` 只放行 **5 行**，**全部是 `深圳北→广州`**。

**验证证据（用真实 12306 响应 + 引擎自己的 `handle_response`，`do_order` 打桩记录）**：

| 场景 | 修前（进入 do_order 的行） | 修后 |
|---|---|---|
| 深圳北→广州南 | **42 次**，覆盖 28 种 OD，**全是** 深圳/福田/深圳东 → 广州东/广州白云/新塘/广州北（含 C8012） | **0 次** |
| 深圳→广州（城市名） | 42 次 | 28 次（保留广州/广州东/广州南/广州北/广州白云，排除新塘） |
| C8012（深圳→广州东）单独判定 | `True`（会被下单） | `False` |

线上实证：一个运行中的「深圳北→广州南」任务详情里出现了
`skip | 站点过滤 | 已按站点过滤 N 条非目标车站的车次`（每个任务实例一次）。

**⚠️ 后续注意**：
- 前缀规则是**近似**（12306 的同城扩展是按城市码，不是按名字前缀）——
  例如「广州」匹配不到 `番禺 / 花都 / 新塘`（它们不以「广州」开头，虽然同城）。
  所以界面**必须把那行匹配说明露出来**；用户真想要这些站时，
  显式加多组区间（`深圳北→番禺`）即可，不要偷偷放宽规则。
- 本地站点表与官方表的合并入口是 `webx/stations.py`；`routes_tickets` 的
  站名→电报码解析也走它（不要再在别处各写一份站名表）。

### 5.26 ★★ 抢票任务在累计查询，日志里却什么都没有

**症状**：任务卡上「已查询」一直在涨、`runtime/query/status.json` 的 `query_count`
也在涨，但任务详情/运行日志里看不到 `>> 本任务第 N 次查询 …` / `出发日期 …` / `耗时 …`
任何一轮查询日志。

**根因（我们自己的钩子引入的）**：引擎把日志分「主线程 / 子线程」两套缓冲，
**只有主线程才会落盘**：

```python
# py12306/log/base.py
add_log():    self.logs.append(...) if is_main_thread() else self.thread_logs[tid].append(...)
# py12306/log/query_log.py
print_job_start(): ...; if is_main_thread(): self.flush(publish=False)
# py12306/query/job.py
Job.start() 每轮结束: if is_main_thread(): QueryLog.flush(sep='\t\t', publish=False)
```
而 `_hook_query_loop()` 为了「0 任务启动后新建任务也能查询」，把**单线程的查询循环
搬进了 daemon 线程**（`Query.start()` 原本跑在主线程）→ `is_main_thread()` 为假 →
每轮日志只堆在 `thread_logs[tid]` 里**永不落盘**（还顺带无界增长占内存）。

实测证据：`runtime/webx.log` 里最后一条 `>> 本任务第 N 次查询` 停在 `13:56:58`，
而 `status.json` 的 `query_count` 在同一时刻之后仍从 **6145 涨到 6676+**。

**修法**：`_hook_log_thread()` 把 webx 查询循环线程**视为主线程**。
⚠️ 不能只改 `py12306.helpers.func.is_main_thread` —— 各模块是
`from ... import is_main_thread` 绑定到自己的命名空间的，必须**逐个模块替换同名全局**：
`helpers.func` / `log.base` / `log.query_log` / `query.job` / `web.web`。
识别方式是线程名/属性（`WEBX_LOG_THREAD_NAME = 'webx-query-loop'`）。
副作用评估：`sleep_forever()` 也用这个判定，但全项目无人调用（已 grep 确认）。

修后实测：重启后新日志里 `>> 本任务第 N 次查询` 正常增长，任务详情 `logs` 返回 100 条。

### 5.27 ★★ 界面显示账号已登录，日志却每 3 秒刷「账号正在登录中」

**症状**：`/api/accounts` 显示该账号在线，但日志持续刷
`账号正在登录中，3 秒后自动重试`（实测累计 1700+ 行），且停止不了。

**根因（两个独立成因叠在一起）**：

| # | 根因 | 说明 |
|---|---|---|
| A | `UserJob.wait_for_ready()` 是**无界递归** | `if is_ready: return self` → 否则打日志 + `stay_second(3)` + `return self.wait_for_ready()`。对象永远不就绪时，调用它的线程**永久卡死**并每 3 秒打一行（不是「日志重复」，是「真的在无限重试」）。 |
| B | `UserJob.destroy()` 只把 `is_alive` 置 False，**不从 `User.users` 摘除** | 改账号/重新扫码后列表里会留**僵尸对象**；而 `User.get_passenger_for_members()` 取的是 `users` 里**第一个 key 匹配项**、**不看 is_alive / is_ready** → 永远卡在僵尸上。`ConfigSync._prune_dead_users()` 只在账号列表变化时才跑，救不了这个场景。 |

于是「界面（读到的活对象）显示在线」+「日志（卡在僵尸对象上）显示正在登录中」同时成立。

**修法**（见 `engine_hooks`）：
- `_hook_wait_for_ready()`：改成**有界循环**——
  先**自愈**（`is_first_time()` 为假就 `load_user()`，即读网页扫码写下的 cookie →
  `did_loaded_user()` → `is_ready=True`）；日志**限频 60s**且带上账号名与可行动提示；
  遇到**已死对象**立即 `return None`（`get_passenger_for_members` 的 `and` 会跳过它）。
- `_hook_get_passenger_for_members()`：按「**活着且就绪** → 活着 → 都没有则摘掉僵尸」
  的顺序挑对象。
- `main_web` 的 30s 守护里定期 `ConfigSync.prune_dead_users()` 兜底。

验证（单元级，构造僵尸对象）：死对象 `wait_for_ready()` **0.000s 返回 None**；
「僵尸在前 + 活对象在后」立刻返回活对象结果；「只有僵尸」时返回 None 且
`User.users` 被摘成 0 个。
线上验证：重启后新日志 `账号正在登录中` **0 次**，且 `用户恢复成功 / 乘客验证成功`
正常出现（同一账号不再自相矛盾）。

### 5.28 任务详情的车次与经停站使用任务缓存

任务创建或修改查询范围（区间、日期、车次白/黑名单、时段、站点模式）时，
`webx/task_catalog.py` 在后台按任务过滤条件查询车次并预取经停站，写入 `job_train_catalog`。
详情页只读取该缓存，不调用车票查询或经停站接口。任务删除时 `DataStore.job_delete()` 同时删除缓存；
WebX 启动时为没有缓存的旧任务补建。缓存还未完成时详情显示准备中，完成后刷新详情即可读取。
缓存完成但车次为空时，`job_event` 和 `webx.log` 记录带任务名的「条件筛选未找到有效车次」警告，任务卡片与详情页同时显示；
缓存生成失败单独显示错误，不要混报成「查无车次」。

不要把该功能改回页面打开后临时查 12306，也不要把目录数据记进周期查询计数。
如果修改 `station_mode`、时间段或车次过滤条件，必须重新排队生成该任务的目录缓存。

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

### 出发时间筛选（双点滑动条）
状态在 `MON.hourFrom` / `MON.hourTo`（整点，初值 0 / 24），**不在 `MON.filters` 里** ——
`MON.filters.hour` 是每次 `syncMonitorFilters()` 从它算出来的派生值：

```js
hourText(h)            // 8 → '08:00'（24 → '24:00'）
hourIsAll()            // from<=0 && to>=24
readHourRange()        // 全量 → []；否则 ['08:00-22:00']（matchHour 只认这个格式）
setHourFrom/setHourTo  // 夹取，保证 0 <= from < to <= 24（至少 1 小时窗口）
renderHourRange()      // 只改视觉：fill 的 left/width、两个 thumb 的 left、aria-*
resetHourRange(opts)   // 回 0/24；opts.apply===false 时不重新筛选（供「清除筛选」用）
bindHourRange()        // 由 bindMonitorFilters() 调用一次
```
「不限」按钮（`#mHourReset`）在**轨道左侧**，用 `.on` 表示当前就是「不限」（不隐藏）；
右侧 `#mHourVal` 只显示当前区间，不限时为空。
⚠️ `#mTime`（原来那 4 个区间复选框）**已不存在**，`readFilterGroup('mTime')` 会返回 `[]`；
任何新代码请走 `readHourRange()`。

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
job           抢票任务（含 seat_tiers 二维优先级、start_at、interval_min/max、is_active、
              station_mode 站点匹配方式 expand/exact）
account       12306 账号（key / user_name / password / type / login_ok / active）
user_login    管理台账号（pbkdf2(salt, hash)，无明文）
order_log     下单记录（queued → submitted → success / failed / cancelled）
hit_log       余票命中记录
daily_query   按天查询次数（由守护线程每 30s 轮询 QueryLog 差值累加）
job_train_catalog 任务车次与经停站缓存（按 job_id；任务删除时一起删除）
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
| **票价** | 已是 12306 **真实票价**（`/api/tickets/prices` 逐车次查，见 §5.22）。
  拿不到就显示 `—`（**从不估算**）。注意：每日 1:00–5:00 维护窗口期间接口不可用。 |
| **监控表格只 6 个席别列** | 后端已返回 `softSleeper`/`special`，表格未展示（这也是 §6 里 `MON.selBy` 那套语义存在的原因）。 |
| **`requirements.txt`** | 已失效，未重写。 |
| **`webx.log` 无轮转** | 账号离线时引擎每 3s 刷一行，会持续增长（目前 100KB 量级，暂时无害）。 |
| **各站起售时间（精确到分钟）** | 拿不到。官方页 `www.12306.cn/index/view/infos/sale_time.html` 背后是
  `POST /index/otn/queryAllCacheSaleTime`（返回每站 `sale_time`），但**被 passport 登录门挡住**：
  匿名 403、带已登录 kyfw cookie 也 302 到 `/otn/passport`（2026-09 实测）；`station_sale.js`
  静态表已 404。服务侧无法稳定获取，用户 2026-09 决定「处理不了就跳过、未开售日期不处理」。
  能精确推导的只有**开售日期** = 日期 − (presale_days−1)。别再重复探测这个数据源。 |
| **12306 每日维护窗口 1:00–5:00** | `app_available_check()` 会 `sleep` 到 5:00（**日志文案写"6 点"，代码实际是 5 点**）。凌晨调试时任务"看起来没跑"，**不是 bug**。 |
| **账号掉线时日志刷屏** | 已修（§5.27）：`wait_for_ready` 改为有界循环 + 限频日志 + 自愈，并跳过僵尸账号对象。实测重启后「账号正在登录中」0 次。 |

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
