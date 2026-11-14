# AGENTS.md

**pythontdx** —— **只做 A 股**的跨平台行情终端，练习项目，从 0 开始手写。
技术栈：`Electron + Vite + SolidJS`（桌面）与 `Web + Vite + SolidJS`（浏览器）**双前端**，
共用一套渲染层；`Python` 后端负责通达信协议、实时行情、离线数据与数据湖。

> 定位：**学习项目**。代码质量与可读性优先于功能数量；
> 每引入一个依赖、每写一段复杂逻辑，都要能说清「为什么」。
>
> 长期目标：逐步对齐通达信官方客户端的行情、分析、选股、资料与数据管理能力；
> 数据要能长期积累并直接用于机器学习。**目标不是现状**，差距看 `PLAN.md`。

---

## 一、先读这四份

| 文件                  | 什么时候读       | 内容                                                             |
| --------------------- | ---------------- | ---------------------------------------------------------------- |
| `docs/00-项目章程.md` | **每次做决策前** | 六条核心要求（G1~G6）、范围与非目标、目标架构、数据/ML、成功标准 |
| `PRINCIPLES.md`       | **每次写代码前** | 不可违背的工程原则，带编号（`A1` / `C3` / `U4`…），可直接引用    |
| `PLAN.md`             | **每次开工前**   | 当前状态、待人工验证项、下一步候选、技术债、完成的定义           |
| `README.md`           | 第一次接触项目   | 功能一览、命令表、目录结构                                       |

背景知识按需查 `docs/`：`01` 快速开始 · `02` 架构 · `03` 通达信协议 ·
`04` 设计系统 · `05` 路线图 · `06` 踩坑笔记 · `07` 编译发布 ·
`08` 资料与协议索引（G6 的研究台账）· `09` 官方功能基线（功能对齐以它为准）·
`22` 前端设计 · `23` 前后端边界与双端一致性（A2/A8 的落地说明）·
`24` 项目结构与命名规范（**加文件、起名字只看它**）。全部文档的入口是 `docs/README.md`。

---

## 零、最高原则：禁止空调用

**任何工具调用都必须产生新信息或完成必要状态变更；禁止 Noop、占位、重复调用。**

具体禁止：

- 禁止 `true`、`echo`、`: `、`sleep` 等只走流程、不产出信息的 shell 调用；
- 禁止用空操作“占位”“保持节奏”“测试工具是否可用”；
- 禁止重复提交完全相同的工具调用或完全相同的参数；
- 同一命令失败后必须先分析结果，再换参数或换方案，不能原样重试；
- 发现没有可执行的下一步时，直接回答或停下，不要用空调用填充回合。

理由：空调用直接浪费 token、时间和工具配额，且会掩盖真正的失败。
此条优先于本文件其它效率类建议。

---

## 二、硬规则（违反即视为未完成）

1. **文件编辑只用专用工具，shell 只跑命令**
   - 读用 Read、改用 Edit/Write、搜索用 Grep/Glob；
   - PowerShell **仅**用于构建 / 测试 / git 等命令执行；
   - **禁止**用 shell 做字符串替换式文件编辑。
   - 理由：转义歧义、编码转换、正则误切已多次造成文件损坏且静默失败。

2. **`src/shared/**` 禁止 import `electron` / `node:*` / DOM API**
   它同时被 Node 侧和 Web 侧的 tsconfig 编译，引入平台代码必然有一侧失败。

3. **壳与数据分离：Python 后端管行情 IO，渲染层管呈现**
   行情 socket、文件读写、数据任务一律放 Python 后端；Electron 主进程只做
   窗口/托盘/更新、拉起本地 HTTP 服务、文件对话框与本机状态。渲染层组件
   不直接调 `window.desktop`、也不直接 `fetch`，统一走 `lib/` 里的客户端
   （`api` 数据面 + `shell` 壳能力）。**不得新增第二套数据源或第二条行情通道。**

4. **提交前 `npm run check` 必须全绿**（类型 + Lint + TS 测试 + Python 测试）。

