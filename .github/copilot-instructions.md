# Copilot 项目指令

> 📖 **完整协作文档在仓库根目录 [`AGENTS.md`](../AGENTS.md)** —— 动手前请先读它（尤其 §5「踩坑档案」）。
> 本文件只放**每次都要遵守的铁律**，避免重复内容。

## 项目
py12306（12306 抢票助手）的二次开发。入口是 **`main_web.py`**（不是 `main.py`），
管理台跑在 `http://127.0.0.1:8600`，账号 `admin`。
解释器：`D:\Anaconda\envs\12306\python.exe`（Python 3.12.14）。

## 铁律

1. **绝不修改原版 py12306 文件**：`py12306/` 下的 `app.py` / `config.py` / `user/` / `query/` /
   `order/` / `helpers/` / `log/` / `cluster/` / `vender/`，以及 `main.py`。
   要改引擎行为 → 写进 `py12306/webx/engine_hooks.py`，用**包装（猴子补丁）**方式，
   标记 `_webx_wrapped`，幂等，回调内 `try/except` 兜底。所有新代码放 `py12306/webx/`。
2. **前端无框架无构建**：`static/main.js` 是单个 IIFE（`'use strict'`），改完刷新页面即可。
   不要引入模块系统 / 打包器 / 框架。
3. **不要 `pip install -r requirements.txt`** —— 该文件已失效（与 Flask 3.1.3 冲突）。
   依赖清单见 `AGENTS.md` §1，**`lxml_html_clean` 必须装**。
4. **不要改 `env.py` 相关** —— webx 完全不使用 `env.py`，配置源只有 `runtime/webx.json` + `webx.db`。
5. **写接口要调 `ConfigSync.publish_*()`**，否则「保存了但不生效」。

## 环境操作

- **启动**：`D:\Anaconda\envs\12306\python.exe main_web.py`。
- **重启后必须确认没有双实例**：`netstat -ano | Select-String ':8600' | Select-String 'LISTENING'`
  应**只有一行**。多一行就 `taskkill /PID <pid> /F` 再确认。
  （`wmic ... | findstr` 在 cmd 里常静默失败，别靠它。）
- **健康检查**：`curl -s -m 8 -o nul -w "%{http_code}" http://127.0.0.1:8600/api/boot` → 期望 200。
- **临时脚本**命名 `_xxx.py` / `_xxx.out`，**收尾必须删干净**（连同 `__pycache__`）。
  输出中文到终端易乱码 → 写进 `.out` 文件再读。
- **别删 `runtime/*`**（都是运行时数据）；DB 里的 `job` 行也可能是用户自己建的，删前先确认来源。

## 改动后必须验证

本项目多次出现**「看着修好了、实际没生效」**。禁止用「应该可以了」下结论，要有**实测证据**：
- 后端：真实 API 响应 / DB 查询结果（`sqlite3` 直读 `runtime/webx.db`）
- 前端（页面 hidden 时 Playwright 有坑，见 `AGENTS.md` §9.1）：
  `getBoundingClientRect` + `getComputedStyle` **度量**；**别依赖截图**（会返回空白图）。
  `page.click()` 会超时 → 改用 `page.evaluate(() => el.click())`。
- 排查第一步永远是：**确认没有双实例 → 看 `runtime/webx.log` 尾部**。

## 高频坑（详见 `AGENTS.md` §5）

- 引擎「判过期 / 判没乘客」→ **先打印 `type(r.json())`**，不是 `py12306.app.Dict` 就是根因（§5.2）。
- `self.passengers` 必须存 **12306 原始字段**，归一化会让任务「刚建好就结束」（§5.7）。
- 12306 只可用 `POST /otn/passengers/query` 取乘客；**千万别调 `initDc`**（会清掉会话）（§5.6）。
- `app.css` **后半是设计稿残留样式，作用域过宽会静默覆盖前面的规则**；排查看 computed 值（§5.16）。
- 12306 每日 **1:00–5:00 维护**，任务「看起来没跑」不是 bug（§10）。