5. **视觉改动必须截图确认**
   桌面用 `npm run shot`；Web 端用浏览器截图。类型检查和单元测试永远抓不到
   布局溢出、颜色不可读、图表画歪，也抓不到双端不一致。

6. **修 bug 必须先补能复现的失败测试，再改代码。**

7. **验证不了的事情必须明说**，不要用「应该没问题」代替证据。

8. **只做 A 股，只接通达信**
   港股/美股/期货/期权/外汇/加密不做；运行时数据源只能是通达信 7709 / MAC /
   7615 / 文件下载/本地文件，不拿腾讯、新浪、东财、AKShare 等做兜底。
   7727 扩展行情（EX）不做；它服务非 A 股品种。

9. **数据要可追溯、可重放、面向机器学习**
   原始层不可变；规范化层用 Parquet + schema 版本；按 `trade_date` 分区；
   财务/公告要 point-in-time；保留退市与停牌证券；每份数据能说清来源、时间、
   解析器版本与校验和。只存聚合结果、丢弃原始报文视为未完成。

10. **协议/字段结论必须有来源和证据**
    先查官方文档/源码，再用真实报文或探针验证；验证不了的标「未验证」。
    来源登记到 `docs/08`，字段细节回写 `docs/03` 与 `python/fixtures/`。

11. **双前端共用一套渲染层**
    桌面与 Web 共享 `src/renderer`、`src/shared` 类型与设计令牌；
    禁止复制出两套界面/两套状态。差异只能在外壳与传输层。

12. **本地数据永久保存，默认禁止删除**
    用户产生的归档、导出、缓存、原始报文与本地数据一律永久保留；不提供清理/删除入口。
    只有校验失败（文件损坏）的副本才允许替换或隔离；`.part` 临时文件可在写入完成后清理。
    已存在且校验通过的同名归档不得覆盖（返回 skipped，保留第一版）。
    理由：用户明确要求 2026-10-31；行情数据不可重放，删除即永久丢失。

> 以上是摘要，完整规则与理由见 `PRINCIPLES.md`。

---

## 三、常用命令

```bash
npm run dev                 # 开发模式（主进程重启 + 渲染层热更新 + Python 桥接）
npm run check               # 类型 + Lint + TS 测试 + Python 测试，一条命令
npm run test                # 只跑 TS 测试（359 个用例）
npm run test:python         # 只跑 Python 协议/HTTP 测试（343 个用例）
npm run audit:data          # 数据覆盖自检（39 项，会触发自动归档；清单见 docs/12）
npm run audit:docs          # 文档自检：链接/截图/路径引用 + 客户端与服务端路由一致性
npm run build:python        # Nuitka 打行情桥接单文件（打包前必跑）
npm run shot                # 构建并截图到 screenshots/，用来肉眼验收界面
npm run dev:web             # Web 前端（行情只读/本地状态可写；需先起 python/tdx_server.py）
npm run build:web           # 构建 Web 产物到 out/web/
npm run icon                # 重新生成应用图标（纯 Node 手写 PNG/ICO 编码）
npm run build               # 生产构建（产物在 out/）
npm run build:win           # Windows 打包：安装包 + 便携版 + 绿色 zip（自动自签名）
npm run build:win:zip       # 只从 win-unpacked 补绿色 zip + sha256
npm run build:win:portable  # 只要单文件便携版 exe
npm run build:win:setup     # 只要 NSIS 安装包
npm run sign:win            # 单独补签：本机自签名证书，只保证完整性，不消除 SmartScreen
npm run build:linux         # Linux 打包：AppImage + deb
npm run build:mac           # macOS dmg（仅 Apple Silicon / arm64）
npm run build:mac:app       # 只出散装 .app（本地快速验证）
npm run build:mac:all       # 散装 .app + dmg（每次版本更新后的验证流程）
```

**Python 提示**：开发机需要 Python 3.10+（`python3` 或 `python` 在 PATH 上；
也可用 `PYTHONTDX_PYTHON` 指定）。打包后的 exe 自带桥接程序，用户不需要 Python。
打包前先 `python3 -m pip install -r requirements.txt`（含 pyarrow/duckdb/Nuitka/patchelf；Linux）。

**v2.0.0 起**：**通讯协议完全统一**——Electron 也加载本地 HTTP 页面，数据面只有
`/api/*` + `/ws` 一套协议；`window.desktop` 只保留窗口/文件/通知/本机状态等壳能力。
Web 端自选/设置/预警/公式/持仓写 localStorage，桌面写 `userData/pythontdx.json`；
行情缓存/K 线增量/涨跌家数只有 Python 一份实现。独立窗口与 stdio 行情通道已移除，
行情显示全部进主工作区标签页。

> **平台范围**：代码保持 Windows/Linux/macOS 跨平台；各自在对应系统本机构建，不做交叉编译。
> 构建/测试环境：**Windows 10 22H2 x64、macOS 27.2 arm64、Ubuntu 26.04.1 x64**。
> 自动化主要在 Linux 上跑；Windows x64 已于 2026-11-01/02、macOS arm64 已于 2026-11-02
> 实机打包验收（0.9.0 ~ 0.14.4 见 `docs/releases/编年史.md` 第十一至二十八、三十一至三十八节；
> 0.14.4 的 Windows 四件套（自签名）与 macOS 散装 app + dmg 均为本地验证，不发 Release）。
> macOS 只支持 Apple Silicon，不维护 Intel 版（2026-11-02 用户决定）。

**Windows 提示**：若 PowerShell 报 `npm.ps1 cannot be loaded`，用 `npm.cmd` 代替 `npm`。

**打包提示**：产物在 `release/<版本号>/`。
`build:*` 会先跑 `npm run build:python`，把 `python/tdx_server.py`（内含 Bridge 与
HTTP/WS 服务）打成 `python/dist/tdx-bridge`，再交给 electron-builder 复制到
`resources/tdx-bridge/`；`out/web` 同时复制到 `resources/web/` 作为桌面页面。
国内网络下打包还依赖 `.npmrc` 里的 `electron_builder_binaries_mirror` ——
注意它和安装 Electron 用的 `electron_mirror` 是**两套独立下载器**，都要配。

**要正式发一个版本**（改版本号 → 更新 CHANGELOG → 打包 → 实测 → 打标签），
照 **`docs/07-手动编译发布手册.md`** 走，那里有完整的判定标准与验收清单。

---

## 四、目录速查

```
src/main/        桌面壳：index.ts（装配）+ services/（窗口、托盘、服务拉起、壳 IPC）
src/preload/     contextBridge 白名单桥：只暴露 window.desktop（窗口/文件/状态）
src/shared/      桌面 / Web / 后端共享的类型与纯函数（禁止平台 API）
src/renderer/    SolidJS 界面（桌面与 Web 共用）：components / stores / lib / styles
src/web/         Web 入口（只 import 共享渲染层，不再有自己的行情适配器）
python/          通达信协议 + 本地 HTTP/WS 服务 + 数据任务 + 数据湖（数据逻辑唯一实现）
  tests/         Python 测试（34 个 test_*.py，与源码分离）
  tdxproto/      协议层（常量/编解码/连接/请求/解析/板块/索引，单向依赖）
  fixtures/      真实报文与节假日快照
scripts/         工具链：python.mjs + build/ dev/ data/ probe/
docs/            说明文档；入口 docs/README.md，发布说明在 docs/releases/
```

新代码往哪放（完整决策表见 `docs/24`）：

- 新的上游协议 / 字段解析 → `python/tdxproto/parsers.py`（块数据 `blocks.py`）+ `python/tests/test_tdx.py` / `test_parsers.py` 加 fixture 用例
- 主机探活 / 配置 / 数据落盘 / 补历史 → `python/`（v0.7 起；不要再往主进程塞行情 IO）
- 行情业务 / 缓存 / 合并 / 涨跌家数 → `python/`（1.5.0 起，不要再写 TS 版）
- 桌面与 Web 共用的界面 → `src/renderer/`（禁止为某一端复制一套）
- 平台外壳（窗口/托盘/更新） → `src/main/services/`
- 新的全局状态 → `src/renderer/src/stores/`
- 可复用的响应式工具 → `src/renderer/src/lib/`
- 数据与壳调用 → `src/renderer/src/lib/client.ts`（`api` + `shell`，不直接 fetch）
- 任何颜色 / 间距 / 动效 → `src/renderer/src/styles/tokens.css`

---

## 五、当前阶段

**v2.0.0：技术债清算 + 信息密度 + 通讯统一。**
部署模式：**Electron 桌面与 Web 二选一，不同时使用**；同机只允许一个 Python 后端持有 7709 连接（`PRINCIPLES.md` A6）。
数据面：两端都走本地 HTTP `/api` + `/ws`；桌面 `window.desktop` 只保留壳能力。
界面：行情相关显示全部进主工作区标签页（排行榜、板块、全市场、多股同列、选股、
行情墙、逐笔明细、复盘、组合、预警、龙虎榜、异动、大盘资料），只有设置/数据/F10/公告/
公式/指标/服务器/快捷键保留弹窗。导航三层：左栏「导航」/ 右上角工具 / 标签栏「+」；
导航栏开关与全屏按钮都在右上角工具区，面板内 `«` 保留就地收起。
界面基线：设计基准 1920×1080，最低支持 1440×900（窗口最小尺寸卡死），默认最大化启动，
还原默认回到 1440×900。
行情、分时、五日、K 线增量、涨跌家数缓存全部只有 Python 一份实现。
两条新原则：**A2** 数据逻辑归 Python、前端 TS 只负责展示与传输；
**A8** Web/Electron 同源（同一命令、同一响应、同一测试）。
逐项映射与核对表见 `docs/23-前后端边界与双端一致性.md`；Web/Electron 界面差异见
`docs/22` §4.4。

健康度 `npm run check` 全绿（359 个 TS 通过 + 1 skipped；343 个 Python，1 skipped）。
2.0.0 新增：信息密度版布局、服务端面板推送 `/api/push`、备份进度 `/api/progress`、
图表工具默认收起、估值行；导航改版（去四菜单：左栏「导航」/ 右上角工具 / 「+」页面
选择器）、表头 sticky 与列宽优化、公告与 F10 同宽、逐笔明细多列整页 + 自动滚屏 +
红买/绿卖彩色系统、指标面板等距行、默认最大化 + 还原 1440×900；
TD10/11/13/19/21/22/23 已偿还。
1.7.0 新增：本地 HTTP 统一传输、主区标签页、顶部五菜单、通达信快捷键。
1.6.1 修掉：周末/节假日/凌晨把墙钟日期当交易日。
1.6.0 新增：TDX 官方节假日快照 + 0x120F 交易日状态、`market_status`。
架构详情见 `docs/02`；缓存/降频规则见 `docs/23`。

已交付：实时行情/盘口/多周期图表、默认五均线、自选行情墙、板块/MAC/F10 16 段 + 公告 19 页签、
预警且/或、条件选股预设与自动池、公式/回测、复盘、CSV/Parquet/数据湖、
离线并行同步、Web 前端、Windows x64 / Linux x64 / macOS arm64 三平台打包。

- 长期目标与范围：先读 `docs/00-项目章程.md`；差距与优先级见 `PLAN.md` 第二、四节
- 平台：代码跨 Windows/Linux/macOS；在各自系统本机构建，不做交叉编译；自动化主要跑 Linux，Windows / macOS 由对应机器实测
- 数据源只做 A 股；港股/美股/期货/期权明确不做，7727 扩展行情也不做
- 技术债：代码级已清 0；外部约束/取舍见 `PLAN.md` 第五节

**开工前请先读 `PLAN.md`，收工前请更新它。**
发布新版本时记得同步更新 `CHANGELOG.md`。
