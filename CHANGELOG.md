# 更新日志

pythontdx 的所有重要变更都记录在这里。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

分类说明：**新增**（功能）· **变更**（已有行为调整）· **修复**（bug）·
**移除** · **工程**（构建 / 依赖 / 工具链）· **文档** · **验证**（实测证据）。

---

## [2.0.1] - 2026-11-14

### 修复

- **截图命令引号缺失（文档级回归）**：采集脚本里 `PYTHONTDX_CAPTURE_CLICK=$click`
  没有加引号，含空格的选择器列表被 shell 拆成两个参数，`env` 只吃到第一个选择器——
  结果只打开了「+」菜单、没点条目，README 的「多股同列 / 全市场 / 排行榜 / 板块」
  四张截图实际是默认行情页。所有采集命令已加引号，并用「当前激活标签页」逐张核对。
- **采集驱动加固**：`PYTHONTDX_CAPTURE_CLICK` 每一步改为轮询等待目标出现（最多 4 秒）
  再点击，目标始终不出现时打印警告，避免菜单/弹窗未渲染时的静默落空。
- **文档**：README 补充 Linux 默认 Wayland 与 X11/Vulkan 回退说明；
  全部截图按 2.0.1 重拍（状态栏 `v2.0.1`），1440×900 与 Web 各一张。

### 验证

- Web/Electron 一致性探针复跑：标题栏 7 工具、左缘无把手、副图选择器在主工具栏
  （17 个选项，切 KDJ 生效）、`+` 菜单 12 项/3 组/150px、全市场 200 行/sticky/溢出 0、
  4 个弹窗可开关、浏览器版备份按钮置灰、控制台 0 报错；
- `npm run check` 全绿（359 TS + 343 Python）、`npm run audit:docs` 通过。

## [2.0.0] - 2026-11-14

> 1.8.0 发布后复查发现「副图指标」入口被折叠进默认收起的图表工具行；
> 2.0.0 作为这次界面改版的收尾版本：入口回到主工具栏，版本号正式跨过 2.0。

### 修复

- **副图指标选择器不可见**：MACD / KDJ / RSI 等副图切换在 1.8 改版后被收进默认折叠的
  「工具」二级工具栏，K 线页面上找不到入口；现移回图表主工具栏（「扩展」右侧），
  任何 K 线周期都直接可见，切换即时生效并写入设置。
- **改版入口复查**：`+` 菜单 12 项 / 6 个弹窗 / 7 个标题栏工具 / 右栏 5 个页签 /
  快捷键 F3~F10、60/63/77、`/`、`R`、`T`、`?` 全部在位；未发现其它入口丢失。

### 验证

- 日 K 切换到 KDJ：副图头显示 `KDJ K 59.84 · D 62.41 · J 54.70`；
- `npm run check` 全绿；Web/Electron 一致性探针复跑通过。

## [1.8.0] - 2026-11-14

### 新增

- **信息密度版主窗口**：标题栏 38px、状态栏 24px、行情头压缩到约 104px、
  图表二级工具栏默认收起、数据表行高收紧；1440×900 下主图高度从约 525px
  提升到约 610px，排行榜同屏从 16 行提升到 18 行。
- 图表头新增「工具」开关：复权/均线/BOLL/线性/画线/副图默认折叠，需要时展开。
- 行情头新增估值行（PE/PB/流通市值/总市值，字段缺失时自动隐藏）。
- **服务端面板推送**：新增 `python/push_manager.py` + `/api/push` SSE；
  渲染层不再持有面板 Timer，断线按稳定 id 重连。
- **备份/恢复真实进度**：新增 `/api/progress` SSE，`DataPanel` 恢复字节进度条。
- `pauseWhenHidden` 真正生效：页面隐藏时暂停行情订阅，状态栏显示「已暂停」。

### 变更

- **表头固定**：全市场 / 排行榜 / 板块 / 选股 / 大盘资料 / 组合 / 异动的表头改为
  `position: sticky`，纵向滚动时列名始终可见。
- **导航栏收起/展开**：恢复入口放到右上角工具区（面板图标，7 个工具按钮之一）；
  面板内保留 `«` 就地收起。删掉左缘 26px 的竖排把手——它占屏幕、视觉也差，
  收起后内容直接铺满，不再留白。
- **列表列宽**：名称列收到 76 / 72 / 70px；1920+ 把数据列统一放宽（80/80/72px），
  原本堆在列表右侧的空白摊回列里（1920 实测排行榜尾部空白 345px → 19px）。
- **「+」菜单收窄**：面板宽度跟内容走（实测 196px → 150px），label 与快捷键提示间距收小。
- **走势列留白**：去掉表格尾部空白列，迷你走势图统一右 2px / 左 4px；所有列表表格
  wrap 的右内边距归零，三表右缘坐标一致（1440 实测同为 1421px、1920 同为 1901px，
  `gapSvgToTable = 2`）。
- **窗口尺寸一次性重置**：老存档里的窗口几何统一重置为 1440×900（保留最大化记忆），
  方便按最低支持分辨率验收；迁移版本号 `windowSizeVersion`。
- **分辨率基线**：设计基准 1920×1080，最低支持 1440×900；窗口默认最大化启动，
  从最大化还原默认回到 1440×900，最小尺寸卡在 1440×900，低于此不再适配。
- **默认最大化 + 记忆**：首次启动直接最大化；还原窗口默认 1440×900；之后记住上次
  是否最大化与正常窗口尺寸，用户还原过窗口就按记住的尺寸打开（截图工具按设计跳过最大化）。
- **左栏改名为「导航」**：标题由随视图变化的「自选股 / 板块排行 / 自定义板块」统一为
  「导航」（指南针图标 + 当前列表数量），视图名交给下面的三个切换按钮。
- **左栏快捷页栏**：在「自选股 / 板块 / 自定义」切换**之上**、自选列表上方新增 6 个
  快捷入口（排行榜 / 全部 A 股 / 板块 / 多股同列 / 条件选股 / 自选行情墙），
  按钮等分宽度，侧栏拖到 200px 也不溢出。
- **逐笔颜色系统**：红=主动买、绿=主动卖、紫=集合竞价、灰=盘后/不明方向；
  成交量按分位分三档（中单提亮、大单强调色加粗），整页逐笔一屏可读。
- **导航改版**：移除标题栏「报价 / 分析 / 资讯 / 工具」下拉菜单。工作区页面统一从
  标签栏「+」打开（行情 / 分析 / 资讯三组，带 60/63/F9/77 提示）；全局工具改为右上角
  按钮（预警 / 数据 / 服务器 / 快捷键 / 设置 / 主题）；左栏顶部保留列表操作与快捷页栏。
  右上角按钮统一为图标风格（同一尺寸/间距/悬停），文字说明放 `title`，不再图标与
  「图标 + 文字」混排。
- **全屏按钮**：窗口按钮组（最小化 / 最大化 / 关闭）左侧新增「全屏 / 退出全屏」切换；  状态跟随窗口事件，图标与 `title` 同步（`toggle-fullscreen`，非 macOS/Web 才显示）。
- **公告面板宽度**对齐 F10（1056px 阅读宽度），19 个在线页签收紧后一行放得下。
- **逐笔明细整页**：自动载入全天成交，按列铺开（1440 宽 5 列、20px 行高），跟随最新
  成交自动滚屏；一屏约 225 笔，不再是一条竖列。
- **指标面板**改为两列等距行（30px 行高），标签与数值两端对齐，底部留白不再拉伸。
- **自选股计数**只统计自选分组，不再把自定义板块的股票算进去。
- 默认栏宽 264/300（旧默认 280/330 自动迁移），桌面侧栏/右栏更窄，图表更宽。
- 排行榜、板块、选股、全市场、龙虎榜、异动、大盘资料、组合表统一使用紧凑行高。
- 主区页头、盘口面板、侧栏行、状态栏按行情终端密度收口。
- 1024×700 隐藏底部缩放提示，避免压住横轴刻度。

### 技术债

- 已偿还：TD10（设置项 UI）、TD11（迷你图请求上限）、TD13（分时缩放/平移）、
  TD19（tail 合并共用向量）、TD21（面板推送下沉 Python）、TD22（许可证核对）、
  TD23（备份进度 SSE）。
- 代码级未偿还项为 0；TD5/6/7/8/9/12/14/15/16 移入「已接受的外部约束」，
  理由见 `PLAN.md` 第五节。

### 工程

- 版本 `1.8.0`；`package.json` / `package-lock.json` 同步。
- `python/push_manager.py`、`python/test_push_manager.py`；`test_server.py`
  增加推送调度与进度广播用例。
- 面板推送/进度 SSE 仍由 Python 侧调度；不新增第二条行情通道。
- **结构收敛（纯重构，无功能变化）**：`python/tdxproto/` 九个单向依赖模块 +
  `tdx_bridge.py` 门面；`shared/types.ts` 拆 `types/` 七个领域模块；组件按
  `panels/charts/chrome/atoms` 分组；`components.css` + `app.css` 拆成
  `components.css` + `panels/*`(6) + `layout/*`(3)；`docs/07` 的版本存档迁
  `docs/releases/编年史.md`；`scripts/` 按 `build/dev/data/probe` 分组。
  规则见 `docs/24`，审计记录见 `docs/25`。

### 修复

- **WebSocket 帧头分片**：`_ws_read` 用 `recv(2)` 拿帧头，TCP 只先到 1 字节时
  被当成断连；改为 `_recv_exact(2)`，并补「帧头分两次到达」的回归用例。
- **`/api/push` 队列泄漏**：客户端在握手阶段断开时，`register_client` 已登记但
  finally 还没进入，队列不回收；把响应头写进 try/finally，并补回归用例。
- **`npm run shot:web` 在 `ELECTRON_RUN_AS_NODE=1` 的终端里直接失败**：
  新增 `scripts/dev/web-shot.mjs` 启动器，spawn 前清理该变量。
- **Windows 打包脚本根路径**：`scripts/` 分组后 `sign-win.ps1` / `build-win-zip.ps1`
  仍按「上一层=仓库根」取路径，`npm run build:win` 会在 `scripts/release` 下找产物；
  改为向上一层再上一层，随后完整跑通签名与绿色 zip。
- **1440×900 横向滚屏**：全市场表按「wrap 内容宽」重算（此前只比 wrap 宽，漏算
  左右 24px 留白），收留白 + 收掉一列；排行榜/板块再收市值与涨跌停两列；
  大盘资料收表留白；龙虎榜改固定布局并给列宽——14 个列表窗口在 1440×900 实测
  全部 `wrapOverflow = 0`。
- **龙虎榜列宽**：短列按内容定宽（日期 88 / 代码 70 / 名称 92 / 收盘 64 …），
  「上榜原因 16% / 营业部 30%」按比例分配；长文本折行完整显示，不再截断。
- **「+」菜单跑出窗口**：标签栏最右侧的「+」用左对齐定位，面板会越过窗口右缘；
  菜单定位改为按视口夹取（右侧不够就左移，下方不够就翻到上方），1440/1920 实测
  面板完整在窗口内。
- **名称列被拉伸**：表格 `width:100%` + `table-layout:fixed` 会把多余宽度摊给所有
  定宽列，名称列在宽屏下被拉宽留白；全市场/排行榜/板块去掉尾部空白列后按比例分配，
  名称列回到 76/72/70px 量级，走势列不再被尾列拉开。
- **Web / Electron 一致性**：行情服务器弹层补 `role="dialog" aria-modal="true"`；
  浏览器版备份/恢复按钮由「点击后报错」改为置灰 + 标题提示 + 区块说明（数据湖/导出
  仍可在浏览器下载）。

### 文档

- README 全部截图按 1920×1080 重拍（总览 / 多股同列 / 全市场 / 排行榜 / 板块 / F10 /
  数据工具 / 竞价 / Web），最低档 1440×900 单独一张 `pythontdx-compact-1440.png`；
  修正 7615 `fetch_*` 数量（51 → 52）、数据湖目录清单、F10 与公告页签的表述、
  全市场横向滚动的描述。
- 新增 `docs/25-全库审计报告.md`（范围、方法、发现、复核方式），并补第二轮
  Web/Electron 一致性与发布前回归（§8）。
- `docs/22` 新增 §4.4「Web / Electron 一致性」对照表与四条有意保留的差异。

### 验证

- `npm run check`：359 TS（+1 skipped）+ **343 Python**（+1 skipped）全绿。
- 截图：`screenshots/ui-dense-final.png`、`ui-dense-final-1024.png`、
  `ui-dense-ranking.png`、`ui-push-sse.png`、`ui-tape-view.png`；
  本轮审计又按 1.8 重拍 README 的 10 张图（`docs/assets/pythontdx-*.png`）；
  Web 单端口与 Electron 生产页面数字一致。
- **Windows 产物实测（2026-11-14）**：Nuitka 4.3.3 + MSVC 14.5 编译
  `python/dist/tdx-bridge.exe`（22.7 MB）；`python/dist/tdx-bridge.exe --serve`
  冒烟（ping / code_list / quotes / market_status）通过；`npm run build:win`
  产出 setup 135 MB、portable 135 MB、绿色 zip 182 MB（sha256 见 `.sha256`），
  均已自签名；`win-unpacked` 与 portable 实跑截图见 `screenshots/packaged-*.png`。
- Windows 1.8.0 四件套已本地构建/签名/冒烟（`release/1.8.0/`）；Linux/macOS
  在对应系统构建后发版。本轮不自动打 tag。

---

## [1.7.0] - 2026-11-14

### 新增

- **统一通讯协议**：Electron 主进程拉起本地 Python 服务并加载
  `http://127.0.0.1:<port>`，与浏览器共用同一套 `HTTP /api` + `WebSocket /ws`。
  - 新增 `src/main/services/server.ts`（端口 0 解析、健康检查、退出清理）；
  - 新增 `src/main/native-ipc.ts`（只保留窗口/状态/对话框/通知）；
  - 新增 `src/shared/desktop.ts`、`src/renderer/src/lib/shell.ts`
    （桌面 `window.desktop` 与 Web 降级实现）；
  - `src/renderer/src/lib/http-api.ts` 成为两端唯一数据适配器。
- **主工作区标签页**：新增 `stores/workspace.ts`、`WorkspaceTabs`、`Menu`。
  排行榜、板块/概念、全部 A 股、多股同列、条件选股、自选行情墙、复盘、
  组合分析、预警、龙虎榜、沪深异动、大盘资料全部在主区打开，可关闭/切换；
  非行情标签自动收起右栏。
- **通达信快捷键**：F3 上证、F4 深证、F5 分时↔日 K、F6 行情、F7 公告、
  F9 选股、F10 资料、数字命令 60/63/77；Esc 关闭弹窗或当前标签。
- 壳状态仍走 `window.desktop.state`；Web 继续用 `localStorage`
  （UI 状态，不是行情数据；后续可接服务端状态）。

### 变更

- 标题栏收成「报价 / 分析 / 资讯 / 数据 / 工具」五菜单；侧栏只保留
  行情墙/多股/选股/新建板块/隐藏侧栏；状态栏移除导入导出（移到设置）。
- 搜索提交、自选行点击、列表行点击都切回「行情」标签，不再关闭弹窗。
- 1024 宽自动收窄侧栏/盘口、指标两行、隐藏侧栏迷你图；趋势图刻度按图高降密度。
- 面板嵌入主区时使用 `role=region`，不再声明 `aria-modal`。

### 移除

- **stdio 行情通道**：`src/main/ipc.ts`、`QuotePoller`、`PushHub`、
  `src/main/services/tdx/**` 整目录；
- **Web 端第二套适配器** `src/web/http-api.ts`、`src/web/version.ts`；
- **独立 K 线窗口 / 第二主窗口 / 板块选择全屏层**；逐笔放大弹窗改为主区「逐笔明细」标签；
- `window.api`（由 `window.desktop` + 统一 `api` 取代）。

### 工程

- Nuitka 打包入口改为 `python/tdx_server.py`（同时处理 `--offline-worker`）；
  `--serve` 兼容参数、`PYTHONTDX_PORT=` 端口行；`electron-builder.yml`
  增加 `out/web → resources/web`。
- `npm run build` = `electron-vite build` + `npm run build:web`；
  开发模式 Vite 代理 `/api`、`/ws` 到 8765。
- 新增 `src/shared/version.ts`、`workspace.test.ts`；更新 `scripts/version.test.mjs`。

### 验证

- `npm run check`：359 TS（+1 skipped）+ 336 Python（+1 skipped）全绿。
- Electron 生产页面截图：`screenshots/ui-rework-1.png`、`ui-ranking.png`、
  `ui-blocks.png`、`ui-market.png`、`ui-multi.png`、`ui-sector.png`、
  `ui-screener.png`、`ui-watch.png`、`ui-report.png`、`ui-alerts.png`、
  `ui-tabs-menu.png`、`ui-tape-view.png`、`ui-portfolio.png`、`ui-dragon.png`、
  `ui-unusual.png`、`ui-1024.png`。
- Web 单端口页面截图：`screenshots/ui-web.png`；同一时刻
  `sh000001` 3634.35、涨 765/跌 4748/平 68。
- Nuitka 已用 `python/tdx_server.py` 重新编译 `tdx-bridge.exe`，实测
  `--serve --port 0` 输出端口行、`/api/ping` 与 `/` 均 200；
  `electron-builder --win --dir` 产出 `win-unpacked` 并实机启动截图，
  退出后无残留服务进程。
- 未做：setup/portable/zip 三件套、Linux/macOS 安装包实测、发布 tag（待人工执行）。

---

## [1.6.1] - 2026-11-14

### 修复

- **非交易日的时间归属**（社区 PR #2 `fix/non-trading-day-basis`；
  用户 2026-11-14 周六在 Web 端发现）：
  - **分时基准**：`Bridge.minute()` 不再用「日线最后一根 == 今天」判断，
    改为按 `shanghai_clock` 的 session 决定分时属于今天还是上一交易日。
    周末/节假日/凌晨取「日线最后一根」为交易日、昨收取再往前一根；
    `sz301218` 周六昨收从 99.86 修正为 86.60，0% 轴与 tooltip 涨跌幅一致。
  - **日 K 假 bar**：`applyLiveQuoteToKline()` 新增 `allowsNewBar()`，
    只有开盘后（含收盘后 `>=15:00`）才允许补当天 K 线；周末/节假日/凌晨
    只更新最后一根，不再造出 `2026-11-14` 这种不存在的交易日。
  - **离线同步 `fetchedAt`**：`kline_manifest` 统一按 `+08:00` 写；
    新增 `_manifest_day()` 兼容 epoch 毫秒与带时区 ISO，避免 CI 的 UTC
    runner 在 00:00–08:00 把缓存判成前一天。

### 验证

- `npm run check` exit 0：**372 TS**（370 通过 / 2 skipped）+ **336 Python**
  （335 通过 / 1 skipped）。
- 真实 7709 实测（2026-11-14 周六 06:12，Windows x64）：
  `market_status` → `today=2026-11-14 / lastTradingDay=2026-11-13 /
session=weekend`；`minute sz301218` → `date=2026-11-13 /
prevClose=86.60 / 240 点`，末点 `15:00 = 99.86`；日线末三根
  `11-11 94.97 / 11-12 86.60 / 11-13 99.86`。修复前同一份数据把昨收算成 99.86。
- 新增回归：`test_tdx.TestMinuteTradingDate` 4 例 + `_manifest_day` 1 例；
  `realtime.test.ts` 3 例（周末不补 bar / 收盘后可补 / 开盘前不补）。
- Windows 本机构建 `release/1.6.1/` 与实机启动验收见 `docs/07` 第四十九节；
  tag `v1.6.1` 的 GitHub Actions run `43517135236` 三平台 success，
  12 个资产已发布到
  <https://github.com/riverzhou/pythontdx/releases/tag/v1.6.1>。

### 工程

- 版本 `1.6.1`；`package.json` / `package-lock.json` 同步。

---

## [1.6.0] - 2026-11-06

### 新增

- **TDX 交易日历**：
  - 内置通达信官方 `Except<year>.zip` / `neednote_RecentHSHoliday.txt`
    的 2025/2026 节假日快照（`python/fixtures/tdx_holidays.json`）；
  - MAC `0x120F` 的 `today` / `lastTradingDay` 识别官方文件之外的临时休市；
  - 新增 `market_status` 命令 / `POST /api/market_status`；桌面与 Web 启动后
    每 5 分钟刷新，`marketSession` 增加 `holiday`（「节假日休市」）；
  - 离线同步的 08:45–15:45 保护窗口、桌面 Poller、Web SSE/WS、
    分时/K 线/逐笔刷新节奏都使用同一份交易日历；
  - 用户仍可在 `<数据目录>/trading_holidays.json` 追加休市日。
- **部署模式约束**：设计上 Electron 桌面与 Web **二选一，不同时使用**；
  同机只允许一个 Python 后端持有 7709 连接。写入 `PRINCIPLES.md` A6、
  `docs/02`、`docs/23`、README 与 AGENTS。

### 变更

- 交易日历来源登记到 `docs/08`（TDX 官方通知 + Except2025/2026 + 上交所休市安排）。
- 内置快照随 sidecar 打包；`python/build.py` 的缓存指纹包含该文件。

### 验证

- `npm run check` 全绿：369 TS（367 通过 / 2 skipped）+ 331 Python
  （330 通过 / 1 skipped）。
- 实机 `market_status(force=True)`：0x120F `today=lastTradingDay=2026-11-06`，
  47 个 TDX 节假日日期；`session=lunch-break`。
- 新增：官方节假日解析、0x120F 状态、`holiday` 会话、春节/国庆边界、
  离线窗口、Web/桌面 `market_status` 契约测试。
- Windows 本机构建与启动验收见 `docs/07` 第四十八节；tag `v1.6.0` 的
  GitHub Actions run `42166373012` 三平台 success，12 个资产已发布。

---

## [1.5.0] - 2026-11-06

### 新增

- **社区 PR #1 合并**（`perf/closing-downshift-and-locks`）：
  - 收盘/午休自动降频：桌面 `QuotePoller` 与 Web SSE/WS 按交易时段降速；
  - 涨跌家数改分页扫描，页间释放行情锁，Web 端加按时段 TTL 与跨日失效；
  - F10 路由移出行情锁；7615 网关按最近成功延迟排序，失败站点冷却 60 秒；
  - 行情编排（0x054c 快照 → 0x0547 增量 → 合并 → 竞价兜底 → MAC 兜底）
    下沉 Python `Bridge.live_quotes`，桌面 IPC / HTTP / SSE / WS 共用；
  - 逐笔面板收盘后降频；Web/K 线推送防重入并复用 tail 策略。
- **两条架构原则**：写入 `PRINCIPLES.md`：
  - **A2** 数据逻辑归 Python，前端 TS 只负责展示与传输；
  - **A8** Web 与 Electron 同源：同一命令、同一响应、同一测试。
- **边界文档**：新增 `docs/23-前后端边界与双端一致性.md`，含职责矩阵、
  两端映射表、缓存规则、反模式与发布前核对表。

### 变更

- **数据缓存下沉 Python**：分时 10s、五日 60s、K 线 60s TTL 统一由
  `minute_cached` / `five_day_cached` / `kline_cached` 提供；删除 TS
  `TtlCache`、`services/tdx/breadth.ts`、`shared/kline-live.ts`。
- **实时 K 线增量统一**：首帧全量、tail 20 根、60 秒补全量、断层重取全部在
  `Bridge.kline_live`；桌面与 Web 不再各自维护缓存。tail 不落盘，避免每秒
  重写 20 根 parquet。
- **涨跌家数统一**：扫描状态、计数、TTL、跨日失效移到 Bridge
  `breadth_begin/breadth_step`；桌面只驱动分步命令，Web 服务端只做 single-flight。
- **轮询降频统一**：新增 `pollDelayMs()`；桌面 Poller 与 Web 轮询降级共用；
  Python `_quote_interval()` 使用同一组测试向量。
- **阅读文档重写**：README、`docs/02`、`docs/22` 按 1.5.0 架构更新。

### 修复

- **盘中行情时间显示「—」**：Python 合并快照时把 `updateTime` 置 `None`，
  JSON 到 TS 变 `null`，状态栏用 `!== undefined` 判断导致不再回退本地接收时间。
  现在删除该字段，状态栏同时兼容 `null`。
- **Windows 跨源写请求 `ConnectionAbortedError`**：403 响应前未排空请求体，
  Windows 发 RST。现在先读完合法长度的 body，再回 403 并关闭连接。
- **时段边界盲区**：低频轮询在 12:59:59.6 醒来时会跳过 0~500ms 的边界，
  13:00 第一帧被拖后 30 秒。TS/Python 都改为不跳过临近边界，并补测试。
- **取消订阅后空转**：`QuotePoller` 在途请求的 `finally` 会重新排定时器；
  现在用 `active` 标记阻止，主动取消不再推 error 帧。新增 `poller.test.ts`。
- **Web 轮询堆叠**：`setInterval` 改为链式 `setTimeout` + 在途判断，失败按
  1/2/4/8/10 秒退避，与桌面一致；SSE 断流会回退轮询。
- **Python 缓存无上限**：行情缓存增加 256 项 FIFO 上限，实时 K 线 128 项，
  避免长时间看全市场后内存持续增长。

### 工程

- `python/tdx_bridge.py`：新增 `kline_cached`、`kline_live`、`minute_cached`、
  `five_day_cached`、`breadth_begin/step`、`invalidate_caches`、
  `ms_until_session_change`；`kline` 增加 `persist` 参数。
- `python/tdx_server.py`：K 线/分时/五日走缓存方法，新增 `POST /api/kline_live`；
  涨跌家数改用 Bridge 分步扫描；跨源拒绝先排空 body。
- `python/subscription_hub.py`：新增 `boundary_for`，低频等待被交易时段边界封顶。
- TS：`src/main/services/tdx/index.ts` 只剩转发/校验；`src/web/http-api.ts`
  不再持有 K 线缓存；删除 5 个 TS 模块/测试，新增 Python 缓存测试 8 个、
  TS 轮询/时段测试 5 个。
- `package-lock.json` 恢复 PR 中无关的 npm 元数据 churn。

### 文档

- README 全面重写：1.5.0 重点、架构边界、缓存规则、测试计数、文档索引。
- `docs/02` 重写为当前双前端 + 单数据实现架构。
- `docs/22` 更新“定时器在壳、数据规则在 Python”、K 线展示缓冲边界。
- 新增 `docs/23`；`PRINCIPLES.md` 新增/重写 A2、A8。
- `PLAN.md` 更新当前状态、技术债与下一步。

### 验证

- `npm run check` 全绿：366 TS（364 通过 / 2 skipped）+ 324 Python
  （323 通过 / 1 skipped）。
- 新增覆盖：Python 缓存/TTL/K 线增量/涨跌家数/时段边界/403 请求体；
  TS `pollDelayMs`/临近边界/`QuotePoller` 取消。
- Windows 本机构建与实机启动见 `docs/07` 第四十七节；tag `v1.5.0` 的 GitHub
  Actions run `42162458126` 三平台 success，12 个资产发布。

---

## [1.4.0] - 2026-11-04

### 新增

- **官方日 K 文件通道**：`0x06b9` 直接下载 `vipdoc/{sh,sz,bj}/lday/<code>.day`，
  6,035 根全历史约 7 个 30KB 块；失败才回退 0x052d 分页。实测 100 只 16×4
  仅 6.2 秒。
- **1 分钟 K 100 日窗口**：独立 `kline_1m` 数据集；优先复用本地 1m 全历史缓存，
  只补最新页，写 `lake/kline_1m/trade_date=<末日>/<code>.parquet`。
- **Parquet 写入加速**：从 DuckDB 逐行 INSERT 改为临时 CSV staging + `COPY`；
  2.2 万行从约 4 秒降到约 0.19 秒/文件；最终仍是 Parquet+ZSTD。
- **任务摘要与续跑**：最近任务摘要保留 `completed/failed/incomplete/cancelled`、
  计划/完成/失败/行数、数据集和目录；失败/中断可一键续跑；新增「自动续跑」
  开关，桥接重启后自动续跑一次。
- **日 K 缓存按最近交易日刷新**：skipExisting 不再把上一交易日的日 K 永久跳过。
- **1m 重复下载**：旧 1m manifest 把「服务端只有 92 日」写成 `complete=false`，
  导致每次跳过检查失败；现在 1m 只要有文件+manifest+rows 就跳过，新归档写
  `complete=true`。旧版中断留下的「有 parquet、无 manifest」会读回 Parquet 补写
  manifest，不再整只重抓。
- **auction / money_flow 重复下载**：auction manifest 的 SHA 是对解压后 JSONL
  计算，通用跳过器按 gz 文件算，全部误判损坏；money_flow 旧 manifest 没有 rows
  字段，通用检查直接跳过。现在改用 manifest + 文件大小/元数据校验，auction 从
  5,616 任务降到 133、money_flow 降到 0。
- **生成下载计划过慢**：规划阶段不再对 11 万份逐笔逐个读 manifest/算 SHA，
  逐笔按交易日目录预加载；完整计划从约 41 秒降到约 7 秒。
- **自动续跑反复拉起**：同一 jobId 在一次会话内只自动尝试一次，关闭/重开数据
  面板不会反复重新规划。
- **1m 旧缓存不更新**：缓存已有 100 日时循环直接跳过网络，旧缓存会一直写到
  10-30 分区；现在即使缓存够 100 日也至少抓最新页，直到与缓存重叠，600841
  实测从 10-30 更新到 11-04。
- **无数据任务反复重试**：服务器明确返回“没有可归档数据”的 auction/tick/
  minute_aux/history/1m/kline 任务写 `.nodata.json` 标记，第二次同步跳过；只标记
  no-data，不标记超时/网络错误。
- **日 K 当天旧数据反复重下**：北交所/停牌代码的官方 `.day` 仍是旧日期时，
  同一天刷新过一次后按 `fetchedAt` 跳过，第二天再试；不再每次同步都重下 21 只。
- **进度条完成态**：失败任务也计入已处理，`completed` 时进度条画满，不再卡在 97%。
- **任务摘要耗时/数据集**：摘要显示总耗时（startedAt→finishedAt），
  每数据集完成数修正（worker 的 `ok` 正确映射到 `done`，不再显示 —）。

### 修复

- **Windows worker 看门狗**：`os.kill(pid, 0)` 在 Windows 会发 `CTRL_C_EVENT`，
  把父 sidecar 和所有 worker 一起打断；改用 `OpenProcess + WaitForSingleObject`。
- **任务中断清理**：父进程退出后 worker 自动退出，不再留下 48 个孤儿进程吃 CPU。
- **数据面板自动扫描**：打开面板不再自动扫 40 万文件，避免 20s 超时杀桥接；
  扫描超时 120s，同步与扫描互斥。
- **同步启动 IPC 克隆**：datasets/codes 复制为普通数组，修复
  `An object could not be cloned`。

### 调查结论

- 官方离线数据本地是 `vipdoc/*.day`、`*/minline/*.lc1`、`*/fzline/*.lc5` 文件；
- 日 K 可从 7719 文件服务/0x06b9 取到；
- 1 分钟**没有 HTTP 文件 URL**：7719 对 `.lc1` 返回 size=0；官方用行情协议抓取后
  写本地 `.lc1`。因此本项目 1m 继续走 0x052d，不伪造文件通道。

### 验证

- `npm run check`：359 TS（357/2 skipped）+ 283 Python（282/1 skipped）；
- 1m 100 只：48×4 **8.2 秒**，8×4 **12.3 秒**；
- 日 K 100 只：16×4 **6.2 秒**，48×4 **12.2 秒**；
- 全量覆盖审计仍不完整；任务摘要会明确标 `incomplete`，可续跑。

## [1.3.5] - 2026-11-04

### 修复

- **点击「开始并行同步」报 `An object could not be cloned`**：上次配置里的
  `datasets` 是 Solid store 的 Proxy，初始化到 `syncSelection` 后直接塞进
  IPC payload。现在初始化、预设、启动前都复制成普通数组；`codes` 同样复制。
  打包版实测可正常建任务。

## [1.3.4] - 2026-11-04

### 变更

- **并发模型**：默认 **8 进程 × 4 线程**；进程上限 **48**、每进程线程上限 **4**；
  48×4 可开 192 条连接，不再被旧的 12 进程上限截断成「最多 12 个下载器」。
- **一进程一主站**：调度时把第 i 个 worker 钉在 `servers[i % len(servers)]`，
  该 worker 的 4 条线程共享同一主站，避免所有进程都挤在前几台。
- **逐笔成交最近 20 交易日**：`ticks` 数据集默认展开最近 20 个交易日
  （显式 `--dates` 时仍尊重用户日期），标签改为「逐笔成交（最近 20 交易日）」。
- 数据工具恢复上次配置时，进程/线程数按 1–48 / 1–4 夹取。

### 验证

- `npm run check`：359 TS + 280 Python（279 通过/1 skipped）；
- 设置面板 8×4；48×4 规划不再被 clamp；
- 任务 spec 每个 worker 只带 1 台主站；
- ticks 单只代码规划 20 个交易日任务（2026-10-08 → 2026-11-04）。

## [1.3.3] - 2026-11-04

### 新增

- **1 分钟 K 独立下载**：`kline_1m` 与 `kline`（日 K 全历史）分开勾选；
  1 分钟 K 默认取**最近 100 个交易日**，服务端当前实际保留约 92 个交易日
  （600519 实测 22,080 根，2026-06-22 → 2026-11-04），写
  `lake/kline_1m/trade_date=<末日>/<code>.parquet` + manifest。
- **数据工具记住上次配置**：数据集勾选、范围、数据源、进程/线程、跳过已有
  写入 `settings.offlineSync`，下次打开数据工具自动恢复（包括用户主动清空）。

### 修复

- **`offlineSync` 设置 IPC 克隆错误**：`plainSettings()` 未拍平嵌套的
  `offlineSync`，打开数据工具时报 “An object could not be cloned”；已拍平
  datasets 数组。
- **1 分钟 K 天数分组**：按完整日期时间计数会错当 20 根；改为按交易日
  `YYYY-MM-DD` 分组，再裁剪最近 N 日。

### 验证

- `npm run check`：359 TS + 280 Python（279 通过/1 skipped）；
- `kline_1m` 单只：22,080 根 / 92 日 / 1.1s（20 日时 4,800 根）；
- 打包 sidecar worker 启动已验证（1.3.2）。

## [1.3.2] - 2026-11-04

### 修复

- **打包版离线同步无法启动 worker**：`subprocess.Popen` 在 Nuitka 打包后把
  `cwd` 指到构建机路径，报 `WinError 2`；改为 `cwd=job_dir`，并优先选择真实存在的
  `sys.executable`/`sys.argv[0]`。用打包后的 `tdx-bridge.exe` 实测 worker 正常启动。
- **同步失败不可见**：状态为 `failed` 时面板直接显示错误，不再只停在「同步中」。

### 新增

- **数据工具全量进度条**：并行同步（探测/计划/真实完成数/吞吐/ETA）、下载
  zhb.zip、目录扫描、完整性校验、K 线导出、全市场快照、数据湖归档、竞价归档、
  本地读取/导入/写回、SQL 查询；能算百分比就画确定进度，否则画不确定动画 + 耗时。
- **README 全面翻新**：新主图/数据工具进度/尾盘竞价截图，重写功能、数据湖、
  协议边界、快速开始与文档索引。

### 验证

- `npm run check` 全绿：359 TS（357 通过/2 skipped）+ 280 Python（279 通过/1 skipped）；
- 打包 sidecar：`offline_sync_start` → worker pid 运行中；
- 指数成交量 599.39 万手；尾盘竞价 688499 56 点。

## [1.3.1] - 2026-11-04

### 修复

- **大盘指数成交量单位**：0x053e/0x054c/0x054b 的指数量是「股」，K 线是
  「手」；实时合并时未归一，最后一根量柱 100×，把历史量柱压成 1%。现在
  `_build_quote` 与 MAC 0x122B 的指数量统一除以 100，量图恢复正常；
  不需要重新下载离线数据。
- **尾盘集合竞价**：0x056a `selector=0` 只到 09:25；`selector=1` 才含
  14:57–15:00。竞价页签新增「早盘 / 尾盘 / 全天」切换，尾盘实测
  600519 59 点、688499 56 点。

## [1.3.0] - 2026-11-04

### 新增

- **离线数据并行同步**（`python/offline_sync.py`）：多进程 × 每进程多线程 ×
  每条线程钉不同主站，24 个数据集（K 线/分时/买卖力道/小走势/竞价/逐笔/
  历史分时/资金流/财务/股本变迁/F10/退市日线/分类行情/板块元数据/涨跌停表/
  服务器文件），任务切片、按权重分片、任务级 results、bulk 合并、失败清单、
  `skipExisting` 断点续跑。
- **交易时段保护窗口**：交易日 08:45–15:45 禁止离线下载；窗口内启动返回
  `blocked` 与 `nextOpenAt`，运行中进入窗口会暂停（paused），15:45 后续跑；
  节假日表可选（`trading_holidays.json`），缺省只按周末判断。同一保护也覆盖
  sidecar 的批量归档命令（cache/archive_* / tick/auction/minute 等），实时查询不限。
- **收盘自动归档改到 15:46–16:30**：原 15:05–15:40 会被窗口保护挡住，且 15:40
  截止会让 15:45 后永远不触发。
- **桌面数据工具面板**：预设（daily/watchlist/full）、数据集勾选、范围
  （自选/全 A）、进程/线程数、窗口徽标、进度条、worker 进度与失败列表；
  HTTP `/api/offline_sync_catalog|status|start|cancel`；命令行
  `python offline_sync.py --preset daily ...`。
- **0x053f 九榜排行**：一次请求拿涨幅/跌幅/振幅/涨速/跌速/量比/正委比/
  负委比/换手；`/api/top_board`、归档 `lake/top_board`。
- **0x0563 主力监控**：19 类异动事件（7709 原生，不再依赖 MAC 0x1237）；
  `/api/unusual`、归档 `lake/unusual`。
- **0x051a 成交分布（筹码分布）**：解析 + 归档 + 单测；含三档盘口/内外盘/
  32 位补码价位归一化。**免费主站实测全部超时**，只作为手动数据集，不进预设。
- **SSE/WebSocket 订阅 Hub**（`python/subscription_hub.py`）：相同代码集合 +
  相同间隔的多个连接合并成一次上游轮询，首帧基线、慢客户端丢最旧帧、
  错误隔离、最后一个订阅退出自动收敛。

### 修复

- **0x054c 单记录/子集快照错标**：`_split_quote_records` 回读记录头
  `market+code` 并按记录切分；`parse_snapshots` 用记录头配对并标 `requested`，
  不再把另一只证券的数据标成请求代码。
- **keyed 归档同日覆盖**：新增 `code_archive` 按代码/业务 key 分片，覆盖
  分时 5 类 + `block_meta/category_quotes/market_news/channel_news/f10_market/
f10_detail`；同一天不同 key 不再互相 `skipped`，列表接口兼容旧布局。
- **全量翻页被短页截断**：`full_kline` / `delisted_history` 只在空页停止；
  服务端重复返回同一页时停止并标 `complete=false`，不静默截断。
- **本地 `.day` 系数与残尾**：按代码段区分 A 股/沪 B/指数/基金/债券的价格与量
  系数（沪基金 0.001、指数量 1.0），残尾不足 32B 忽略；写回用同一系数。
- **0x0ffc 资金流没有落盘**：`Bridge.money_flow` 成功后写 `lake/money_flow`
  （payload 带 `source=7709 0x0ffc` 与 5 日 records），与 MAC 0x1218 区分。
- **0x0010 财务缺 5 个股本字段**：补国家股/发起人法人股/法人股/B 股/H 股与
  `recordHex`；`floatSharesShares/totalSharesShares` 明确单位，旧 `*Yuan`
  字段保留一版兼容。
- **数据面板同步状态被长任务饿死**：`offline_sync_*` 走 priority 队列，
  不再排在 `data_inventory` 后面。

### 工程

- **帧长/解压上限**：响应声明长度上限 + `zlib.decompressobj(..., length)`
  限制解压输出，畸形帧最多占 64KB。
- **单请求 deadline + 重连清理**：连接/心跳/响应共用一个 `REQUEST_TIMEOUT` 预算；
  `close()` 清空未配对推送帧，避免重连后把旧连接的 0x0547 帧合并进当前快照。
- **新增单测 70 个**：离线窗口/预设/分片/worker/bulk 合并/损坏重写、
  0x053f/0x0563/0x051a 解析、keyed 归档、快照记录头、翻页、本地系数、
  订阅 Hub（Python 175 → 272）。
- **文档**：新增 `docs/16-gotdx能力与推送机制调研.md`、
  `docs/17-eltdx协议差距与补齐清单.md`、`docs/18-离线数据并行同步.md`；
  更新 docs/03/08/11/12/14/15、PLAN、README。

### 验证

- 交易日 13:14 启动离线同步 → `blocked`，`nextOpenAt=15:45`；
- 2 进程 × 2 线程、2 只日 K（force）→ `completed`，14,519 根，0 失败；
- finance bulk 3 只 → 合并归档 3 行，SHA256 写 manifest；
- 日常预设 2 只代码、2 进程 × 3 线程 → 23 个任务、0 失败、25,460 行（含九榜
  540 行、主力监控 1,200 行）；
- `data_integrity` 真实数据 148,427 份 manifest/SHA256，0 失败；
- `npm run check` 全绿（359 TS + 280 Python，1 skipped）；
- 面板截图 `screenshots/data-offline-sync.png`（24 个数据集、保护中徽标）。

### 新增（2026-11-04 数据功能第二轮）

- **MAC 扩展**：新增 0x120F 服务端信息、0x122A 股票摘要、0x122D 单只快照、
  0x122E K 线、0x123D 竞价、0x123E 多日分时；`--source auto|mac|7709`，
  K 线/当日分时 MAC 优先、失败回退 7709；结论：MAC 不是 7709 超集，不能全面替代。
- **原始字段**：7709 K 线新增 openMilli/closeMilli/highMilli/lowMilli/
  lastCloseMilli/volumeRaw/amountRaw（Parquet 向后兼容）；报价新增
  timeRaw/currentHand/openAmount/status/recordHex 等原始值。
- **本地 GBBQ**：`gbbq.py` 解密/解析 `T0002/hq_cache/gbbq`，本机实测 202,313 条；
  自动扫描常见安装目录或 `PYTHONTDX_GBBQ_PATH`。
- **7615 涨跌停梯子**：`CWServ.cfg_fx_lbtt`，实测当日 131 行。
- **历史专业财务 gpcw**：计算服务器 0x06b9 下载 `tdxfin/gpcw*.zip`，解析
  `20B 头 + 11B 索引 + float32`，写 `lake/finance_history`；实测 5,572 只 × 658 字段。
- **7615 扩展**：三主机 failover；补 gpquery/rdtcgn/cwzd/ggzp/rdtc_gndb/
  zfhpmx 7 个 Entry、HQServ 7 个页面、行业 20 个子页；资讯频道 22 → 84；
  ColDes 回退与重复列 `__2`。
- **离线同步**：默认并发 4 进程 × 8 线程（32 连接）；新增 `blocks`（板块与行业，
  默认勾选）、`finance_history`（默认最新 1 期）；F10 从预设移除、默认不勾选；
  删除旧的两套前台批量下载 UI，只保留并行同步一套。
- **文档**：新增 `docs/19-MAC协议与数据源策略.md`、`docs/20-数据功能补齐与代码审计.md`；
  更新 docs/03/08/09/11/12/15/16/17/18、PLAN、README、python/README。

### 修复（2026-11-04 第二轮）

- `TQLEX_URL` 被多主机改造忽略，测试/部署注入失效 → 候选首位保留 `TQLEX_URL`。
- MAC 多日分时 `days` 未裁剪 → 参数传入 parser 并裁剪。
- MAC K 线首根被当昨收基准丢弃 → `keep_first` + 跨页 `pre_close_hint`，全历史
  6,035 根与 7709 一致。
- gpcw 未来报告期空占位包解析失败 → 过滤未来日期与 <1KB 空包。
- HQServ 结果集 ColName 为空 / ColDes 为 `{"Name":...}` 时列名丢失 → 回退解析。
- 节假日「manager 允许启动、worker 立刻暂停」→ worker 窗口改用 `offline_window`。
- worker 全部异常退出却报 completed → 按 returncode/worker 状态标 failed。
- MAC 单只快照汇总段阈值 109 但实际读到 +120 → 修正为 120。

### 修复（2026-11-03 实盘反馈）

- **集合竞价主图不刷新**：分时实时轨迹原先要求行情时间 >= 09:30，竞价
  09:15–09:30 的报价全被丢弃。改为从 09:15 起接收，并用 09:30 昨收基准
  绘制竞价到当前价的竖线；09:25:00 最后一秒不再被官方槽位过滤掉。
- **集合竞价板块左侧栏不刷新**：板块视图原先用 MAC 批量报价，竞价阶段
  部分代码没有新价；改为优先走 0x054c 快照（与行情头/主图同一套 0x056a
  竞价兜底），失败才回退 MAC。
- **分时实时轨迹叠加**：`liveTicks` 从「每秒追加、最多 6000 点」改为只保留
  当前秒一个点，每秒重画最后官方分钟点到当前价的短线，不再把旧轨迹叠在图上。
- **自选股右键菜单**：左侧自选行支持右键，可直接加入自选或任意自定义板块；
  已有「添加到自选股 / 添加到自定义板块」菜单，不再只能在表格/板块列表右键。

### 工程

- **K 线本地缓存补齐成交额**：协议解析不再丢弃 amount，Parquet schema 与
  CSV 导出增加 `amount`（成交额，元）；指数 K 线同时保留 `upCount/downCount`
  （上涨/下跌家数）。K 线浮层显示成交额；旧 Parquet 没有这些列时兼容读取为
  `null`，下次网络请求自动回写完整列。
- **协议能力第一批**：独立实现 `0x000f` 股本变迁/GBBQ、`0x0010` 财务 136B
  全字段、`0x02c5` 板块文件元数据、`0x0452` 特殊品种涨跌停表、`0x051b`
  分时副图（买卖力道/成交对比）、`0x052b` 退市日线（仅日线不复权）、
  `0x052d` 定点复权（`fixed_qfq`/`fixed_hfq` + anchor）、`0x0fd1` 小走势、
  `0x0feb` 近期历史分时，新增 `/api/capital_*`、`/api/finance_*`、
  `/api/block_meta*`、`/api/minute_aux*`、`/api/sparkline*`、
  `/api/recent_minute*`、`/api/special_limits*`、`/api/delisted_*`；
  分别写 `lake/corporate`、`lake/finance`、`lake/server_meta`、
  `lake/minute_aux`、`lake/sparkline`、`lake/recent_minute`、
  `lake/special_limits`、`lake/delisted`，均带 manifest/SHA 并纳入 data coverage。
- **MAC 字段扩展**：`0x122B` 位图覆盖协议文档中的 99 个 FieldBit，新增盘口五档、
  涨跌停价、PE、主力净额/多周期、委比、换手、DDX/DDY/DDZ/DDF、日内节点涨幅等；
  解析结果附 `fields` 原始字典，离线位图/解析测试覆盖。
- **历史分时归档**：新增 `0x0fb4` 单日历史分时查询与
  `/api/history_minute*`，写 `lake/history_minute`。
- **当日分时归档**：`0x0537` 显式归档到 `lake/today_minute`，
  新增 `/api/minute_archive_save`、`/api/minute_archives`。
- **分类行情归档**：`0x054b` 全量分页快照写 `lake/category_quotes`，
  新增 `/api/category_snapshot`、`/api/category_archive_save`、`/api/category_archives`。
- **本地复权系数**：按 `0x000f` 标签 1 权息事件计算 qfq/hfq 仿射系数，
  新增 `/api/adjustment_factors`、`/api/local_adjust_kline`；附公式单测。
- **7615 板块/指数/大盘**：新增 23 个 section（板块基础/资金/成份股/异动、
  指数概况/估值/成份/资金、大盘两融/新股/概览等），HTTP `/api/f10_market_report`。
- **7615 频道资讯**：新增财经/股票/新股/基金/债券等频道列表与
  `/api/f10_channel_news`，支持页码、页大小、关键词。
- **7615 热点题材/详情**：新增 `/api/f10_hot_topics`、`/api/f10_detail`，
  题材结果写 `lake/f10_pit`。
- **7615 ETF/基金 F10**：新增 30 个 section（基金经理/公司/概况/规模/净值/
  分红/持仓/资产配置/费率/评级等），HTTP `/api/f10_fund_report`；结果自动写
  `lake/f10_pit`。
- **F10 详情归档**：`f10_detail` 新增 `lake/f10_detail` 归档与
  `/api/f10_detail_archive_save`、`/api/f10_detail_archives`。
- **数据审计扩展**：`data_integrity` 校验 14 类通用归档的 files[]、JSONL
  SHA256 与行数，并新增审计单测。
- **CI 质量门**：新增 `.github/workflows/check.yml`，push/PR 自动跑
  Node 24 + Python 3.14 的 `npm run check`。
- **归档读取接口**：新增 `read_dataset_archive` 与
  `/api/dataset_archive_read`，可按 dataset + trade_date 读取通用 JSONL 归档。
- **板块/指数/大盘归档**：新增 `lake/f10_market` 与
  `/api/f10_market_report_archive_save`、`/api/f10_market_report_archives`。
- **频道资讯归档**：新增 `lake/channel_news` 与
  `/api/f10_channel_news_archive_save`、`/api/f10_channel_news_archives`。
- **7615 F10 补充分区**：新增最新提示 8 分区（含投资者互动）、全市场资讯首页、
  盈利预测/治理/排名明细/北向持仓；个股结果继续写 `lake/f10_pit`，
  资讯可写 `lake/market_news`。

### 验证

- `npm run check` 全绿：359 TS（357 通过/2 skipped）+ 280 Python（276 通过/1 skipped）；
- MAC 日 K 6,035 根与 7709 一致；gpcw 5,572×658；GBBQ 202,313 条；
- 离线同步 24 数据集；面板截图 `screenshots/data-offline-sync.png`；
- 详细边界见 `docs/20-数据功能补齐与代码审计.md` §3。

## [1.2.0] - 2026-11-03

### 修复

- **Linux AppImage 双击不启动**：根因是 Ubuntu/GNOME 把 `application/vnd.appimage`
  默认交给 `gnome-disk-image-mounter.desktop`，双击只是挂载镜像，不是可执行位问题。
  新增 Linux 桌面集成：安装 pythontdx 桌面入口 + 通用 AppImage 启动器，并把该 MIME
  的默认打开方式指向启动器；首次从 AppImage 启动时询问一次，设置面板也可手动重试，
  或直接运行 `AppImage --install-desktop`（不开窗口）。纯函数、临时目录安装流程
  与 CLI 路径均有测试；真实 AppImage 双击仍需实机复验。
- **无本地缓存时点搜索结果报 `trend:kline` 异常**：`cacheOnly` 在本地没有 K 线时
  改为返回 `miss + 空 bars`，不再 reject；首屏缓存探测不再往 Electron 控制台打
  handler 异常，也不会在网络失败时拿空图冒充缓存。
- **集合竞价页签看起来不刷新**：竞价过程按时间从 09:15 往下增长，之前列表不自动
  跟随底部，点数多的科创板尤其像价格冻结。新增顶部「最新竞价」读数、最近更新时间
  和自动滚动（用户上翻时暂停跟随）；集合竞价阶段行情头用 `0x056a` 补最新虚拟撮合价。
- **盘中分时/K 线延迟大、多股同列不刷新**：交易时段主图**所有**分时和 K 线
  统一 1 秒；面板推送绕过 TTL；K 线首帧全量、之后每秒只回最近 20 根并合并；
  九宫格每格独立推送，分时/K 线同样 1 秒。午休 30 秒、收盘 60 秒降频，
  且定时器对齐 09:15/09:30/11:30/13:00/15:00。
- **开盘第一秒没有分时线**：官方 09:31 前没有分钟点。新增 09:30 昨收基准
  与 `liveTicks` 1 秒报价轨迹；K 线用 `applyLiveQuoteToKline` 补最后一根/
  开盘第一根。官方点到达后按槽位过滤，避免污染历史。
- **集合竞价左侧栏没有价格**：缺失/价格为 0 的代码通过 `auction_quotes`
  取 `0x056a` 最后一个虚拟撮合点，生成带 `auction=true` 的最小 Quote；
  自选行显示价格并标注「竞价」，不再只显示「—」。
- **盘中价格只有 3 秒级**：实测 0x0547 增量约 3 秒才出新价，改用 0x054c
  快照提供 1 秒价格/量/额，0x0547 保留五档深度；行情头/状态栏显示真实
  接收时间，不再拿旧 updateTime 冒充当前帧。
- **搜索出列表后点不中个股**：输入框 `onBlur` 140ms 后关闭弹层；用户点击
  稍慢（mousedown→mouseup 超过 140ms）时 click 落在已移除的节点上，表现为
  「经常点不出来、偶尔成功」。搜索项与「清空」按钮在 mousedown 阶段
  `preventDefault()`，不再让输入框失焦；350/500ms 慢点击均在打包 AppImage 中验证通过。

### 新增

- **主界面北京时间时钟**：标题栏每秒显示 `HH:MM:SS`、日期、星期和交易时段；
  集合竞价/连续竞价带脉冲提示，固定东八区，不跟随系统时区。
- 行情头与状态栏区分「交易所行情时间」（`0x0547` 的 `updateTime`）与「本地接收时间」。

### 验证

- `npm run typecheck`、`npm run lint`、`npm run test`（359 个 TS 用例）、
  `npm run test:python`（175 个 Python 用例，1 skipped）全部通过；
- 交易时段 CDP 实测：行情头/状态栏约 1 秒更新；主图 liveTicks 每秒增长；
  九宫格 4 张卡每秒刷新且 live 轨迹存在；K 线 `更新` 徽标 1 秒。
- 全新用户目录启动、搜索 600519、竞价页签、九宫格与标题栏时钟已用 CDP 实机检查；
- 打包后的 AppImage 实测：行情头约 1 秒更新、liveTicks 持续增长；
  `--install-desktop` 后 `gio open` 能真正启动 AppImage；
- 搜索慢点击回归：350 / 500 / 3000 / 6000ms 按住后松开均能选中个股；
- 竞价兜底与开盘第一秒仍需下一交易日 09:15–09:31 实盘复核。

### 发布

- tag `v1.2.0` 已推送 GitHub，Actions run `41595573695` 四 job 全 success；
  [GitHub Release v1.2.0](https://github.com/riverzhou/pythontdx/releases/tag/v1.2.0)
  共 12 个资产：Linux AppImage/deb、Windows setup/portable/zip、macOS arm64 dmg，
  以及 SHA256/公钥文件；
- Linux：`pythontdx-1.2.0.AppImage` `895105d70534ed2ffe3ce592b1896ed284efd83ba67db8ab775a863a668d5805`；
  `pythontdx_1.2.0_amd64.deb` `2b4024c3ec3487281afd7e13ec16e0cac6b91c8ed176e44b26ae5b9f0ae8fcbd`；
- Windows setup/portable/zip 与 macOS dmg 的 SHA256 见 Release 附件。

## [1.1.0] - 2026-11-02

### 变更

- **正式名称统一为 `pythontdx`**：窗口/标题/托盘/设置/安装包/快捷方式/产物文件名、
  `appId`、包名、Python sidecar 的缓存路径、数据 schema、备份 manifest、
  localStorage key 与文档全部改名。
- **默认窗口改为 1440×900**：旧 1600×900/1280×820 默认尺寸启动时升级；
  主行情指标固定 12 列单行；全市场/板块/排行榜收窄名称列、加宽走势列，
  1440 下表格无横向滚动；板块侧栏的迷你走势按显示顺序预热并在滚动时补齐。
- **旧数据迁移**（不删除旧目录/旧键）：
  - 主进程把 `%APPDATA%/StockLens`（或旧 userData 目录）复制到 `pythontdx`，
    `stocklens.json` 复制为 `pythontdx.json`；便携版 `StockLens-data` → `pythontdx-data`；
  - Python 把 `~/.local/share/stocklens` 整体迁移到 `~/.local/share/pythontdx`，
    保留 `STOCKLENS_DATA_DIR` 作为旧环境变量别名；
  - 渲染层把 `stocklens.*` / `stocklens:web:state` 复制到 `pythontdx.*`；
  - 旧备份的 `_stocklens_backup.json` 仍可读取/恢复。
- 迁移逻辑单独放在 `src/main/services/legacy.ts`、`python/data_paths.py`、
  `src/renderer/src/lib/legacy-storage.ts`，其余代码不再出现旧名。

### 验证

- `npm run check` exit 0：**319 TS（318 passed + 1 skipped，34 文件）+
  172 Python（1 skipped）**；
- 重命名后首次启动实测：读取旧用户目录成功，左侧自选 23 只、版本 `v1.1.0`，
  1440×900 无横向溢出；
- Python 数据迁移测试：旧目录 → 新目录、已有新目录不覆盖、旧环境变量别名；
- 主进程迁移测试：旧 userData/本地存储复制、新配置不覆盖、便携目录迁移。

### 发布

- tag `v1.1.0` 已推送 GitHub，Actions run `41449933914` 四 job 全 success；
  [GitHub Release v1.1.0](https://github.com/riverzhou/pythontdx/releases/tag/v1.1.0)
  共 12 个资产：Linux AppImage/deb、Windows setup/portable/绿色 zip、
  macOS arm64 dmg，以及 SHA256/公钥文件。
- 本地 `npm run build:win` 同步恢复绿色 zip 体系（`build:win:zip`）。

## [1.0.0] - 2026-11-02

### 发布

- 0x0547 增量游标、60 秒基线看门狗、30 秒心跳、重连与缓存全部进入正式版。
- 三平台（Linux x64 / Windows x64 / macOS arm64）由 GitHub Actions 构建并发布到
  GitHub Release；Windows 使用免费自签名（不购买付费证书），macOS 使用 ad-hoc 签名。
- Windows CI（`build-windows-x64` 与 `release-1.0.0`）现在同时产出
  `pythontdx-<version>-win-x64.zip` 绿色包（含自签名 exe 与公钥证书），
  并作为 Actions artifact / GitHub Release 资产上传；已有 Release 可用
  `release-windows-zip` 只补 zip，不重打其他平台。
- 2026-11-02 实际补发：`release-windows-zip` run `41418995799` 成功，
  `v1.0.0` Release 新增 `pythontdx-1.0.0-win-x64.zip`（180,319,847 B，
  SHA256 `8b38a7ae578af49dbf61ff32f60d0bc6513589406ac4dbde03bb736e65a7b4ce`），
  setup/portable/dmg/AppImage 与旧证书均未改动。
- 功能矩阵：**334 ✅ / 0 🟡 / 0 ⬜ / 6 ⛔**；6 项 ⛔ 为明确范围/授权边界。
- 验证：315 TS + 168 Python（1 skipped）；`audit:data` 39/39。
- GitHub Release：[v1.0.0](https://github.com/riverzhou/pythontdx/releases/tag/v1.0.0)。

## [1.0.0-rc.1] - 2026-11-02

### 新增 / 修复

- **0x0547 增量刷新**：确认 `cursor=0` 建基线、记录内 `updateTime` 作下一次游标，
  无新成交返回 0 条；Python 侧保存 per-code cursor，空响应复用上一帧，
  不再误触 MAC 兜底或清空界面。
- **部分返回按代码映射**：增量页只返回有变化的代码时，按记录头「市场 + 代码」切分，
  不再按请求顺序硬配；修复“只更新 sz000001 却标成 sh600519”的错位。
- **未配对推送帧**：`TdxConnection` 区分请求响应与不匹配 msgId 的 0x0547 帧，
  入队后由 `Bridge` 合并；当前免费主站 48 站各 5 秒、75 秒/45 秒观察未主动下发；
  独立 eltdx issue #21 四层实测同为 0 帧、同日非零游标 refresh 正常；
  实时链路仍以
  1 秒增量刷新为主。
- **实时鲁棒性**：空闲 30 秒自动 `0x0004` 心跳；8 秒请求超时；断线重连；
  跨交易日清空游标；每 60 秒强制一次 cursor=0 基线防止游标失步；历史竞价服务器为空时回退永久本地归档。
- **测试**：新增部分返回映射、游标缓存、推送帧入队/合并、响应头解析用例；
  `npm run check`：**315 TS + 168 Python（1 skipped）**；`npm run audit:data` **39/39**。
- **Linux / Windows 1.0.0-rc.1**：Linux AppImage `1fa65830…`、deb `d7af62ba…`；
  Windows CI setup `253d1a47…`、portable `678366d9…`（未签名）；
  macOS dmg `73bb8040…`（ad-hoc，GPL 校验通过）；已打 `v1.0.0-rc.1` tag，暂未打 `v1.0.0`。

### 边界

- 主动推送是否发生由主站决定；本次未观察到当前免费主站主动下发，不宣称所有主站/时段永不推送。
- 板块行情列表显示板块指数涨跌幅（tooltip 含点位）；选中板块头部显示指数点位/涨跌幅
  与成分股领涨股，`screenshots/boards-market-1.0.png` 已验收。
- 本地 `.day/.lc1/.lc5/.5` 读/写 API 与测试已接；真实 `sh600519.day` 回读
  2026-10-26~10-30 五根日线并通过。
- 1.0 仍需完成 `docs/08` 服务器文件完整目录边界，并完成三平台实机验收。

## [0.14.4] - 2026-11-02

### 修复

- **冷启动分时图**：ChartPanel 先用 localStorage 里的上一帧分时/五日快照画图
  （标注「离线缓存」），不再等 sidecar；实测首屏 **404ms**。网络回来覆盖。
  最多保留 12 个分时 / 6 个五日，写入节流 2 秒。
- **macOS sidecar 首次执行扫描**：不是解包/CPU 慢。standalone 目录（无解包）
  首次也要 **7.75s**、第二次 **0.09s**；复制到新路径首次 1.82s、第二次 0.09s。
  `syspolicyd` 日志显示 Gatekeeper 在逐个扫描新 dylib 的 provenance。
  根因是 Nuitka onefile 每次启动用新的临时目录，每次都被当成新二进制扫描。
  macOS 改为按「Python 源码 + connect.cfg + Nuitka 版本」指纹固定解包目录，
  之后启动 **0.28s**；缓存键随 sidecar 代码变化，不会复用旧逻辑。
- **涨跌家数卡队列**：原来一个 `market_breadth` 独占串行 sidecar 5.7s，期间切股票/
  切分时全部等待。新增 `market_breadth_page`，每 8 页（640 只）一次请求，页间让
  priority 图表请求插队；仍是单 sidecar，没有改进程架构。
- 新增 `trend-cache` 5 个测试、`market_breadth_page` Python 测试；
  `build:mac:app` / `build:mac:all` 固定「散装 app / app+dmg」验证流程。

### 验证

- `npm run check` exit 0：**315 TS（32 文件）+ 164 Python（1 skipped）**；
- 0.14.4 打包 app，全新 userData + 清 sidecar 缓存：真首次 **10,333ms**；
  同配置第二次 **365ms**、第三/四次 **364 / 389ms**；
- 分时快照首屏：**404ms**（副作用是显示「离线缓存」，网络回来后消失）；
- sidecar 启动：standalone 首次 7.75s → 二次 0.09s；onefile 固定缓存路径后
  二次 0.28~0.45s；`syspolicyd` 日志确认是 Gatekeeper 首次扫描；
- 同机 0.14.3 打包版请求 trace：`market_breadth` 6.45s → 12.12s，独占 5.7s；
  分页后每段约 0.8s；
- 0.14.4 散装 app 与 dmg 由 `npm run build:mac:all` 生成，做本地启动/签名/GPL 验证；
  本轮不发布 GitHub Release。

### Windows 0.14.4 回归（2026-11-02）

在 Windows 10 22H2 x64 上按 README 快速编译手册重跑 `npm run check` +
`npm run build:win`，并逐个启动安装版/绿色包/便携版/zip：

- `npm run check` exit 0：**315 TS（32 文件）+ 164 Python（1 skipped）**；
- 新增 `scripts/sign-win.ps1` / `npm run sign:win`，`build:win*` 自动用本机 10 年
  自签名证书给 setup、portable、绿色包内 exe 做完整性签名；公钥导出为
  `release/<version>/pythontdx-selfsigned.cer`。**它不消除 SmartScreen**；
- 全量数据下 `data_integrity` 超过默认 30 秒：自检脚本把该项超时放宽到 300 秒
  （`data_coverage` 120 秒），审计仍 **39/39**；
- 安装版 `v0.14.4`：日 K 首图 **353ms**、逐笔首行 **209ms**；
- 绿色包：日 K **335ms**、逐笔 **184ms**；便携版/zip 均启动 `v0.14.4`；
- 静默卸载干净；`app.asar` 含 35,149 字节 GPL 文本与 `data:backup-progress`。

产物（`release/0.14.4/`）：

| 产物                                          |                    大小 | SHA256                                                             |
| --------------------------------------------- | ----------------------: | ------------------------------------------------------------------ |
| `pythontdx-0.14.4-setup.exe`                  |           133,627,048 B | `a6d29b9f76fa7831678216bf767d08cd04bce0f8cf40a3422692ef5e515d3457` |
| `pythontdx-0.14.4-portable.exe`               |           133,373,408 B | `63e003a64fbe2ba0f3457e45780d8999ea2af4afd800e833b6d08f23c5aec2e1` |
| `pythontdx-0.14.4-win-x64/`                   | 410,633,012 B / 76 文件 | —                                                                  |
| `pythontdx-0.14.4-win-x64.zip`                |           175,233,347 B | `38d2114b59f730c39bf08d13ede78e72206b0fb372a80a6019e566da27e0d4fa` |
| `win-x64/resources/app.asar`                  |             3,611,842 B | `6dda60b01b4180c3318a031fee9f6cf3a309293d0c9c1b5acb7ece4de1f26231` |
| `win-x64/resources/tdx-bridge/tdx-bridge.exe` |            21,527,496 B | `8e20031126e534814636ca003c7964dbedced5338b64b121547b3c2aa8bb7e17` |
| `pythontdx-selfsigned.cer`                    |                   822 B | `32d7a672d3cbce39173d8187b9b9c4a6fdd6463332b02c76d17af79270212a8c` |

自签名证书指纹 `566C43464A1F482C02081344823AB247163B913B`；`Get-AuthenticodeSignature`
正常显示 `UnknownError`（根未受信任），`NotSigned` / `HashMismatch` 表示签名无效或被改过。

绿色 zip 按 README 的手工步骤生成（`win-unpacked` 复制为
`pythontdx-0.14.4-win-x64` 后 7-Zip 压缩）；`build:win` 本身只产出 setup /
portable / `win-unpacked`，不会自动生成绿色目录或 zip。

### Linux 0.14.4 回归（2026-11-02）

- **README Linux 编译手册修正**：Ubuntu 26.04 系统 Python 受 PEP 668 管理，
  改为项目内 `.venv`；补 `python3-venv`、`libfuse2t64`、无 FUSE 的
  `--appimage-extract-and-run` 和 `apt install ./...deb`；Linux 实测版本改为
  Python 3.14.4 / Nuitka 4.3.3。
- `npm run check` exit 0：**315 TS（32 文件）+ 168 Python（1 skipped）**；
  `npm run audit:data` **39/39**；`npm run build:linux` exit 0；
- AppImage/deb 均启动 `v0.14.4`，默认自选 4 个宽基指数；
- AppImage 完成一次 1.6 GB 备份，进度条 **100%**（82/82 文件）；
- 两个包内 `app.asar` 均含 `data:backup-progress` 与 35,149 字节 GPL 文本。

| 产物                                             |          大小 | SHA256                                                             |
| ------------------------------------------------ | ------------: | ------------------------------------------------------------------ |
| `pythontdx-0.14.4.AppImage`                      | 154,528,884 B | `a7567031faae1ff6bb2b333a64f79dc17d8a77a78bef8ea100e309aeea50762d` |
| `pythontdx_0.14.4_amd64.deb`                     | 128,641,832 B | `2a8add0af11951180a021221a5e9e65e191cb60a333e9b7a55097657698c3ba5` |
| `linux-unpacked/resources/app.asar`              |   3,607,099 B | `71462c02bde14649a6f21d15609499890de43774e88ab0211b3498ee27fb74e1` |
| `linux-unpacked/resources/tdx-bridge/tdx-bridge` |  28,461,264 B | `0f01f15092ed2c8b1718257eb3df537f75b2e58c2bcc4d90e663e40cb47bf084` |

### 0x0547 增量刷新与推送队列（2026-11-02 盘中）

- 修正探针：首次 `cursor=0` 取基线并解析记录内 `updateTime`；下一次用该
  `updateTime` 作游标，实测返回 **0 条**（无新成交）；有新成交时返回 1 条并推进。
  自动分析：`INCREMENTAL_CURSOR_CONFIRMED`；
- 客户端修复：per-code 游标缓存、空响应复用上一帧、按记录内「市场 + 代码」映射
  （增量页可能只返回部分代码，旧实现会错配代码）；
- `TdxConnection` 现在区分请求响应与未配对 0x0547 推送帧：非匹配帧入队，
  `Bridge` 合并并推进游标；当前免费主站 75 秒单代码、45 秒 80 代码未主动下发，
  实时链路仍以 1 秒增量刷新为主；
- 增加空闲 30 秒自动 `0x0004` 心跳、8 秒请求超时、断线一次重连；
- 新增 Python 测试：部分返回按代码映射、游标缓存、推送帧入队/合并、响应头解析；
- 证据：`lake/probes/0x0547-20261102-103316.jsonl`、
  `0x0547-analysis-20261102-103329.json`（`docs/03` 3.8、`docs/08` 第 3 项）。
- 历史竞价服务器返回 0 条时回退永久本地归档（服务器只保留近期），
  `npm run audit:data` 恢复 **39/39**。
- 边界：未观察到当前主站主动推送，不能宣称所有主站/时段永不推送。

## [0.14.3] - 2026-11-02

### 修复

- **打开软件十几秒才出分时图**：两个请求顺序 bug，**不是 sidecar 架构问题**；
  独立 sidecar 方案试过后已撤回，保持单 sidecar、三平台同一套代码。
  - 状态栏「涨跌家数」在挂载时立刻请求 `market_breadth`，Python 要分页扫
    5579 只 A 股，实测独占 sidecar 串行队列 **7.5 秒**。新增 `scheduleBreadth`：
    等首帧行情 `live` 后再延迟 1.2 秒加载，之后按 30 秒轮询。
  - 默认 **分时**请求没有优先级，sidecar 冷启动后先跑 `refresh`（约 1.75 秒），
    `minute` 只能排在后面；K 线 `cacheOnly` 和逐笔早就用 `priority=true` 插队了，
    分时没有。现在 `minute` / `five_day` 也插到队首。
- 新增 `src/renderer/src/lib/breadth.test.ts`：覆盖未 live 不启动、延迟/轮询、取消。

### 验证

- `npm run check` exit 0：**310 TS（31 文件）+ 163 Python（1 skipped）**；
- macOS 打包版从页面加载到分时图 `.chart-svg` 出现：
  **14,971ms → 3,015 / 2,895 / 2,971ms**（3 次；同一台机器、同一份状态、默认分时 tab）；
  开发构建另一次为 2,188ms；
- 残余：sidecar onefile 冷启动仍有 1.8~2.2 秒，偶发磁盘/解包抖动可到 8 秒；
  涨跌家数在首图出来后仍会占用后台 7.5 秒。本轮只打 tag、不重打/不发布 dmg（等 1.0）。

## [0.14.2] - 2026-11-02

### 变更

- **88 首屏本地优先**：有全量本地缓存时，打开软件先出图、先出逐笔，网络刷新随后进行。
  - K 线 `cacheOnly` 从独立 effect 移进 `createResource` 的 fetcher，**先读缓存、
    再发网络**；以前网络请求先发，本地读反而排在它后面。网络失败时直接用缓存
    渲染，不再把已经画出来的图替换成错误页。
  - 行情推送延迟 250ms 起步：把 sidecar 队列先让给图表缓存和逐笔归档；行情头
    继续用 `localStorage` 快照顶着，不再和首屏抢队列。
  - 主进程在创建窗口前 `warmTdxBridge()`，Python sidecar 启动与窗口加载并行，
    首屏缓存请求不再等进程冷启动。
  - `PushHub` 首帧不再受 `isVisible()` 影响：启动期窗口还没 show 时也取一次，
    之后窗口不可见才暂停拉取；逐笔首屏不会再被可见性判断挡住。

### 验证

- 开发构建首屏（从页面加载计时）：
  - 逐笔 **104ms**（0.14.1 为 2,793ms）；
  - 日 K 图 **370ms**（0.14.1 安装版为 3,256ms）；
  - 行情头用缓存快照即时显示，网络行情约 3 秒后接上；
- Windows 0.14.2 安装版：日 K **354ms**、逐笔 **210ms**（`v0.14.2`）；
  绿色包日 K **388ms**；便携版/zip 均启动 `v0.14.2`；
- Windows 0.14.2 构建时 `npm run check`：**299 TS（298 passed + 1 skipped）+
  162 Python（1 skipped）**；合入 macOS 专属修复后全仓库为 307 TS + 163 Python。

### Windows 产物（`release/0.14.2/`）

| 产物                                          |                    大小 | SHA256                                                             |
| --------------------------------------------- | ----------------------: | ------------------------------------------------------------------ |
| `pythontdx-0.14.2-setup.exe`                  |           133,616,877 B | `c2c8c5c2100c17c09941ebac19f0c80cf455e34e53aa42f237ea2fe45d328a49` |
| `pythontdx-0.14.2-portable.exe`               |           133,363,219 B | `e0df0f1249fcb7da522127e3215dbb6dca32beb22e5105a5db1811ed509b68c1` |
| `pythontdx-0.14.2-win-x64/`                   | 410,618,986 B / 76 文件 | —                                                                  |
| `pythontdx-0.14.2-win-x64.zip`                |           175,226,043 B | `957de83cb94c8d471b83c6b8cf45ec77948ccc1b4b3d997804670a0252d6a61a` |
| `win-x64/resources/app.asar`                  |             3,603,848 B | `34b952032e4b8a44e32b9fbe9e01065d28a443a0ad252d87d912c797dd4c0433` |
| `win-x64/resources/tdx-bridge/tdx-bridge.exe` |            21,522,944 B | `cd79fbc93731f2d2d9fa9517fc7af95a352b0209fb9f02f30e4f3a635b53ace3` |

`app.asar` 仍含 35,149 字节 GPL 文本与 `data:backup-progress`。

### macOS 产物（`release/0.14.2/`，2026-11-02 首次实机）

在 Apple Silicon（macOS 27.2）上拉到 0.14.2 后重新编译、打包并验收 arm64 dmg；
包内同时包含 macOS 专属修复：

- **7615 直连**：`python/tdx_f10.py` 忽略系统代理，避免公告/估值/财务/新闻 12 秒超时；
- **thin Mach-O 判定**：`before-pack.cjs` 按小端解析单架构 Mach-O，并校验目标架构；
- **arm64-only**：`electron-builder.yml` 固定 `arch: [arm64]`，x64 / universal 目标直接拒绝；
- **ad-hoc 签名**：`identity: '-'` 做整包签名，下载后是「无法验证开发者」而不是「已损坏」；
  `codesign --verify --deep --strict` 通过，`spctl -a` 仍拒绝（ad-hoc 不受信任）。

验证：`npm run check` **307 TS（30 文件）+ 163 Python（1 skipped）**；
`audit:data` **39/39**；`build:web` 为 `0.14.2-web`；从挂载的只读 dmg 启动，
12 秒内状态栏「实时」、4 个宽基指数有真实价格、版本 `v0.14.2`；
`app.asar` 含 35,149 字节 GPL 文本与 `data:backup-progress`；dmg `hdiutil verify` 通过。

| 产物                                            |              大小 | SHA256                                                             |
| ----------------------------------------------- | ----------------: | ------------------------------------------------------------------ |
| `pythontdx-0.14.2-arm64.dmg`                    |     150,207,843 B | `c307ddad0868278aaeb0c3b1bbfd9e4ae3932cf9e7506f52f071e2698717a8cd` |
| `mac-arm64/pythontdx.app`                       | 312 MB / 269 文件 | —                                                                  |
| `mac-arm64/.../Resources/app.asar`              |       3,601,698 B | `3e5d003bc74cc27fddf82285db51a0632155120a6d14a8001673bdea273a8751` |
| `mac-arm64/.../Resources/tdx-bridge/tdx-bridge` |      22,809,456 B | `3246bca1879607efc3244577c138e0eb3753f58cdb7133c7a2bf3bb6ce6868e6` |

边界：macOS 仅支持 Apple Silicon；ad-hoc 未公证，浏览器下载后需按 Release 说明
放行（`docs/07` 第三十五节）；macOS 包包含 Windows 0.14.2 没有的 7615 修复，
下次统一发版时应升版本后三平台重打。

## [0.14.1] - 2026-11-01

### 修复

- **87 逐笔「明细」首屏 10 秒延迟**（用户实测：已导入全量离线数据，默认股
  利元亨的右栏逐笔仍要等约 10 秒）。根因有三层，逐层修掉：
  - `PushHub` 在窗口不可见时按 **10 秒**重试；启动瞬间 `mainWindow.isVisible()`
    还是 `false`，逐笔订阅被跳过整整 10 秒。改为首次只等 **100ms** 复查，
    之后按正常节拍；隐藏窗口仍不拉行情。
  - `TdxBridge` 的请求队列是纯 FIFO，逐笔排在**历史 K 线/自选迷你图**后面，
    即使本地归档 10ms 能读完也要等前一个网络请求。队列新增 `priority`：
    `trades` 插到队首（不抢占已在途请求），仍保持一问一答。
  - `trades` 只有带 `date` 时才读 `lake/ticks`；默认「实时」永远走 MAC/7709。
    现在周末、或收盘后且归档就是当天时，无日期请求直接读**最近归档日**，
    不再重复拉上一交易日；盘中/午休仍走实时，避免把昨天当今天。

### 验证

- 开发构建实测首屏逐笔：**10,050ms → 2,543ms**（同一台机器、同一份 3.6GB
  归档；剩余约 2.5 秒是排在前面的首根 K 线请求，不是磁盘）；
- 新增测试：Python `latest_tick_archive`、收盘判定、无日期走归档；
  TS `PushHub` 首次 100ms 复查、`TdxBridge` priority 插队；
- `npm run check` exit 0：**299 TS（298 passed + 1 skipped，30 文件）+
  162 Python（1 skipped）**。

### Windows 产物（`release/0.14.1/`）

| 产物                                          |                    大小 | SHA256                                                             |
| --------------------------------------------- | ----------------------: | ------------------------------------------------------------------ |
| `pythontdx-0.14.1-setup.exe`                  |           133,616,783 B | `4cb57f756a50afe4caf70fd01b27206394f42d115b577eaae6b6c8cd3b07225d` |
| `pythontdx-0.14.1-portable.exe`               |           133,363,138 B | `a5c60bd7f609ca895ba6b28ef7f81d2d2be5dde78408d6ee06fed5e31d24ca30` |
| `pythontdx-0.14.1-win-x64/`                   | 410,618,773 B / 76 文件 | —                                                                  |
| `pythontdx-0.14.1-win-x64.zip`                |           175,226,221 B | `1c8e24f1e99debb1b4ca6572824a9c9c5ce9767bf088e161923cf49cb3b0f1fc` |
| `win-x64/resources/app.asar`                  |             3,603,635 B | `bd809f67dbc6f2b929f413ecc7b0151f0ed82381e317d6b98d403b8ec71f976e` |
| `win-x64/resources/tdx-bridge/tdx-bridge.exe` |            21,522,944 B | `2bc8973583956da653a45edbbb26a83d457938bb26530bc17f86c15d8aea5d24` |

实测：安装版启动 `v0.14.1`，首屏逐笔 **2,793ms**（同机 0.14.0 为 10,050ms），
静默卸载干净；绿色包 **2,508ms**；便携版/zip 均启动 `v0.14.1`；
`app.asar` 仍含 35,149 字节 GPL 文本与 `data:backup-progress` 通道。

## [0.14.0] - 2026-11-01

### 新增

- **86 离线数据备份/恢复进度条**：
  - Python sidecar 在扫描、写入、计算 SHA256、恢复阶段上报**真实字节数和文件数**
    （节流约 6 行/秒，避免逐 MB 刷屏）；`TdxBridge` 拦截结构化 stderr，
    经 IPC 推给数据工具；
  - 备份显示 `扫描 → 写入 → SHA256 → 完成`，恢复显示 `写入 → 完成`；
    未完成且尚无字节时用不确定进度动画，不伪造百分比；
  - 进度行显示已完成/总字节、文件数、百分比和当前文件；
  - 备份路径从只读文本改为可输入，仍保留「选择路径」对话框。
- **版本/许可证收口**：版本号升至 `0.14.0`（新增功能，minor）；
  `package-lock.json` 根包 license 从错误的 `MIT` 更正为 `GPL-3.0-or-later`。

### 验证

- `npm run check` exit 0：**296 TS（296 passed，29 文件）+ 158 Python（1 skipped）**；
- `npm run audit:data`：**39/39**；
- `npm run build:web` 通过，Web 版本为 `0.14.0-web`；
- 1.6 GB / 86 文件临时数据实测：开发构建备份 **59%**、恢复 **78%**；
- 最终 AppImage 实测备份 **38%**（600/1600 MB，31/82 文件），
  截图 `screenshots/backup-progress-0.14.0.png`；
- 最终 AppImage 和 deb 解包运行均为 `v0.14.0`，默认自选 4 个宽基指数；
- 两个包的 `app.asar` 均含 35,149 字节 GPL 文本和 `data:backup-progress` 通道；
- 备份/恢复的 Python 用例断言首尾进度事件、全部阶段和完成字节数。

### Linux 产物（2026-11-01 重出）

| 产物                                             |          大小 | SHA256                                                             |
| ------------------------------------------------ | ------------: | ------------------------------------------------------------------ |
| `pythontdx-0.14.0.AppImage`                      | 154,527,950 B | `cfdb83d72cf80b06d2a462abb78ba294409e592e396f82883160c8f69f030eb0` |
| `pythontdx_0.14.0_amd64.deb`                     | 128,643,080 B | `da30dcf5889f3f8fa33d94d1bbd217b9c407f6d71812b9a631a6f98a9d3bcb02` |
| `linux-unpacked/resources/app.asar`              |   3,600,781 B | `75348116140c45c0641fe18c8e2eb669623af93497c18b8a54a01133e5629c8e` |
| `linux-unpacked/resources/tdx-bridge/tdx-bridge` |  28,461,264 B | `2f5386ea8ba06834c66d087f659777c9c06fdd7c00d6d41d29b0159d9f90da5a` |

### Windows 产物（2026-11-01 重出）

Windows 10 x64 本机重打 0.14.0，补上备份/恢复进度条与项目 GPL 文本；
0.13.2 的 Windows 三件套生成于 LICENSE 修正之前，不包含这两项。

| 产物                                          |                    大小 | SHA256                                                             |
| --------------------------------------------- | ----------------------: | ------------------------------------------------------------------ |
| `pythontdx-0.14.0-setup.exe`                  |           133,618,790 B | `d9038bc0149b5bf8c6fe4419715bec908ce3ecfd26b9bb2f9c7c746ff656abd1` |
| `pythontdx-0.14.0-portable.exe`               |           133,365,164 B | `35806a2723ec4fce03b596748daa85e146b9690f56aeb748203d897675d539c5` |
| `pythontdx-0.14.0-win-x64/`                   | 410,613,669 B / 76 文件 | —                                                                  |
| `pythontdx-0.14.0-win-x64.zip`                |           175,224,319 B | `e76171a6f1a83f06269cd63c4921a761f03ad56fbbb0233fe833f0a3eca241db` |
| `win-x64/resources/app.asar`                  |             3,600,067 B | `4e1ceb7c6675a46360e076d08384f2add542dd370e9a821ee1b567892e7ab3d1` |
| `win-x64/resources/tdx-bridge/tdx-bridge.exe` |            21,521,408 B | `e394848216ed9a4f91548b6b0eb8d98150a8a9cda9cd6d5a192cdedabe01f439` |

实测：

- 静默安装 → 启动 `v0.14.0` → 静默卸载干净；
- `app.asar` 含 35,149 字节 GPL 文本（`3972dc97…`）与 `data:backup-progress` 通道；
- 1.0 GB / 29,446 文件：备份进度 **20%**（195.88/958.91 MB，6,271/29,446 文件），
  恢复进度 **16%**（156.70/958.91 MB，4,734/29,446 文件）；
- 绿色包、便携版、zip 解压后均启动 `v0.14.0`；便携版内嵌 asar 与绿色包同哈希；
- Windows 质量门禁：296 TS（295 passed + 1 skipped，`.sh` wrapper 用例在 Windows 跳过）
  - 158 Python；`audit:data` 39/39；`build:web` 为 `0.14.0-web`。

顺带修复（Windows 回归发现，不随包分发）：

- `scripts/data_audit.py` 按 Windows 默认 `cp936` 解码 sidecar 的 UTF-8 stdout，
  遇到中文即 `UnicodeDecodeError`，读线程挂掉后只报
  `'NoneType' object has no attribute 'strip'`；改为显式 `encoding="utf-8"` 后
  审计恢复为 39/39，失败原因也不再被吞掉。

### 修复（0.14.0 macOS 首次实机发现，已并入 0.14.2）

- **7615 不再被系统代理接管**：macOS 的 urllib 会读取系统代理，代理不转发 7615
  时公告/估值/财务/新闻全部 12 秒超时（本机配置了局域网 HTTP 代理；同一地址
  curl 直连 0.2 秒）。7709 是裸 TCP 不受影响，问题看起来很像「服务器慢」。
  `python/tdx_f10.py` 改用 `build_opener(ProxyHandler({}))` 直连；
  新增「坏代理仍直连」回归测试（159 Python）。
- **thin Mach-O 判定修正**：`scripts/before-pack.cjs` 原先用 `readUInt32BE`
  比较 `0xfeedfacf`，而单架构 Mach-O 的 magic 是小端 `cf fa ed fe`，永远不相等。
  系统自带二进制都是 universal 所以一直没暴露；Nuitka 产出 thin arm64 后
  macOS 打包必然报「不是 Mach-O」。改为按小端解析，并校验目标架构。
- **macOS 只交付 arm64**：2026-11-02 用户决定不需要支持 Intel；
  `electron-builder.yml` 把目标固定为 `arch: [arm64]`，`before-pack.cjs` 对
  x64 / universal 目标直接拒绝（实测强制 `--x64` 会以中文错误 exit 1），
  避免产出「x64 外壳 + arm64 sidecar」的坏包。删除 `build:mac:arm64` /
  `build:mac:x64` 两个脚本；`before-pack.test.mjs` 增加到 10 条测试（304 TS）。
- **下载后不再报「已损坏」**：`electron-builder.yml` 用 `mac.identity: '-'` 做整包
  ad-hoc 签名（`hardenedRuntime: false`）。`codesign --verify --deep --strict` 通过，
  包内含 `_CodeSignature/CodeResources`；浏览器下载后显示「Apple 无法验证」，
  可在系统设置里「仍要打开」，或 `xattr -dr com.apple.quarantine` 放行。
  `spctl -a` 仍拒绝，ad-hoc 不等于可信；彻底消除警告仍需 Developer ID + 公证。
  GitHub Release 的安装说明见 `docs/07` 第三十三节。

### macOS 产物（0.14.0 首次实机，历史；最终以 0.14.2 为准）

在 Apple Silicon（macOS 27.2）上构建 arm64 dmg；**ad-hoc 签名、未公证**，
本地可直接运行，浏览器下载后需按 Release 说明放行。版本仍为 0.14.0，
但包含上面的 7615 直连修复，与已发布的 Windows/Linux 0.14.0 包不是同一份运行代码。

| 产物                                            |              大小 | SHA256                                                             |
| ----------------------------------------------- | ----------------: | ------------------------------------------------------------------ |
| `pythontdx-0.14.0-arm64.dmg`                    |     150,201,054 B | `e06cad6ca3d798abd31b54e953de21eb6537921b8ad2fa0ed0fee0602722ce64` |
| `mac-arm64/pythontdx.app`                       | 312 MB / 269 文件 | —                                                                  |
| `mac-arm64/.../Resources/app.asar`              |       3,600,781 B | `75348116140c45c0641fe18c8e2eb669623af93497c18b8a54a01133e5629c8e` |
| `mac-arm64/.../Resources/tdx-bridge/tdx-bridge` |      22,809,456 B | `0821cbbd2c537426921d1a7d01d33826829a4e940b26c4ce3091905cda0de94d` |

实测：

- `npm run check` exit 0：**304 TS + 159 Python（1 skipped）**；`audit:data` 39/39；
  `build:web` 为 `0.14.0-web`；
- **ad-hoc 整包签名**：`codesign --verify --deep --strict` exit 0，
  `Identifier=com.pythontdx.app`、`Sealed Resources version=2`；`spctl -a` 仍拒绝；
- 从挂载的只读 dmg 启动：状态栏「实时」、4 个宽基指数有真实价格、版本 `v0.14.0`；
  截图 `screenshots/v0140-macos-dmg.png`；
- 7615 公告面板在系统代理开启时加载 100 条，截图
  `screenshots/v0140-macos-announcements.png`；
- lldb 断言红绿灯可见且 frame=`(18,16,14,14)`，`contentView` 1600×900 与窗口同高，
  渲染层 `padding-left: 84px`；原生红绿灯截图受 Screen Recording 权限限制；
- 包内 `app.asar` 与 Linux 0.14.0 同哈希，含 35,149 B GPL 与
  `data:backup-progress`；dmg `hdiutil verify` 通过。

## [0.13.2] - 2026-11-01

### 多股同列细化

- **79 刻度贴紧图**：分时/ K 线内部右侧留白 `RIGHT_PAD` 改为 2px；刻度列宽
  40/34 → **28/27px**，字号 6px，刻度与图之间的空白明显减半。
- **80 三道时间线**：分时只保留 **10:30 / 11:30 / 14:00** 三条淡色虚线，
  去掉 15:00；安装包内 9 格 × 3 条 = 27 条。
- **81 README 截图重拍**：
  - 主界面等待 25 秒，右下「明细」已刷出逐笔成交（`pythontdx-overview.png`）；
  - 多股同列换成 3 条时间线 + 紧凑刻度版本（`pythontdx-multi.png`）。

### 验证

- 安装包内 `multi-min__time` 27 条；分时刻度回读 `+1.53% / +0.76% / 0.00%`；
- 安装/绿色/zip 均启动 `v0.13.2`；
- `npm run check` exit 0：295 个 TS（Windows 构建时计数）+ 158 Python（1 skipped）；
- `npm run build:web` 通过。

### Linux 回归与修复（2026-11-01 晚）

- **82 Linux 质量门禁**：`npm run check` 通过 **296 TS（296 passed，29 文件）+
  158 Python（1 skipped）**；`npm run audit:data` **39/39**，`failures=[]`。
- **83 测试跨平台**：`test_client_roots_priority` 原先断言 Windows 反斜杠字符串，
  在 Linux 必失败；改为比较 `Path` 对象，同时保留「显式目录优先」的语义。
- **84 Web 版本号**：右下角原先写死 `v0.7.0-web`；改为构建时从 `package.json`
  注入（`v0.13.2-web`），补 `scripts/version.test.mjs` 防回归。
- **85 GPL 随包**：`electron-builder.yml` 的 `files` 加入 `LICENSE`；
  AppImage/deb 内现已包含 GPL-3.0-or-later 文本。Windows 0.13.2 三件套生成于
  本次修正之前，未包含该文件，重新分发前建议在 Windows 重打。

### Linux 产物（2026-11-01 重出）

| 产物                                             |          大小 | SHA256                                                             |
| ------------------------------------------------ | ------------: | ------------------------------------------------------------------ |
| `pythontdx-0.13.2.AppImage`                      | 154,495,808 B | `948326b1d6949ccf40b445f3849fdfe4e248913511db293f4b64f9a4f491e6ff` |
| `pythontdx_0.13.2_amd64.deb`                     | 128,615,816 B | `cc25801541488c8b5417d31d0e5e3e1071e2a5e86da46edadc3d39679bc46a23` |
| `linux-unpacked/resources/app.asar`              |   3,590,783 B | `6ce39af8d9b1caeeae0e39e1b269b3c762d6eff98b67ad8938585ef7412eb5fa` |
| `linux-unpacked/resources/tdx-bridge/tdx-bridge` |  28,436,688 B | `36fd04f21046705cc102f02e1ec4d106d2d42c07875eee98a64cfda802732e3e` |

实测：linux-unpacked / AppImage / deb 解包后均启动 `v0.13.2`；默认自选为
上证指数/深证成指/创业板指/科创50 四个指数；多股同列 9 格 × 3 条时间线 = 27 条，
右侧分时刻度为百分比；Web 截图版本 `v0.13.2-web`；AppImage/deb 的
`app.asar` 均含 35,149 字节 GPL 文本。

### Windows 产物

| 产物                           | 大小                    | SHA256                                                             |
| ------------------------------ | ----------------------- | ------------------------------------------------------------------ |
| `pythontdx-0.13.2-setup.exe`   | 133,584,157 B           | `213ad8df929b3e71531a3538c2fa13a1f2904e0358938ae6a4b34a7591d1f3c8` |
| `pythontdx-0.13.2-win-x64/`    | 410,558,397 B / 76 文件 | —                                                                  |
| `pythontdx-0.13.2-win-x64.zip` | 175,550,129 B           | `0f2004515fd4b25b4953ea295f7d6f0ea69ce400cf604062738591e7e0e56d42` |

## [0.13.1] - 2026-11-01

### 多股同列对齐官方界面

- **顶部数据行**：每格补 `名称/周期/现价/涨跌幅/涨跌额/现量/换手/量比/均价`；
  9 只额外批量取一次 MAC 报价补 `量比/换手/均价`（7709 快照没有量比）。
- **右侧刻度**：分时只显示百分比（以昨收为中心对称，0.00% 居中）；
  K 线只显示价格；刻度宽度压缩到分时 40px、K 线 34px，减少占用。
- **四道时间线**：分时在 10:30 / 11:30 / 14:00 / 15:00 画淡色虚线。
- **布局收紧**：九宫格 gap 8→5px，卡片 padding 10×12→4×6px，
  名称/数据行字号与行高下调，图表区域变大。
- 新增 `multi-official.png`、`multi-kline-official.png` 验收截图。

### 验证

- 安装包内分时刻度回读：`["+1.53%","+0.76%","0.00%","-0.76%","-1.53%"]`，9 个数据行；
- 安装/绿色/zip 均启动 `v0.13.1`；
- `npm run check` exit 0：295 个 TS（294 passed + 1 skipped）+ 158 Python（1 skipped）；
- `npm run build:web` 通过。

### 产物

| 产物                           | 大小                    | SHA256                                                             |
| ------------------------------ | ----------------------- | ------------------------------------------------------------------ |
| `pythontdx-0.13.1-setup.exe`   | 133,577,501 B           | `e81f536be5f3a1522ac2698b1498a57797db11e6fbdc40067542fcf754acea12` |
| `pythontdx-0.13.1-win-x64/`    | 410,557,595 B / 76 文件 | —                                                                  |
| `pythontdx-0.13.1-win-x64.zip` | 175,550,392 B           | `63b96b27fa3105480144368636923670208ad540d13bf1742789ff7a6bd9625a` |

## [0.13.0] - 2026-11-01

### 代码整理 / 审计 / 文档

- **74 清理死代码**：
  - 删除已不再使用的 `BoardsPanel.tsx`、`createServerWindow()`、`window:servers` IPC、
    `openServers()` 预加载桥、`PYTHONTDX_CAPTURE_SERVERS` 截图分支；
  - 删除 `.boards-*`、`.market__pager`、`.dragon__pager`、`.watch-full__pager`、
    `.market__kind` 等无引用 CSS；
  - `ServerWindow` 收敛为主窗口弹层组件，`onClose` 必填，支持 Esc 关闭；
  - `main.tsx` 只保留主窗口与独立分时图两条渲染路径。
- **75 代码审计/缺陷修复**：
  - 发现并修复全市场报价的竞态：切换 tab/搜索且已滚动加载 >200 行时，
    旧请求未被 `requestId` 作废，可能把上一批报价追加到新列表；
    现在 key 变化时先 `requestId += 1`；
  - 复核 `npm run check`、`build:web`、数据校验/备份恢复测试；
  - 残留的 `BoardsPanel` 删除后，`macBoards` 数据接口仍被
    `board-categories.ts` 使用，已保留。
- **76 README 重写**：
  - 重新截取主界面、多股同列、全市场、排行、板块、F10、数据报告 7 张图；
  - 按「界面 → 定位 → 功能 → 快速开始 → 架构 → 数据边界 → 目录 → 文档」重排；
  - 删除 4 张过期截图，README 中的版本、测试数、F10 宽度、滚动交互同步到 0.13。
- **77 版本/发布**：版本号 0.13.0，打 `v0.13.0` tag，推送 GitLab 与 GitHub。

### 验证

- 安装包内：服务器弹层 560×680、顶部板块按钮 0 个（`v0130-server.png`）；
- 安装/绿色/zip 均启动 `v0.13.0`；
- `npm run check` exit 0：295 个 TS（294 passed + 1 skipped）+ 158 Python（1 skipped）；
- `npm run build:web` 通过。

### 产物

| 产物                           | 大小                    | SHA256                                                             |
| ------------------------------ | ----------------------- | ------------------------------------------------------------------ |
| `pythontdx-0.13.0-setup.exe`   | 133,575,964 B           | `90096e7f9c38e153c478ee52475cc19ff7c1b1d1a6dcb49f7956af57694f24b1` |
| `pythontdx-0.13.0-win-x64/`    | 410,548,134 B / 76 文件 | —                                                                  |
| `pythontdx-0.13.0-win-x64.zip` | 175,546,126 B           | `50ee5fbe1a4a3d463e26e9e3eea7e438c53f9a2664d7018399b914ff61e28c5b` |

## [0.12.0] - 2026-11-01

### 新增

- **73 自选 / 自定义按添加顺序 + 拖动排序**：
  - 自定义板块去掉按涨跌幅排序，`customRows` 直接按 `group.items` 顺序；
  - 自定义板块的每一行支持 HTML5 拖拽，调用 `moveWatchItem` 落盘；
  - 自选股行本来已有拖拽，多股同列直接读 `group.items`，两者顺序一致；
  - 多股同列九格卡片也可以直接拖动排序，落点按 `page*9 + index` 写回分组，
    九格按新顺序重铺；拖动不影响点击切主图。
  - 拖动反馈：拖动源半透明，目标行上/下沿高亮，卡片目标描边。
- 自选股原本就是插入顺序，本轮保持不变；自定义板块现在与它一致。

### 验证

- 多股同列拖拽实测：第 1 张拖到第 3 张，顺序由
  `上证指数 / 深证成指 / …` 变为 `深证成指 / 上证指数 / …`，再拖回恢复；
- 安装包内 `.multi-card[draggable=true]` 9 个、`.watch-row[draggable=true]` 11 个；
- 安装/绿色/zip 均启动 `v0.12.0`；
- `npm run check` exit 0：295 个 TS（294 passed + 1 skipped）+ 158 Python（1 skipped）；`build:web` 通过。

### 产物

| 产物                           | 大小                    | SHA256                                                             |
| ------------------------------ | ----------------------- | ------------------------------------------------------------------ |
| `pythontdx-0.12.0-setup.exe`   | 133,582,065 B           | `42ce0dabf74158159f60e776f2f4c8c6e0e3bbadc17aa41be2bd6174458b9150` |
| `pythontdx-0.12.0-win-x64/`    | 410,556,436 B / 76 文件 | —                                                                  |
| `pythontdx-0.12.0-win-x64.zip` | 175,549,217 B           | `1cf7163684c2be6ed24e18c42df7cda62198287f0b340cca2fb9654820e901fb` |

## [0.11.2] - 2026-11-01

### 修复 / 新增

- **69 离线数据校验进度条**：数据工具「统计与校验」执行时显示进度条 + 已等待秒数，
  不再只有按钮文字；统计完成后继续显示校验阶段进度。
- **70 行情服务器再收窄**：弹层 760×700 → **560×680**（比 760 窄约 26%），
  主机/延迟/状态三列仍完整，长路径允许折行。
- **71 排行迷你走势图（真正的根因）**：排行 `<tr>` 一直缺少 `data-code`，
  滚动补图用的 `tbody tr[data-code]` 选择器永远选不到行，所以只有加载器初始的 20 张。
  补上后：滚动 700px 时排行走势图 **21 → 40 张**，安装包内实测 **69 张 / 11 空位**。
- **72 离线备份恢复改为全量覆盖**：
  - `backup_restore` 不再跳过本地已存在的同名文件；
  - 先写 `.part`，再用原子替换覆盖，返回 `restored / overwritten / skipped`；
  - 备份里没有的本地文件保留，不删除本机多出来的数据；
  - Python 测试改为断言「本地已改文件会被备份内容覆盖」；
  - UI 恢复说明与结果同步（新补 / 覆盖 / 跳过）。

### 验证

- 安装包内排行滚动 700px：69 张走势图、11 个空位（`v0112-rank.png` 运行回读）；
- 服务器弹层 560×680（`v0112-server.png`）；
- 校验进度条（`data-progress2.png`：1.0s 时进度条已推进）；
- 0.11.2 安装/绿色/zip 均启动；
- `npm run check` exit 0：295 个 TS（294 passed + 1 skipped）+ 158 Python（1 skipped）；`build:web` 通过。

### 产物

| 产物                           | 大小                    | SHA256                                                             |
| ------------------------------ | ----------------------- | ------------------------------------------------------------------ |
| `pythontdx-0.11.2-setup.exe`   | 133,581,496 B           | `f77bbddd7e8cc860a236892486a255f8c6410f3c53edb13211c7137c21bb082b` |
| `pythontdx-0.11.2-win-x64/`    | 410,548,762 B / 76 文件 | —                                                                  |
| `pythontdx-0.11.2-win-x64.zip` | 175,547,024 B           | `ca15e225d9dccdc5e2a006df7f001eb0a8168f31b0ae00257999282521dff055` |

## [0.11.0] - 2026-11-01

### 新增 / 修复

- **64 行情服务器收窄**：弹层 980×760 → **760×700**，主机/延迟/状态三列更紧凑。
- **65 排行迷你走势图**：滚动处理里「触底判断」在补图之前就 return，导致只有顶部 20 张；
  现在先 `requestVisibleSparklines` 再判断加载更多。市场滚动 900px 后 20→40 张，
  排行滚动 700px 后 21 张可见图正常补齐。
- **66 离线数据统计 + 全量校验报告**（数据工具 → 本地离线数据）：
  - 新增 `data_coverage` IPC/HTTP：9 类数据集文件数、大小、日期覆盖；
  - 新增 `data_integrity` IPC：逐份校验 kline / tick / 竞价 / F10 / 资金流 / 服务器文件
    的 manifest + SHA256；
  - 校验上限从 200/500 提高到 100000，**实测 10,001 份全部校验**；
  - 报告含六目录总量（26,500 文件 / 166.60 MB）、9 项覆盖、6 项校验结果、异常明细；
  - 可「导出报告」为 JSON；通过显示绿色，异常显示红色。
- **67 去掉顶部「板块」按钮**：与左侧「板块/概念」重复，入口和 BoardsPanel 渲染一并移除，
  只保留左侧栏。
- **68 龙虎榜 / 全屏自选改滚动**：
  - 龙虎榜 2404 条全部滚动显示，删除上一页/下一页；
  - 全屏自选最多 40 只全部网格滚动，删除分页；
  - 全局 grep 已无「上一页/下一页」。

### 验证

- 安装包内：统计+校验报告 10,001 份、0 失败（`v0110-report.png`）；
  服务器弹层 760px、顶部板块按钮 0 个（`v0110-server.png`）；
- 开发态：`data-report3.png`、`dragon-scroll.png`（2404 行无分页）、
  `watch-scroll.png`（11 只全显示）、`rank-sparks.png`；
- 安装/绿色/zip 均启动 `v0.11.0`；
- `npm run check` exit 0：295 个 TS（294 passed + 1 skipped）+ 158 Python（1 skipped）；`build:web` 通过。

### 产物

| 产物                           | 大小                    | SHA256                                                             |
| ------------------------------ | ----------------------- | ------------------------------------------------------------------ |
| `pythontdx-0.11.0-setup.exe`   | 133,584,233 B           | `5322c8ba0fba03fd7172d69d01439e156710fbbe16981bc79aba7eb3598337e9` |
| `pythontdx-0.11.0-win-x64/`    | 410,549,293 B / 76 文件 | —                                                                  |
| `pythontdx-0.11.0-win-x64.zip` | 175,547,010 B           | `d84bd5923c256c205e3b869637c567d85610159690f90347de23d48abc7df6c5` |

## [0.10.2] - 2026-11-01

### 修复

- **63 行情服务器不再另开系统窗口**：标题栏「行情」改为在主窗口内打开
  `server-backdrop + server-shell` 弹层（980×760），不再出现「系统标题栏 + 页面标题」
  两层框和两个关闭按钮；现只有一个右上角 ×，点遮罩也可关闭。
- `ServerWindow` 保留 `onClose` 注入，未传时仍兼容 `window.close()`；
  独立窗口代码未删除，但主入口已不再调用。

### 验证

- 开发态：`server-shell` 980×760、`.server-page__close` 数量 1（`server-modal.png`）；
- 安装包内同样 980×760、1 个关闭按钮（`v0102-server.png`）；
- 安装/绿色/zip 均启动 `v0.10.2`；
- `npm run check` exit 0：295 个 TS（294 passed + 1 skipped）+ 158 Python（1 skipped）；`build:web` 通过。

### 产物

| 产物                           | 大小                    | SHA256                                                             |
| ------------------------------ | ----------------------- | ------------------------------------------------------------------ |
| `pythontdx-0.10.2-setup.exe`   | 133,578,435 B           | `ce4cf72c502964c6aaec14a9b367dafb9e5a00a4b10d874afe9832c427d90219` |
| `pythontdx-0.10.2-win-x64/`    | 410,546,610 B / 76 文件 | —                                                                  |
| `pythontdx-0.10.2-win-x64.zip` | 175,548,540 B           | `c5802f3cb50d829dcca135113729257ad4a814eac86542a259ce840f50b1e5d2` |

## [0.10.1] - 2026-11-01

### 修复

- **61 行情服务器窗口布局**：根因是 0.9.8 给 `#root` 加了 1180px 最小宽度，
  独立窗口（行情服务器 900×720、独立分时图）也被撑到 1180，出现大片空白与横向滚动条。
  现在 `main.tsx` 给 `<html>` 标记 `data-window`，只有主窗口套最小尺寸；独立窗口不限制。
- **62 滚动后迷你走势图刷不出来**：走势图加载器原来只预载前 20–80 只；
  现在改为全局可见行队列：
  - 初始只拉前 20 只；
  - 表格滚动时按 `tbody tr[data-code]` 的视口范围补拉；
  - 市场/板块/排行三张表都接同一套逻辑。
    实测市场滚动 900px 后走势图从 20 张增至 40 张，并随滚动继续补。

### 验证

- 安装包内行情服务器窗口 900×720 无横向滚动（`v0101-server.png`）；
- 市场滚动探测 20 → 40 张走势图（`spark-probe2.png`）；
- `npm run check` exit 0：295 个 TS（294 passed + 1 skipped）+ 158 Python（1 skipped）；`build:web` 通过。

### 产物

| 产物                           | 大小                    | SHA256                                                             |
| ------------------------------ | ----------------------- | ------------------------------------------------------------------ |
| `pythontdx-0.10.1-setup.exe`   | 133,584,360 B           | `e6e55f46d3ee5d49d37d67a39c484d62566cb29d98cda865c6556dbf87d59b7e` |
| `pythontdx-0.10.1-win-x64/`    | 410,544,611 B / 76 文件 | —                                                                  |
| `pythontdx-0.10.1-win-x64.zip` | 175,548,032 B           | `4a53a9cb9ea5aeb674f77adb6d93767ccdf5aada71c7b5677937878ea5ad587e` |

安装/绿色/zip 均启动 `v0.10.1`。

## [0.10.0] - 2026-11-01

### 修复

- **58 分时固定全天**：九格分时横轴固定 240 个交易分钟，数据到了线才往前延伸；
  分时模式忽略 ↑↓，标题显示「分时全天」，不再按 60 点缩放。
- **59 F10 加宽 10%**：960 → **1056px**；16 个页签实测内容区 854px，
  `scrollWidth = clientWidth`，无横向滚动。
- **60 名称列收紧**：市场 200→110、板块 130→100、排行 120→90；
  名称列不再留出大片空白，指标列整体左移。

### 验证

- 16 页签横向溢出巡检：全部 854/854（`f10-overflow.png` 的运行回读）；
- 市场名称收紧：`market-name-tight.png`；分时全天：`multi-minute-fixed.png`；
- 安装包内 F10 1056、内容 854 无溢出（`v0100-f10.png`），多股分时全天 2160 根量柱（`v0100-multi.png`）；
- `npm run check` exit 0：295 个 TS（294 passed + 1 skipped）+ 158 Python（1 skipped）；`build:web` 通过。

### 产物

| 产物                           | 大小                    | SHA256                                                             |
| ------------------------------ | ----------------------- | ------------------------------------------------------------------ |
| `pythontdx-0.10.0-setup.exe`   | 133,583,052 B           | `58c9d294cc5715bdc77ba85ac3ea136fc68c3c8003f466ae008aa77dc0b138a2` |
| `pythontdx-0.10.0-win-x64/`    | 410,543,022 B / 76 文件 | —                                                                  |
| `pythontdx-0.10.0-win-x64.zip` | 175,549,062 B           | `c372cf3420ee4a11ced574e0fbfa5b0eb592ae851bf947e99b9e026d7e45ba89` |

安装/绿色/zip 均启动 `v0.10.0`。

## [0.9.9] - 2026-11-01

### 修复 / 优化

- **53 多股同列默认分时**：打开即分时，不再先显示日 K；日/周/月等周期仍可切。
- **54 分时均价重算**：主站 `avg` 字段是差分编码、口径不一致；九格分时改用
  「累计成交额 / 累计成交量」重算 VWAP，均价线随价格与量变化。
- **55 去掉市场/类型列**：全市场、板块、排行三张表删除「市场」「类型」两列，
  代码/名称/数值列更紧凑，腾出的宽度留给指标列。
- **56 最新提示最后一行混排**：`├──┴──┴──┤` 这类只有 ┴、没有 ┼ 的跨列框线
  先收表；单列框线里的段落保留换行，不再被并进「最新指标变动原因」一行。
  解析测试 20 → 21。
- **57 F10 再收窄**：1240 → **960px**（约 -23%），财务分析 7 列表仍无横向溢出，
  正文行长更接近阅读宽度。

### 验证

- 安装包内：F10 960px、内容区 758px 无溢出（`v099-f10.png`）；多股默认分时（`v099-multi.png`）。
- 开发态：F10 最新提示分行（`f10-tips-fix.png`）、财务分析 960（`f10-fin-960.png`）、
  市场 20 列（`market-no-type.png`）、多股默认分时（`multi-default-minute.png`）。
- `npm run check` exit 0：295 个 TS（294 passed + 1 skipped）+ 158 Python（1 skipped）；`build:web` 通过。

### 产物

| 产物                          | 大小                    | SHA256                                                             |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `pythontdx-0.9.9-setup.exe`   | 133,584,090 B           | `40f7511705b4bad635be7cd497e38410cf003a86f312b111f76871dd9ffc5f82` |
| `pythontdx-0.9.9-win-x64/`    | 410,542,891 B / 76 文件 | —                                                                  |
| `pythontdx-0.9.9-win-x64.zip` | 175,548,910 B           | `d1c56436be9d184cf9642c7b5feb0686d6afd5d404bba179987bd78abdf29440` |

安装/绿色/zip 均启动 `v0.9.9`。

## [0.9.8] - 2026-11-01

### 修复 / 优化

- **45 多股同列焦点框**：格子与周期按钮的 focus/hover 不再画蓝框，只留轻微背景变化。
- **46 恢复分时**：九宫格每格可用「分时」周期，显示价格线 + 均价线 + 昨收基准 + 分钟量；
  仍与其它周期共用 ↑↓ 缩放（只显示最近 N 个点）。
- **47 多股翻页**：自选/自定义超过 9 只时按 9 只一页，标题栏 `‹ 1/2 ›`，
  左右方向键也能翻页；点击卡片仍切主图。
- **48 全市场列表列**：
  - 补齐 11 个附加列：今开/最高/最低/昨收/成交量/均价/振幅/涨停/跌停/总市值/流通市值；
  - 代码列改为**左对齐**，表头与内容同字体/同起点；
  - 报价改用 `mac_quotes_finance`，总市值/流通市值有值；
  - 均价/振幅缺字段时按成交额/最高最低补算。
- **49 板块/排行对齐**：两表复用同一组附加列，列宽与全市场一致；板块左侧栏 184px，
  排行 #/代码列更紧凑。
- **51 滚动优先**：
  - 全市场去掉上下翻页，改为**滚动加载**（初始 200 行，滚到底 +200）；
  - 排行榜滚到底自动追加，不再需要点「加载更多」；
  - 默认 1600×900 下三张表均无横向滚动条。
- **52 F10 收窄**：从 96vw 改为 **1240px × 88vh** 居中，正文不再左右拉得太开；
  实测内容区 1038px，无横向溢出。
- **50 窗口缩放**：`#root` 最小 1180×680，窗口更小时出现滚动条，不再压缩布局。

### 验证

- 全市场滚动：滚动后 400 行（`market-scroll.png`）；
- 多股：分时 9 格（`multi-minute2.png`）、翻页 1/2→2/2（`multi-page1.png`、`multi-page2.png`）；
- 三张表：`layout-market6.png`、`final-block.png`、`final-rank.png`；
- F10 收窄：`f10-narrow.png`；
- 安装包内 F10 1240px（`v098-f10.png`），`v0.9.8` 版本（`v098-ver.png`）。

### 产物

| 产物                          | 大小                    | SHA256                                                             |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `pythontdx-0.9.8-setup.exe`   | 133,577,401 B           | `bb2bc8807bc9c892e233cea78dd933a0e25dc62ff7648ddfd8bf7dc50c65651b` |
| `pythontdx-0.9.8-win-x64/`    | 410,544,141 B / 76 文件 | —                                                                  |
| `pythontdx-0.9.8-win-x64.zip` | 175,549,950 B           | `83dc220a82f7584f86bb827becdd2d5395eb6ce35d5d51be63469d7f2dc92233` |

安装/绿色/zip 均启动 `v0.9.8`；`npm run check` exit 0：294 个 TS（293 passed + 1 skipped）+ 158 Python。

## [0.9.6] - 2026-11-01

### 新增 / 优化

- **41 多股同列改成固定 3×3 真 K 线**：
  - 每格都是蜡烛图 + 成交量 + MA5/10/20，不再是收盘价折线；
  - 九张图共用一个可见根数，**↑ 放大 / ↓ 缩小**，窗口级监听，不需要先聚焦某一张；
  - 窗口右贴最新一根 K 线，右侧始终是最新时间；
  - 周期只放基础档：日/周/月/60/30/15/5/1 分；
  - 3×3 铺满 96vw×92vh 面板，点击卡片照旧切主图。
- **42/44 列表布局统一**：全市场、板块、排行榜改成固定列宽 + 居中表格：
  - 代码 86 / 名称 170 / 市场 54 / 类型 64 / 数值列 62–96 / 走势 58；
  - 行高 36px，表头与内容同一套对齐，代码等宽、名称左对齐、数值右对齐；
  - 表格宽度：市场 1000px、板块 900px、排行 1000px，居中不再把空隙摊到每列之间。
- **43 排行榜列补齐**：代码、名称、市场、现价、涨幅、成交额、换手、量比、涨速、走势；
  0x054b 缺失的量比用一次 MAC 批量报价补齐（只补空值，同一批代码只补一次）。

### 验证

- 多股同列 9 格 / 9 张 K 线；↑↑ 后标题显示「40 根」，60 分周期切换成功（`multi-kline.png`、`multi-zoom.png`、`multi-60m.png`）；
- 安装包内多股同列 9 格真 K 线正常（`v096-multi.png`）；
- 市场/板块/排行三张列表截图：`layout-market3.png`、`layout-block2.png`、`layout-rank3.png`；
- `npm run check` exit 0：294 个 TS（293 passed + 1 skipped）+ 158 Python；`build:web` 通过。

### 产物

| 产物                          | 大小                    | SHA256                                                             |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `pythontdx-0.9.6-setup.exe`   | 133,573,567 B           | `459fe50bd660c654f6544b6dbf0d29f371f2ca2d742f80d62291e168666ff990` |
| `pythontdx-0.9.6-win-x64/`    | 410,518,089 B / 76 文件 | —                                                                  |
| `pythontdx-0.9.6-win-x64.zip` | 175,544,168 B           | `5ccdf0d9f6d93cb85f4c2e2922372e50d9a62b3032bf36fe9f649739b4a7d4cc` |

安装/绿色/zip 均启动 `v0.9.6`；安装包内多股同列 3×3 验证通过。

## [0.9.5] - 2026-11-01

### 修复

- **34/35 实数据终于跑通**：0.9.4 的板块/全市场列表默认走 7709 快照，快照没有量比/涨速，
  且请求排在分时队列后面时容易超时。现在两处都改用 **MAC 批量报价**：
  - 全市场列表默认排序也能显示量比、涨速、迷你走势图；
  - 板块成分股同样显示量比、涨速、走势图。
- 实测 0.9.5 安装包：全市场列表 100 行全部有现价/涨跌幅/成交额/换手/量比/涨速/走势；
  板块「银行」42 只全部有量比/涨速/走势（`v095-market.png`、`block-final.png`）。
- 计划中的 V11（34/35 待实时数据复验）已可关闭。

### 工程

- 版本 0.9.5；Windows 三件套重建并实机验收。
- `npm run check` exit 0：294 个 TS 测试（293 passed + 1 skipped）+ 158 Python（1 skipped）。

### 产物

| 产物                          | 大小                    | SHA256                                                             |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `pythontdx-0.9.5-setup.exe`   | 133,576,232 B           | `3dc5824876ab439a96928c3cc10ae1f58d4b0027cacb8dee0fe0a8e5b317457d` |
| `pythontdx-0.9.5-win-x64/`    | 410,495,551 B / 76 文件 | —                                                                  |
| `pythontdx-0.9.5-win-x64.zip` | 175,539,117 B           | `f42417b4b19544de4dd587ee466d16f358c83af0e3b72b69bd78d95b31116d1d` |

安装包内市场列表 100 行完整（`v095-market.png`）；安装/绿色/zip 均显示 `v0.9.5`。

## [0.9.4] - 2026-11-01

这一版按用户 32–40 条验收清单收尾，重点是「看更多的股票信息」和 F10 排版。

### 新增 / 调整

- **32 多股同列**：6/9/12 格（12 格 4×3），标题栏下拉可选「自选」或任一自定义板块；
  面板放大到 96vw×92vh，12 格完整显示。
- **33 板块/概念窗口分类补全**：从 5 类扩到 7 类（一级行业、二级行业、通达信行业、
  概念、风格、指数板块、一般），与左栏板块选择器共用 `lib/board-categories.ts`。
- **34 板块成分股列对齐全市场**：补换手、量比、涨速、走势列；走势图固定 46px 右对齐。
- **35 全市场列表**：新增迷你走势图列（46px 右对齐），按当前页前 30 只排队加载。
- **36 二级窗口统一放大**：F10/板块/市场/排行榜/公告/复盘/公式/异动/龙虎榜/板块选择器
  等 15 个「看股票」的窗口统一 `--panel-w/--panel-h`（96vw/92vh，再减遮罩内边距防裁切）；
  设置、数据管理这类表单窗口保持原尺寸。
- **37 自选与自定义多对多**：同一只股票可以同时属于自选和多个自定义板块；
  组内排序只改目标组；星标只代表「在自选」；新增 4 个 store 测试。

### F10（38）

- 新增 `PYTHONTDX_CAPTURE_SERIES`：一次启动遍历 16 个页签、各截顶部/底部（32 张），
  用于逐页审计。
- 修复假章节标题：`★本栏包括…` 折行里的【5.xxx】【9.xxx】不再当标题（6 个页面受影响）。
- 框线表折行：名称跨行、经营范围/控股关系按列续字、多单位表头并回对应列。
- 公司概况键值表改 label/value 布局，长英文不再把右侧键名挤成竖排。
- 金额列支持亿/万/元/股/手后缀；经营分析的分段小表并回同一表头（14 张碎片 → 6 张表）。
- 公告：摘要表按行挂 URL（整行可点、↗ 标记）；明细多于摘要时删摘要保留完整明细；
  去掉「公告详情请查看附件」和重复标题。利元亨实测 45 条公告 / 45 个链接 / 0 重复。
- 普通数据表后面的新闻链接不会被误判成公告明细（首列必须是日期）。

### 工程（39 / 40）

- F10 解析拆成 `f10/{model,tables,links,parse}.ts` 四层，`f10.ts` 只做 re-export；
  `docs/02` 增加模块职责表。
- `fetchQuotes`：单次 refresh 5s 超时、超时杀 sidecar 重启；7709 无数据时退到 MAC 报价。
- 审计修复：断线表首列日期守卫、组内排序保持其它分组、面板窄窗口防裁切。
- `npm run check` exit 0：294 个 TS 测试（293 passed + 1 skipped）+ 158 Python（1 skipped）；
  `npm run build:web` 通过。

### 产物（2026-11-01 实机）

| 产物                          | 大小                      | SHA256                                                             |
| ----------------------------- | ------------------------- | ------------------------------------------------------------------ |
| `pythontdx-0.9.4-setup.exe`   | 133.6 MB（133,576,539 B） | `06c8e9e338f558dd1fcf17f2668aeeb60d043b6e58605c976dde7fafe9d25106` |
| `pythontdx-0.9.4-win-x64/`    | 410.5 MB / 76 文件        | —                                                                  |
| `pythontdx-0.9.4-win-x64.zip` | 175.5 MB（175,539,157 B） | `d62e11fcb6e6237d0db59a56ead75aabbdca990b06c584f19bfbced58da9d17c` |

- 安装包静默安装 → 启动 `v0.9.4`，F10 公司概况 24 行键值正常 → 静默卸载干净；
- 绿色包 / zip 均启动并显示 `v0.9.4`（`v094-green.png`、`v094-zip.png`）。

**已知外部限制**：验收时本机 7709 行情刷新持续超时（MAC 也间歇失败），
所以 34/35 的「量比/涨速/走势图」在截图里多为 `—`；列结构、对齐与兜底逻辑已就绪，
等数据源恢复后可直接复验。F10/多股同列/窗口尺寸不依赖实时行情，已完整验收。

## [0.9.3] - 2026-11-01

### 修复

- **左栏再加密（用户反馈 #28）**：行高 42→38px（内边距 5→4、行高 1.2→1.15、
  迷你图 22→20px），同样高度可再多看约 2 行；三栏保持同一套网格。
- **自定义下拉多余占位（用户反馈 #29）**：去掉「选择自定义板块…」item，
  下拉里只列用户自建的板块；没有自定义板块时才显示一条禁用提示「暂无自定义板块」。
- **移除专注模式（用户反馈 #30）**：删掉图表头「专注」按钮、F 快捷键、Esc 退出逻辑、
  `.app--focus` 样式与帮助里的说明；需要沉浸式看图可用系统全屏（F11）或收起侧栏。
- **F10 剩余段落排版 + 链接（用户反馈 #31）**：
  - 新增「空格对齐表」解析（表头 + `───` 分隔线），覆盖股东研究下半段、高管治理、
    资金动向、经营分析、行业分析；数据行按 token 对齐，折行续字按行首缩进归列，
    表头折行产生的「(万股)/(万元)/(%)」单位行并回表头；
  - 「退出前十大股东」这类无表头列表也能成表；
  - 公告/报道正文里的附件 URL 变成可点击链接，点击后用系统浏览器打开
    （`api.app.openExternal`）；
  - 仍无法结构化的多行表头段落退化为等宽正文（`--mono`），保证列不散。
  - 解析测试从 5 个增加到 8 个（空格表 / 无表头列表 / URL）。

### 工程

- 版本升到 `0.9.3`；Windows 三件套重新打包并实机验收，见 `docs/07` 第十四节。
- `npm run check` exit 0：278 个 TS 测试（277 passed + 1 skipped）+
  158 个 Python 测试（1 skipped）。

### 验证（2026-11-01，Windows 10 x64 实机）

| 产物                               | 大小                      | SHA256                                                             |
| ---------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| `pythontdx-0.9.3-setup.exe`        | 133.6 MB（133,570,841 B） | `af1c2d4559acd8c49f961422b8fd301d94239e74d81f27cdaa2ea6c262c56870` |
| `pythontdx-0.9.3-win-x64/`（散装） | 410.5 MB（410,474,379 B） | —                                                                  |
| `pythontdx-0.9.3-win-x64.zip`      | 175.5 MB（175,531,800 B） | `f6f89778fb04c7c104f7c85d95b3e7fb5466b7cc5eb543d4154eac4bef688cc2` |

- 安装包静默安装 → 启动显示 `v0.9.3`（`screenshots/v093-installed.png`）→ 静默卸载干净；
- 绿色包 / zip 解压均启动并显示 `v0.9.3`（`v093-green.png`、`v093-zip.png`）；
- 界面：行距 `rows-dense.png`、下拉项 `custom-noplaceholder.png`、
  F10 股东下段 `f10-holder-lower.png`、高管 `f10-exec-after.png`、
  机构 `f10-inst-lower.png`、资金动向 `f10-flow.png`、公告链接 `f10-notice-after.png`。

## [0.9.2] - 2026-11-01

### 修复

- **F10 页面排版（用户反馈 #24）**：0x02d0 返回的是固定宽度文本，之前只用
  `/<pre>/` 显示、表格识别只认 ASCII `|`，而实际主站用的是 `│`（U+2502），
  于是财务/公司概况整页都是错位的「竖线+空格」；中文宽字符一多列就全歪。
  现在把解析器抽到 `src/shared/f10.ts` 的 `parseF10`：按 `│/┃/｜/|` 切列、
  合并折行、去掉框线、识别 `【标题】`、按列内容判定数字右对齐；
  渲染层改成「标题 + 真实表格 + 正文」三段式，表格有斑马纹/hover/圆角边框，
  正文用界面字体 1.8 行高。新增 5 个解析测试（`src/shared/f10.test.ts`）。
  深色/浅色、最新提示/公司概况/财务分析三个页面都截图核对。
- **左栏行距过大（用户反馈 #25）**：三栏行高从 55px 压到 42px（区块内边距
  8→5、行高 1.25→1.2、迷你图 24→22px、行间距 2→1px），同样的侧栏高度
  从约 12 行增加到约 15 行；名称/代码/价格/涨幅仍保持两行结构。
- **标题栏两个「新窗」（用户反馈 #26）**：删掉标题栏的「第二主窗口」按钮，
  只保留图表头的「新窗」（把当前图表拆成独立 K 线窗口）；`onOpenSecondary`
  prop 一并移除，避免留一个点不到的入口。
- **标题栏「侧栏」字号偏小（用户反馈 #27）**：原来按钮只有图标，文字是 CSS
  `::after` 补的 11px「侧栏」；改成与其他按钮一致的 13px 文字按钮，
  删除 `::after` 规则，六个文字按钮（侧栏/行情/异动/龙虎/板块/数据）字号统一。

### 工程

- 版本升到 `0.9.2`；Windows 三件套重新打包并实机验收，见 `docs/07` 第十三节。
- `npm run check` exit 0：275 个 TS 测试（274 passed + 1 skipped）+
  158 个 Python 测试（1 skipped）。

### 验证（2026-11-01，Windows 10 x64 实机）

| 产物                               | 大小                      | SHA256                                                             |
| ---------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| `pythontdx-0.9.2-setup.exe`        | 133.6 MB（133,569,020 B） | `218403d9909bc60e52649105c40bea06f6b0483758c89d1015ce397e4e62ce09` |
| `pythontdx-0.9.2-win-x64/`（散装） | 410.5 MB（410,462,471 B） | —                                                                  |
| `pythontdx-0.9.2-win-x64.zip`      | 175.5 MB（175,530,798 B） | `6120dc34d51a42634c41bf6eb758376eda70aa4bced1b024a140f25a844d2bb7` |

- 安装包静默安装 → 启动显示 `v0.9.2`、F10 排版正常（`screenshots/v092-installed-f10.png`）
  → 静默卸载后目录/快捷方式/注册表项全部清除；
- 绿色包与 zip 解压均启动并显示 `v0.9.2`（`v092-green.png`、`v092-zip.png`）；
- F10 深/浅主题与三个段落：`f10-after.png`、`f10-light.png`、`f10-profile.png`、
  `f10-finance.png`；左栏密度：`rows-compact.png`、`rows-sector-compact.png`、
  `rows-custom-compact.png`；标题栏：`titlebar-after.png`。

## [0.9.1] - 2026-11-01

### 新增

- **拼音首字母搜索补齐全市场列表**：全市场列表原来只按代码/名称过滤，现在输入
  `gzmt`、`wly` 也能命中；索引按需动态加载（`pinyin-pro` 单独 chunk），
  与顶部搜索框共用 `@shared/search` 的 `matchesPinyin` 规则，首字母/全拼都支持。
- **左栏三视图：自选股 / 板块 / 自定义**：左侧列表顶部加三档切换。
  「板块」点开即弹出大窗口选板块（行业 111 / 概念 269 / 风格 161 / 指数板块 117 /
  一般 100），选完在左栏按涨跌幅列出该板块的个股排行；「自定义」把自选分组当作
  自定义板块，同样按涨跌幅排行，可用「+」新建分组。成分股不在自选订阅里时，
  自动按代码批量补 MAC 报价（120 只/批）。板块选择器单独成组件
  （`SectorPicker.tsx`），参考通达信把「板块多」这件事交给大窗口。
- **离线数据备份 / 恢复**：数据工具页新增「备份到…」，用保存对话框选路径
  （同名文件直接报错，不覆盖），把 raw / cache / lake / exports / normalized / local
  打成单个 zip；行情数据本身已压缩，zip 用 STORED 只做单文件封装，另存
  `_pythontdx_backup.json` 清单并返回 SHA256。「校验」读回文件数/字节数/打包时间；
  「恢复」只补本机缺失文件、已存在的跳过（规则 12），并拒绝 `../` 路径穿越。
  备份/恢复在 Python sidecar 里做，超时给到 2 小时，适合直接写 NAS。
- **板块行情补二级行业**：MAC 0x1231 的 `boardType=1`（345 个细分行业）之前没接，
  BoardsPanel 现在有「一级行业 / 二级行业」两个页签。
- **一级/二级行业成分股（TDXRSHY）**：`tdxhy.cfg` 的 `rsCode` 字段一直没用，
  而 MAC 一级/二级行业名与 `incon.dat` 的 `TDXRSHY` 实测 128/128、345/345 完全对得上。
  `industries()` 现在同时返回 TDX 行业 111 与研发行业 471（三层合计）；板块选择器新增
  「一级行业 128 / 二级行业 345」，成分股来自 rsCode 分组，也能做涨跌幅排行。
- **板块指数 880 映射补齐**：服务器 `tdxzs.cfg` 只有概念 233/269、风格 141/161 有 880 指数；
  本机装了客户端时，`blocks()` 会读 `hq_cache/infoharbor_block.dat` 补缺，
  实测概念 **269/269**、风格 **158/161**；没有客户端时退回服务器数据，不影响功能。
- **个股列表右键菜单**：全市场、板块成分、板块排行、A 股排行榜、条件选股结果、
  沪深异动的股票行右键弹出菜单，可直接加入「自选股」或某个**具名的自定义板块**
  （列出分组名与数量）。分组互斥，已在别的分组时移动到所选板块，已在目标分组只切换选中。
  菜单做成全局单例（`stores/stockMenu.ts` + `components/StockMenu.tsx`），
  截图 `screenshots/stock-context-menu.png`。
- **自选股单层 + 板块两级菜单**（2026-11-01 用户指令）：自选股不再有分组标签，
  只剩一份平铺列表；「电池」这类用户板块归到「自定义板块」，分组标签只在
  「自定义」页签出现，且不再包含自选那一组。板块选择器改成两级：左栏选
  **分类方式**（一级行业/二级行业/通达信行业/概念/风格/指数板块/一般），右栏才是具体板块
  ——分类方式多，平铺一行放不下也不能并列；客户端自定义与应用内分组不进入选择器。
  截图 `screenshots/watch-flat.png`、`screenshots/sector-picker-2level.png`、
  `screenshots/custom-dropdown.png`、`screenshots/custom-rename.png`。
- **板块/财务/龙虎榜离线归档**：数据工具新增「板块/财务/龙虎榜归档」任务，范围可选
  「仅自选 / 全 A 股」，写 `lake/datasets/snapshot_date=YYYY-MM-DD/`：板块成分（概念/
  风格/指数/一般/通达信行业/研发行业，11.2 万行成员关系）、880 指数映射、龙虎榜全量
  （实测 2,404 行）、财务主要指标+分红（逐只 jsonl.gz）、三大报表
  （`statements/{zcfzb,lyb,xjllb}/{code}.jsonl.gz`，每只 4 个报告期 × 71 列全字段，
  不裁成界面用的 8 列）。财务 4 线程抓取，界面按 30 只一批推进度、可终止；
  每份文件带 SHA256/行数，同名文件不覆盖（规则 12），失败代码记入 `financeFailed`。
- **龙虎榜分页**：面板原来只渲染前 300 行（数据本身 2,404 行），后来全量直出又拖慢滚动；
  现在按 100 行/页分页（25 页），导出 CSV 仍是全量。
- **板块/自定义交互修正**：板块二级菜单去掉「客户端自定义 / 应用内分组」；
  不再导入通达信客户端自定义板块；自定义板块只有一层，改用下拉框选择，
  新建/改名走输入对话框（`+` 现在能先设名字）；板块排行行补迷你走势图，
  走势图改为全部成分股排队加载（3 并发），不再只画前 60 只。

### 修复

- **左栏板块/自定义行只有名称、没有代码（用户反馈 #19）**：`SectorRow` 现在和自选股行
  一样显示「名称 + 代码」两行，代码用 `SH/SZ/BJ` 前缀；
- **三个栏目排版不一致（用户反馈 #20）**：自选股、板块、自定义统一成同一套网格
  （名称/代码 1fr + 迷你走势 46px + 价格/涨幅 58px+ + 尾部 20px），
  价格列右边缘对齐；自选股行去掉包住价格的 `__side` 包装层，删除按钮单独占最后一列，
  关闭迷你图时也不再挤动价格列；
- **下拉框底色在深/浅主题下不一致（用户反馈 #21）**：各处 `<select>` 原本分别用
  `--panel`（半透明）/`--bg-base`/`transparent`，Windows 上原生控制框会透出背景、
  展开列表还会用系统色。现在统一为实心 `--panel-solid`，并给 `select option/optgroup`
  显式写底色与文字色；已逐一核对自定义板块、数据工具范围/周期、图表周期、预警、
  条件选股、状态栏格式（截图 `rows-custom-dark/light.png`、`selects-data-*.png`）。
- **侧栏「全市场列表」按钮和标题栏「行情」按钮 class 重名**：两者都叫
  `market-open`，截图脚本点到了服务器测速页；侧栏改为 `market-list-open`
  （无样式引用，纯选择器冲突）。
- **上证指数出现除权线 / 分红数据**：7615 的 F10 只按 6 位 symbol 查，
  `sh000001` 被当成 `sz000001`（平安银行），于是指数 K 线画出平安银行的除权线、
  F10 分红页也显示它的分红。`f10_dividend` 现在对指数直接返回空表；图表侧新增
  `isIndexCode`（与 Python 规则一致）不再发起分红请求，并隐藏指数无意义的复权档位。
- **Windows 打包必然失败（`npm run build:win`）**：`scripts/before-pack.cjs` 只找
  `python/dist/tdx-bridge`，而 Nuitka 在 Windows 上产出的是 `tdx-bridge.exe`，
  beforePack 阶段直接报「找不到 sidecar」。现在按 `electronPlatformName` 取文件名，
  并新增 `scripts/before-pack.test.mjs`（2 个用例；vitest include 扩到
  `scripts/**/*.test.mjs`）锁住平台映射。
- **Python 测试在 Windows 上误报失败**：`test_save_raw_file` 断言 `savedTo` 以
  `raw/tdx/x.bin` 结尾，Windows 路径分隔符是 `\`，改为按 `Path.parts` 断言。
- **「静默安装」其实没静默（2026-11-01 用户反馈）**：Git Bash / MSYS 会把参数 `/S`
  路径转换成 `S:/`，安装包因此走图形向导、要人点。改用
  `MSYS2_ARG_CONV_EXCL='*' setup.exe /S '/D=...'`（或 PowerShell
  `Start-Process -ArgumentList '/S'`）后实测 4.1 秒无窗口完成；卸载同理。
  产品代码未改动，验收方法已写进 `docs/07` 第十一节 / 第十二节，避免下次再误判。

### 工程

- Windows x64 用 `electron-builder --win nsis dir` 出一套产物：NSIS 安装包 +
  散装绿色目录 + 绿色包 zip，全部落在 `release/0.9.1/`，实测记录见 `docs/07` 第十二节。
- `npm run check` 在 Windows 上 exit 0：**270 个 TS 测试** +
  **158 个 Python 测试**（各 1 skipped）。
- 新增测试：`isIndexCode` 4 个（含 `sh000001` / `sz000001` 同号不同市场）、
  离线备份/恢复 2 个（补缺失 + 路径穿越）、指数无分红 1 个、
  客户端自定义板块解析 3 个（blocknew.cfg 定长记录 / .blk 市场位 / 目录优先级）、
  三大报表解析 2 个（full 保留全部列 / 摘要用中文标签）、
  拼音匹配 3 个（首字母 / 前缀 / 不命中）、before-pack 2 个。

### 验证（2026-11-01，Windows 10 x64 实机）

| 产物                               | 大小                      | SHA256                                                             |
| ---------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| `pythontdx-0.9.1-setup.exe`        | 133.6 MB（133,567,285 B） | `c87de55f31d0f4df6cd7abdc716b2f6f9301f264c316838bad2661db3a391f8a` |
| `pythontdx-0.9.1-win-x64/`（散装） | 410.5 MB（410,455,359 B） | —                                                                  |
| `pythontdx-0.9.1-win-x64.zip`      | 175.5 MB（175,528,404 B） | `5174289b77904e4d3f13d162417a22c746f0023b55711e4a4640efa7ef0520cc` |

- 安装包：`MSYS2_ARG_CONV_EXCL='*' setup.exe /S '/D=<目录>'` 真静默（无窗口，
  Git Bash 直写 `/S` 会被 MSYS 转成 `S:/` 进而弹图形向导）→ 快捷方式、HKCU 卸载项齐全 →
  安装版启动取到实时行情、状态栏 `v0.9.1`（`screenshots/v091-installed.png`）→
  `MSYS2_ARG_CONV_EXCL='*' "Uninstall pythontdx.exe" /S` 后目录、快捷方式、注册表项全部清除；
- 绿色包：整目录拷到 `.tmp/green091` 直接运行，状态栏 `v0.9.1`
  （`screenshots/v091-green.png`）；
- zip：解压出 76 个文件（410,455,359 B）后运行同样正常、`v0.9.1`
  （`screenshots/v091-zip.png`）；
- 0.9.1 界面改动：左栏三栏排版与代码行（`screenshots/rows-watch-dark.png`、
  `rows-sector-dark.png`、`rows-custom-dark.png`、`rows-custom-light.png`）、
  下拉框深浅主题（`screenshots/selects-data-dark.png`、`selects-data-light.png`）、
  拼音首字母 `gzmt`（`screenshots/market-pinyin.png`）；
- 0.9.0 起已验收的界面：板块选择大窗口（`screenshots/sector-picker.png`）、板块内涨跌幅排行
  （`screenshots/sector-ranking.png`）、自定义板块排行（`screenshots/custom-ranking.png`）、
  板块内选股走势图（`screenshots/block-sparkline.png`）、龙虎榜分页
  （`screenshots/dragon-pager.png`）、数据集归档任务与完成汇总
  （`screenshots/data-datasets.png`、`screenshots/datasets-done.png`）、
  数据工具备份区（`screenshots/data-backup.png`）、二级行业页签（`screenshots/boards-l2.png`）、
  指数日 K 无复权/无除权线（`screenshots/index-no-xdxr.png`）；
- 包内 sidecar `resources/tdx-bridge/tdx-bridge.exe`（21.5 MB）：`ping` → `pong`，
  `quotes` 返回 600519 实时数据（含五档），`backup_inspect` 可读备份清单；
- 全 A 财务归档实跑 1,612 只（三大报表 + 财务/分红，29 MB）后 7615 限速，
  已停止；归档按文件幂等，续跑只补缺（`docs/12` §2.5）；
- 未做代码签名：`Get-AuthenticodeSignature` 为 `NotSigned`，首次运行会有 SmartScreen 提示（TD7）。

---

## [0.9.0] - 2026-10-31（release candidate）

### 发布

- 许可证改为 **GPL-3.0-or-later**，新增 `LICENSE`，`package.json` 同步；
- 版本号从 `0.5.0` 更新为 `0.9.0`，作为 release candidate；1.0 等 `0x0547` 盘中复验与 Windows/macOS 实机验收；
- README 重写，加入主界面、智能画线、画线菜单、指标栏截图；
- 代码审计：修复行情头量比请求竞态、指标栏 17 项溢出、画线标签与通道偏移等已知问题；
- Linux AppImage/deb 重建，见 `docs/07` 第十节。

### 新增

- **面板级推送**：新增 `PushHub` 与 `push:subscribe/unsubscribe/update` IPC；
  排行榜、成交明细、集合竞价、资金流、主图（分时/五日/K 线）不再各自
  `setInterval`，统一由主进程按任务推送。Web 端 `api.push` 同步实现；
  新增 4 个调度测试（立即首帧、重复、取消、失败、窗口隐藏暂停）。
  边界：上游 `0x0547` 休市未观察到增量，盘中游标/推送语义待 2026-11-02 复验；
  主进程内部按订阅频率拉取，不伪称服务端推送。
- **逐笔「全部」**：不再只取 1,800 笔，按 1,800 循环分页并按绝对 index 去重合并；
  实测 `sh688499` 2026-10-30 显示 3,527 笔；`mergeTickPage` 新增 2 个测试。
- **F10 快捷键**：全局 `F10` 打开/关闭 F10 公司资料，快捷键帮助同步；截图 `f10-shortcut.png`。
- **默认自选**：首次启动只内置上证指数、深证成指、创业板指、科创50 四个指数，不预置个股；老用户已有自选不删除。
- **主图默认简洁**：均线默认显示但可一键关闭，BOLL/画线默认关闭；画线工具收进下拉菜单。
- **刻度密度**：K 线右侧价格刻度从约 7 档提高到 12 档；分时百分比刻度按 0.5% 步长，约 13 档。
- **画线交互**：拖动线体整体平移；Ctrl+C/V 复制粘贴；Ctrl+Z/Y 撤销重做（菜单也有按钮）；吸附开/高/低/收（菜单可关）。
- **画线默认隐藏**：新增「画线」开关，默认关闭；已保存的斐波/通道/测量等画线不再默认叠加。
  BOLL 保持独立开关（默认关闭）；画线工具收进「画线」下拉菜单，主工具栏只保留一个入口；画线支持点击选中、Delete/右键删除单条。
  研报正文与快捷键重映射按用户确认不做，归入 ⛔/非目标。
- **指标面板单页**：右栏 3 列紧凑布局，23 项全部显示，去滚动条；
  截图 `stats-all.png`，实测 scrollHeight=clientHeight=387。
- **逐笔本地归档**：`lake/ticks/trade_date=YYYY-MM-DD/<code>.jsonl.gz + manifest`，
  SHA256/行数校验、原子写入、已有有效归档不覆盖；历史逐笔查询优先读本地，
  缺档才回网络；单只 600519/2026-10-30 实测 4,453 行。
- **三类数据统一批量入口**：日 K / 1 分钟 K / 历史逐笔共用「批量下载本地数据」
  的范围选择、增量跳过、进度与取消；逐笔按选中交易日归档。
- **存储升级**：K 线与逐笔改为 Parquet(ZSTD)，读写统一走 DuckDB 2.0，
  不再写 JSON/JSONL 数据；旧 JSON 缓存已按用户指令删除，重新从服务器下载；
  pyarrow 仅保留给旧 stats 导出的可选路径，不进入 sidecar。
- **自选 4 只实测**：日 K 1 新增/3 跳过 0.57s；1m 3 新增/1 跳过 1.53s；逐笔 20 日 78 新增/2 跳过 60.37s；共 340,190 笔、4.07MB。
- **画线错位修复**：画线按 `code + period + 复权` 隔离，旧数据按 qfq 处理；保存起止日期锚点，数据前插后按日期重定位；利元亨旧画线切到前复权后对齐。
- **右键区间统计**：K 线图右键拖拽选区，浮动窗显示根数、涨跌、最高、最低、振幅、成交量，可拖动调整位置；默认跟随鼠标，采用与 K 线读数一致的 chart-tooltip 行式布局；右键删除画线保持可用。
- **行情头指标**：今开/最高/最低/昨收旁增加换手、量比、振幅、均价、涨停、跌停；右侧指标面板移除这些交易字段，只保留估值/财务/市值；指标栏改为两列铺满，标签 11px、数值 14px。
- **预计披露**：指标栏新增「预计披露」行，有预约日期显示，无数据明确显示「—」。
- **K 线缩放上限**：可见档位从最大 160 根扩到 500 根，仍保留 800 根均线计算数据。
- **智能组合补充**：增加测量线（高点→低点，显示涨跌幅/根数）和箭头（低点→阶段高点）；通道改用最近 60 根并延伸到最新交易日。
- **智能画线收口**：智能组合不再生成趋势线（趋势线保留手工工具，起终点都显示价格）；智能组合为斐波那契、测量、箭头、通道、水平支撑/压力。
- **通道延伸**：智能通道用最近 60 根摆动，延伸到最新交易日，便于观察突破/跌破。
- **平行通道算法修正**：第三点按自身 X 坐标投影到基准线，取真实价差作偏移；拖动手柄同算法；新增 2 个测试。
- **区间统计默认可用**：右键随时拖拽，不再需要先开「区间」模式；原按钮改为「清除区间」，无高亮/状态，只清选区和浮窗。
- **斐波那契裁剪**：只绘制价格区内水平位，127.2%/161.8% 等超出价格区的扩展位不再画进成交量/MACD 区。
- **示例画线重置**：删除旧画线，按 61.88→29.90 主跌段、29.90→46.28 反弹段重画斐波/测量/箭头/支撑示例。
- **离线下载终止**：离线数据下载运行中显示「终止下载」，K 线按批次、逐笔按日期检查停止。
- **离线下载补逐笔**：数据管理「离线数据下载」任务列表加入历史逐笔（最近 20 个交易日）。
- **六档下载入口**：日 K / 1 分钟 K / 历史逐笔各自提供「自选股全量」「市场全量」按钮；
  日 K/1m 全历史翻页，逐笔默认最近 20 个交易日；20 只/批、4 连接并行；共用进度/取消/断点续跑/失败清单。
- **数据完整性**：F10/财务/公告查询自动写 point-in-time；资金流单票查询自动归档；
  竞价 selector=0 返回即自动归档；zhb.zip 已知 47 文件清单/差分；`data_coverage` 九类清单；
  audit 扩到 36 项并在 2026-10-31 连续两次通过。
- **全市场资金流排行**：新增 MAC `0x1218` 批量命令 `mac_money_flow_batch`
  （1~24 并发，单只失败跳过），排行榜新增「资金流」tab；先取全市场 MAC 报价，
  再分块补资金流并按主力净额排序，显示「净额 · 占成交额」。
  2026-10-31 实测 5,615/5,615 只成功；IPC/Web `/api/mac_money_flow_batch` 同步。
- **公式管理器**：求值器支持 `:=` 变量赋值、多语句/多输出、颜色修饰、花括号注释、
  `C/O/H/L/V` 别名；新增 EXPMA/SMA/WMA/DMA/TMA/MEMA/XMA、REF/REFX、
  COUNT/EVERY/EXIST、FILTER/BACKSET/VALUEWHEN、CROSS/LONGCROSS、
  RSI/BIAS/ATR/TR/VAR/STD、数学/逻辑与 DRAWTEXT/STICKLINE/DRAWICON 等绘图语句；
  多输出按红/蓝等颜色叠加，财务/即时行情/DLL/扩展数据函数明确报错。
- **竞价本地归档**：`lake/auction/trade_date=YYYY-MM-DD/{code}.jsonl.gz + manifest`，
  规范化 JSONL、SHA256/行数校验、`.part` 原子写入；历史日期优先读本地归档，
  服务器不再保留的日期仍可回看已归档内容。实测 `sh688499` 66 点归档并回读。
- **批量/自动竞价归档**：新增 `auction_archive_batch`，数据工具「归档自选竞价」
  实测 7/7 只；收盘自动任务在原有开关下同时归档快照、自选竞价、逐笔、资金流与 5s/15s K 缓存，单只失败不阻断其他项。
- **竞价归档清单**：数据工具读取 `lake/auction` 最近 20 个文件，显示日期/代码/点数/大小；
  实测列出 8 条，只读不修改原始数据。
- **条件选股扩展**：新增 PB、流通市值、总市值上下限筛选；结果表增加 PB/流通市值/总市值列；
  预设保存/载入同步新条件。修复市值输入误乘 1e8 的单位 bug；实测 `总市值 1000–10000亿`
  命中 100 只，`PB≤2 + 流通市值≤3000亿` 命中 100 只。
- **全市场振幅排行**：MAC 0x122B 不直接给振幅，按 `(最高-最低)/昨收` 计算；
  新增「振幅」tab，实测首位 32.72%，避免全市场榜全 0。新增 1 个纯函数测试。
- **全市场市值排行**：新增 `mac_quotes_finance`（MAC 0x122B + 0x0010 财务补股本），
  排行新增「流通市值/总市值」tab；实测首位农业银行 23,879.47 亿，前 300 名正确降序。
- **市值数据质量保护**：市值榜先剔除 `floatCap/totalCap` 缺失或 ≤0 的报价；
  全部缺失时明确提示「0x0010 财务数据不可用」，不再把 0 当成市值参与排名。
- **BBI 指标**：新增多空指数 `BBI = (MA3+MA6+MA12+MA24)/4`，指标面板与 K 线副图
  共用；新增 1 个边界测试。
- **DMA 指标**：新增平行线差 `DMA = MA10 - MA50` 与 `AMA = MA(DMA,10)`，短/长/M
  三参数可编辑并记忆；指标面板与副图共用；15 个页签正常排布；新增 1 个边界测试。
- **TRIX 指标**：新增三重指数平滑平均 `TRIX12` 与 `MATRIX9`，N/M 参数可编辑并记忆；
  指标面板与副图共用；16 个页签正常排布；新增 1 个边界测试。
- **SAR 指标**：新增抛物线转向停损点，步长/上限参数可编辑并记忆；上涨段在价格下方、
  下跌段在上方；指标面板与副图共用；17 个页签正常排布；新增 1 个边界测试。
- **条件选股排序扩展**：新增市净率/流通市值/总市值排序；缺失指标统一排在最后，
  不再被当成 0 值混入；新增 2 个 Python 排序测试。
- **K 线测量工具**：新增「测量」画线，两点显示涨跌幅与跨过的 K 线根数，
  端点可拖动、随画线持久化；新增 2 个纯函数测试。
- **K 线箭头标注**：新增两点箭头画线，箭头头部随方向旋转，端点可拖动并持久化；
  新增 2 个箭头几何测试。
- **K 线平行通道**：三点确定基线与偏移，绘制两条平行线和半透明填充；端点可拖动、
  偏移手柄可单独拖动，随画线持久化；新增 2 个偏移测试。
- **斐波那契回撤/扩展画线**：新增 7 档回撤（0/23.6/38.2/50/61.8/78.6/100%）与
  2 档扩展（127.2%/161.8%），端点可拖动；同时修复画线坐标未减去可见窗口起点、
  缩放后画线跑到屏幕外的 bug。
- **分时图缩放/平移**：单日/五日分时支持滚轮缩放、拖动平移、双击复位；可见范围按槽位
  裁切价格/均价/成交量/坐标轴，缩放到 `10:33–14:06` 与五日 `10-27 10:42–10-29 14:26` 实测通过。
- **指标库扩展**：新增 ROC、PSY、VR、CR 四种副图指标（指标面板与 K 线副图共用）；
  共 12 种副图指标，周期参数均可编辑并记忆（ROC 6/PSY 12/VR 26/CR 26）；新增 3 个纯函数用例。
- **多屏窗口放置**：设置面板列出 `screen.getAllDisplays()`，显示主屏/当前屏，
  点击可将当前窗口取消最大化并居中移到目标显示器；Web 端回退为浏览器窗口。
  居中计算抽成纯函数并补 3 个边界用例（负坐标副屏/窗口大于工作区）。

### 变更

- **本地数据永久保存**：按用户 2026-10-31 指令，不提供清理/删除入口，不实现 prune；
  已存在且校验通过的归档不覆盖（`skipped=true`），只允许替换损坏副本
  （见 `PRINCIPLES.md` D6.1）。

### 修复

- **集合竞价混入全天快照**：`0x056a` selector 默认值从 `3` 改为 `0`。
  selector=3 实测返回 206 点直到 14:59，混合了全天数据；selector=0 只返回
  09:15:02–09:24:58 的 147 点。历史日期受服务器保留期限制，空时给出明确提示。

### 验证

- 状态：功能矩阵 **334 ✅ / 0 🟡 / 0 ⬜ / 6 ⛔**，6 项边界；
  `npm run check` 退出码 0（259 TS + 148 Python），Linux 包哈希与 `docs/07` 一致。
- `0x0547` 休市探针（2026-10-31，sh600519）：cursor 0 / 1 / 0xFFFFFFFF
  均返回同一 129 字节快照（价格 1392.05、记录内 update=153001）；
  只能说明休市无新数据时游标无差异，**不能判定盘中无增量/推送**。
  已写回 `docs/03` / `docs/08` / `PLAN.md`，待 2026-11-02 交易时段复验。
- `npm run check` → **259 TS + 148 Python（1 skipped，25 个 TS 文件）**，全绿；
- `npm run build` / `npm run build:web` 通过；
- Linux AppImage 147 MB `3ae1abed…` / deb 123 MB `a5c216ea…`；
  包内 sidecar 实测 `auction_archive_read` 66 点、`auction_archive_batch` 2/2；
- 截图：`screenshots/ranking-flow.png`、`screenshots/formula-multi-output.png`、
  `screenshots/auction-archive-save.png`、`screenshots/auction-archive-read.png`、
  `screenshots/packaged-ranking-flow.png`、`screenshots/packaged-formula-multi.png`、
  `screenshots/packaged-auction-archive.png`、`screenshots/data-auction-archive.png`、
  `screenshots/auction-archive-list.png`、`screenshots/indicator-roc.png`、
  `screenshots/indicator-roc-params.png`、`screenshots/packaged-indicator-roc.png`、
  `screenshots/multi-screen.png`、`screenshots/screener-pb-cap.png`、
  `screenshots/screener-total-cap.png`、`screenshots/screener-sort-total-cap.png`、`screenshots/kline-fib.png`、
  `screenshots/kline-fib-ext.png`、`screenshots/chart-measure.png`、`screenshots/chart-arrow.png`、`screenshots/chart-channel.png`、`screenshots/chart-channel-handle.png`、`screenshots/indicator-bbi.png`、
  `screenshots/indicator-dma.png`、`screenshots/indicator-trix.png`、
  `screenshots/indicator-sar.png`、
  `screenshots/trend-zoom.png`、`screenshots/trend-zoom-five.png`、
  `screenshots/ranking-amplitude.png`、`screenshots/ranking-market-cap.png`；
- 矩阵（不含状态图例）：**334 ✅ / 0 🟡 / 0 ⬜ / 6 ⛔**。

---

## [未发布] - P2 九项增强（2026-10-31）

### 新增

- **默认五均线**：5/10/20/60/120，默认只显示均线（副图 none、BOLL 关）；
- **F11 全屏**：桌面 `BrowserWindow.setFullScreen`，Web `requestFullscreen`；
- **全屏自选**：每页 24 只、分时缩略图、翻页、点击切股；侧栏入口；
- **F10 Markdown**：当前页签预览、复制、下载 `.md`；
- **离线缓存**：K 线请求成功落盘，失败自动回退 `source=cache`；自选 800 根预热；
- **本地数据清单**：扫描 raw/cache/lake/exports/normalized/local；
- **默认刷新 1 秒**（旧配置保留用户已保存值）；
- **自选名称完整显示**：去掉省略号，紧凑行宽；
- **左侧栏伸缩**：拖拽 200–380、双击复位；提升把手可见性；
- **行情主站测速/选择**：19 台 Windows 通达信公开主站 TCP 测速，选择持久化并 failover；
- **秒级逐笔**：MAC `0x122F` 真实秒，7709 分钟级兜底；历史日期与大小窗上下键；
- **关键指标补全**：PE/PB/PS/PEG/分位、量比估算、涨跌停价；
- **副图十字光标**：主图纵线延伸到副图；
- **F10 排版**：目录 NUL 截断、竖线表转 HTML 表格；
- **侧栏一键开关**：标题栏「侧栏」+ 隐藏后「自选 »」浮动按钮；
- **主题下拉框**：`.chart-sub-select` / `.chart-ext-select` 跟随主题、深色不透明底；
- **数据覆盖审计**：`npm run audit:data` 13 项只读探针 + `docs/12` 覆盖矩阵；历史竞价已可用；
- **财务三口径 PE**：TTM / 动态 / 静态，另补 EPS/ROE/毛利率/同比/财报期；
- **行情独立窗口**：标题栏「行情」打开 BrowserWindow，并发测速并默认隐藏不可达；
- **公告 Markdown 渲染**：标题/引用/表格/列表/代码块，不再 `<pre>` 原始文本；
- **主副图对齐**：副图复用主图窗口与像素留白，十字线缩放前后均 0px 偏差。

### 变更

- **Nuitka 成为唯一 Python 打包后端**：移除 PyInstaller 回退；onefile 9,590,992 字节，不含 Python 源码；
- Linux 图形后端默认 `wayland`；Chromium 当前不允许 Wayland 表面 + Vulkan，
  `PYTHONTDX_GRAPHICS=vulkan` 走 XWayland + ANGLE Vulkan（需真实驱动，失败要回退）。

### 验证

- `npm run check`：215 TS + 116 Python（1 skipped）；
- `npm run audit:data`：13/13 PASS；
- 包：AppImage 130 MB `32ed7d2d…e55dd5f` / deb 105 MB `5322ccc8…c5b0957`；
- 截图：`chart-5ma.png`、`f11-fullscreen.png`、`watchlist-full-24.png`、
  `f10-markdown.png`、`data-offline.png`、`sidebar-resize.png`；
- 九项修复截图：`server-speed-test.png`、`stats-complete.png`、`history-ticks.png`、
  `crosshair-subchart.png`、`f10-layout.png`、`sidebar-hidden.png`、`packaged-nine.png`；
- 五项复查截图：`server-window.png`、`markdown-render.png`、`auction-history.png`、
  `packaged-eleven.png`、`packaged-server.png`。

---

## [未发布] - P1 协议补齐（进行中）

### 新增

- **排行榜首屏**：接入 `0x054b`，支持涨幅/成交额/涨速/短换手/封单额五种服务端排序，
  首屏 80 条、可「加载更多」翻页；点击行可直接查看该股，不强行加入自选。
- **成交明细**：`0x0fc5` 当日 / `0x0fc6` 历史单页解析（1800 条），
  区分竞价快照、09:25 撮合和盘后固定价格成交；右侧栏提供「五档 / 成交」切换，
  默认最近 60 笔、3 秒刷新；新增历史日期选择，选历史后停止轮询；
  「更早」按页向前拼接，展开后停止轮询。
- **F10 公司资料**：`0x02cf` 目录 + `0x02d0` GBK 正文，标题栏 F10 弹窗，
  左目录右正文、按段缓存；7615 在线资料尚未接。
- **集合竞价**：`0x056a` 当日/历史单页解析（500 点），秒级时间、价格、
  虚拟匹配量、未匹配量/方向；虚拟匹配量不当真实成交。右侧栏新增「竞价」页签。
- **资金流**：`0x0ffc` 单只最近 5 日（主力净额/占比、主买、四档净额），
  固定走资金流专用节点；普通节点全 0 时明确报错。右侧栏新增「资金流」页签。
- **服务器文件**：`0x06b9` 完整下载 + 原始 ZIP 落盘/SHA256；
  `tdx_stats` 解析 `zhb.zip` 内 `tdxstat.cfg` / `tdxstat2.cfg`
  （各 8,103 行，主日期 20261029）。
- **板块指数 K 线**：880/881 按指数布局解析 `0x052d`；点击板块指数进入主图，
  实测银行指数日 K 可用。原先“K 线日期不合法”是把它当成了股票 K 线。
- **7615 在线资料**：公司公告列表（标题/日期/类型/来源/PDF 链接）、公司概况、
  估值（PE/PB/PS/PEG/市值）、财务主要指标（zyzb，20 期）、主营构成（按地区/业务/产品）、十大股东、研报列表、三大报表关键科目；
  公告详情交给系统浏览器；概况/估值/财务/主营/股东/研报/报表走 `CWServ.tdxf10_gg_gsgk` / `HQServ.hq_nlp_gpsj` / `CWServ.tdxf10_gg_cwfx` / `CWServ.tdxf10_gg_jyfx`；
  不抓取研报正文。
- **WebSocket 行情**：`/ws` 文本帧订阅（codes/intervalMs），每周期推 `type=quote`；
  Web 优先 WebSocket，失败自动回退 SSE；Vite 开发代理支持 `/ws`。
- **公式选股**：后端 Python 安全表达式（MA/EMA/REF/CROSS），按成交额前 100/500
  或全市场逐只拉日 K；分块扫描显示进度并可取消；全市场 5,579 只约 99 秒。
- **条件选股行业过滤**：输入通达信行业名（如“银行”），后端用 tdxhy 成分过滤；
  实测银行 42 只、返回成交额前 5。
- **Linux 打包验证**：PyInstaller 6.22.3 + electron-builder linux-unpacked 与
  AppImage（130 MB）/ deb（106 MB）均启动成功，行情/图表正常；补 `homepage` 元数据。
- **图表设置记忆**：上次停留的周期（分时/五日/1–60 分钟/日周月）与复权口径写入 AppSettings，跨重启恢复。
- **主图 BOLL**：BOLL(20,2) 叠加主图，纵轴范围包含上下轨；设置随重启恢复。
- **F10 报表全部原始列**：关键科目/全部原始列可切；全部模式保留 ColName，
  不做错误字段猜测。
- **Web 前端复核**：Chrome headless 直接访问 `--web-dir out/web` 单端口，
  1440×900 截图 `web.png`；SSE/轮询可读。
- **F10 公司新闻**：7615 `xw` 缓存列表 100 条，标题/时间/来源；不抓正文。
- **自选组合回测**：自选池最多 20 只等权，按日期平均收益，最多 120 根日 K；
  输出组合/持有收益、回撤、标的数、天数、调仓次数与净值曲线。
- **公式回测口径修正**：按上一根收盘信号、收盘到收盘计收益（含隔夜），
  新增年化/胜率；测试覆盖跳空。
- **F10 交易扩充**：新增研报席位/科创标记分区；截图工具指针操作后等待 300ms 以等异步表。
- **托盘常驻**：默认关闭窗口隐藏；托盘菜单显示/退出；设置面板可关。
  关闭隐藏时 capturePage 会挂起，属预期。
- **打包守卫**：beforePack 校验 sidecar 魔数，Linux 交叉打 Windows 包直接失败，避免 ELF sidecar 混入。
- **第二主窗口**：TitleBar「新窗」；行情推送广播到所有窗口；active/settings BroadcastChannel 同步。
- **窄窗适配**：1240px 以下隐藏自选迷你图、侧栏图标收窄、右栏可滚动，避免股票名压成一个字/买五被裁。
- **两条件组合预警**：价格/涨幅/量比/换手/振幅任选两项，AND 触发；规则描述与消息用「且」；184 TS。
- **自定义版面槽**：保存当前左右栏宽度，最多 3 套，可应用/删除。
- **专注模式**：F 切换、Esc 退出，隐藏左右栏让图表占满；截图 `focus-mode.png`。
- **窗口位置记忆**：第二主窗口、独立 K 线窗口分别持久化 bounds（主窗口原逻辑不变）。
- **下载落盘**：主进程 will-download 显式写入系统下载目录，实存全市场 CSV（5,615 行/557 KB）。
- **1024 宽复核**：F10 17 页签自动换行，scrollWidth=clientWidth=961。
- **Web 写操作验证**：`state.patch` 实测新增分组并落 localStorage（2→3 组），非只读。
- **Web 截图验收**：`scripts/web-shot.cjs` + `npm run shot:web`，1440×900 实拍 Web 只读页。
- **选股股票池**：选股结果一键存为新自选分组（100 只），截图 `screener-pool.png`。
- **矩阵复核**：校正公告/财务/龙虎榜/盘后下载/本地行情/数据湖等过期状态；124 个截图引用全部存在。
- **预警「或」组合**：条件关系可选且/或；新增 OR 测试；188 TS。
- **多预设并行跟踪**：最多 10 个预设各自 60 秒更新自动池；修复 tracking 数组 IPC 克隆。
- **自动选股池**：单预设 60 秒重扫，整组替换「自动池 · 预设名」；实测跟踪中/自动池出现。
- **选股条件预设**：保存/应用/删除最多 10 个条件；截图 `screener-presets.png`。
- **60轮新预算**：max 200→260；目标 active；首项全市场排行。
- **0x056a 历史探测**：历史日期实测 0 点，确认仅当日；撤回日期选择器。
- **1024 行情头部**：名称/价格/按钮自动换行，修复名称逐字竖排与指标重叠。
- **Web 1024 验收**：web-shot 支持宽高环境变量；1024×720 三栏正常。
- **F10 按需加载**：打开只取公告，切页签才请求对应数据；截图 f10-lazy.png。
- **除权除息标记**：日 K 用 D 标出除权派息日；截图 kline-dividend.png。
- **最近搜索键盘导航**：↑↓/回车可打开最近记录。
- **K 线导出周期**：日/周/月 × 120/240/480；实测周K6只/720根。
- **F10 19 页签 1024 验收**：两行换行，无横向溢出；截图。
- **行业 HTTP 路由测试**：mock 桥接响应；Python 110。
- **涨跌分布纯函数**：13 档边界修正，合计 5615；202 TS。
- **F10 行业**：行业汇总/行业新闻/行业研报三区；实测新闻 100 行。
- **持仓导出**：组合分析导出 CSV；实测贵州茅台 100 股。
- **配置备份**：设置面板导出/导入 JSON；截图 settings-backup.png。
- **复盘速度**：0.5/1/2/4x；截图 replay-speed.png。
- **均线周期可配**：设置里改 3 条 MA 周期，图表实时生效；截图 chart-ma-config.png。
- **涨跌分布**：全市场 5615 只按 13 档绘制红绿柱；截图 market-distribution.png。
- **自动归档**：工作日 15:05–15:40 自动归档全市场；纯函数 3 测试。
- **分时预警线**：分时图同样画价格目标线；截图 minute-alert-line.png。
- **预警目标线**：价格预警在日 K 画虚线/标签；截图 kline-alert-line.png。
- **最近搜索**：搜索框聚焦显示最近 8 条，可清空；截图 search-recent.png。
- **OBV 能量潮**：面板/副图；197 TS；截图。
- **DMI/ADX**：+DI/-DI/ADX 三线，面板/副图；196 TS；截图。
- **BIAS 乖离率**：6/12/24 三线，面板/副图；195 TS；截图。
- **CCI 顺势指标**：指标面板/副图/参数；194 TS；截图。
- **WR 威廉指标**：指标面板/副图/WR 参数 0–100；193 TS。
- **多股同列 9 格**：6/9 格切换，最多 9 只；截图 multi-9.png。
- **主图公式**：公式面板「应用到主图」，归一化叠加 + 清公式；截图 chart-formula.png。
- **窗口置顶**：图表「置顶」切换当前窗口 always-on-top；截图 chart-pin.png。
- **状态栏涨跌停**：0x054b 全市场快照计数，显示「停 53/148」；109 Python。
- **成交明细全部**：一键加载 1800 笔；实测 1800 行。
- **资金流四档**：点击日期展开超大/大/中/小净额；截图 `money-flow-tiers.png`。
- **涨停/跌停/炸板**：全市场 MAC 快照本地判定（10/20/30/ST5），异动面板新增 4 页签；192 TS。
- **全市场排行**：排行榜切「全市场」按 MAC 排序 5,615 只/前 300；截图 `ranking-full.png`。
- **第200轮收尾**：188/108；139截图零缺失；180/30/1/6；目标保持 active，不虚假完成。
- **第198轮状态**：工作区干净、229 提交领先、139 截图零缺失、180/30/1/6。
- **AppImage 结构核对**：desktop Exec/StartupWMClass、ELF 主程序、侧车 pong。
- **deb 结构核对**：桌面 Exec/Icon/StartupWMClass、512 图标、ELF 主程序、侧车 ping 通过。
- **最终核对**：139 个截图引用零缺失；矩阵 180/30/1/6；包哈希与报告一致。
- **验收报告**：新增 `docs/10-验收报告.md`，汇总证据/缺口/复现命令。
- **HTTP 路由验收**：11 条新接口真实 200；F10 数据桌面/Web 共用。
- **合法边界审计**：仅 TDX 端点；无交易/7727/付费数据；命令证据入 docs/09。
- **Web 通知授权**：设置内申请 Notification 权限，授权后预警走系统通知；实测状态「已授权」。
- **桥接验收**：9 个 F10/数据湖命令逐个实测（56/30/1/9/3/180/18/1679/5615 行），130 个截图引用全存在。
- **收盘归档脚本**：`npm run archive:snapshot`，cron 可挂；实测 5,615 行。
- **数据湖归档历史**：列最新 20 个 trade_date、行数/大小/SHA；108 Python。
- **F10 增减持计划**：7615 `gdzjcjh` 6 行，金额区间/进度/已增持；107 Python。
- **F10 实控人**：7615 `kggd` 控股股东/实际控制人/控制关系；106 Python。
- **数据湖快照归档**：`lake/quotes/trade_date=/` JSONL.gz+CSV+manifest，5,615 行；105 Python。
- **F10 机构持仓**：7615 `jgcg` 9 期，家数/持股/占比/户均；104 Python。
- **F10 增减持**：7615 `cgbd` 44 行，变动区间/均价/数量/方式；103 Python。
- **F10 流通股东**：7615 `ltgd` 第二表 180 行，6 列精简展示；102 Python。
- **F10 股本结构**：结构/变动/回购/限售四分区；东方财富结构 18 行；101 Python。
- **F10 股东人数**：7615 `gdrs` 30 行，户均持股/环比/变动；100 Python。
- **F10 分红**：7615 `fhrz/fh`，东方财富 34 行；字段中文化；99 Python。
- **两融历史**：7615 区间通道 `rzrq_sj`，东方财富 122 行；98 Python。
- **全市场快照**：MAC 分批 5,615 只，导出代码/价格/涨跌幅/成交额/换手/量比/涨速 CSV。
- **自选 K 线批量导出**：6 只/1,440 根，CSV + JSONL.gz + manifest；97 Python。
- **图表 CSV**：当前 K 线（OHLCV）/分时（价格/均价/量）按 code+period 导出。
- **CSV 导出**：市场列表本页、龙虎榜筛选结果、大盘资料当前分区；纯函数 CSV 转义；187 TS。
- **涨速排序**：MAC 0x25 接入；市场列表涨速列与全表排序；截图 `market-speed.png`。
- **大盘资料**：7615 大盘 F10 指数概况/市场两融/新股/增发；状态栏入口；96 Python。
- **换手/量比排序**：MAC 0x1B 换手字段接入；市场列表新增换手/量比列与全表排序；截图。
- **板块排序**：板块涨跌幅升/降序、领涨涨幅、名称；过滤无点位板块；截图 `boards-sort.png`。
- **板块行情**：MAC `0x1231` 560 个板块，点位/涨跌幅/领涨股；行业/概念/风格/地域；95 Python。
- **个股龙虎榜回退**：个股 `lgt` 空表时按代码过滤市场龙虎榜；冰山冷热 40 行；截图。
- **沪深龙虎榜**：7615 大盘 F10 `skef10_dpzx_lhb`，2,404 条营业部明细，搜索/前 300/点击切股票；94 Python。
- **多分钟/多日周期**：2/3/4/6/8/12/18/24/36/48 分钟 + 4/6/9/12/18/24 日；截图 24m/24d。
- **沪深异动**：MAC `0x1237` 沪深合并 360 条，时间倒序，点击切股票；93 Python。
- **版面预设**：设置内默认/宽图表/宽盘口，应用后宽度持久化；截图 `settings-layout.png`。
- **可调栏宽**：侧栏/盘口栏拖拽 200–380/260–460，双击复位，宽度持久化；截图 `layout-resize.png`。
- **文字标注编辑**：双击标注打开输入框，Enter/失焦保存；截图 `kline-text-edit.png`。
- **文字标注拖动**：点选标注点拖动，实时更新并落盘；截图 `kline-text-drag.png`。
- **趋势线端点拖动**：两端点命中、实时更新、落盘；合成指针验证 x/y 446/184→487/219。
- **画线拖动**：水平线/垂直线可拖动并落盘；合成指针验证 y 234→294。
- **多条件预警扩展**：最多 4 个条件动态增删，AND 同满足；185 TS。
- **文字标注**：输入文字后点击图表放置、持久化；截图 `kline-text.png`。
- **垂直线画线**：单点放置、日期标签、按 code+period 持久化；截图 `kline-vertical.png`。
- **MAC 资金流**：`0x1218` 今日主力/散户 + 5 日大单/中单；资金流页签补充卡；92 Python。
- **公式函数扩充**：SUM/HHV/LLV/STD/IF，前后端同子集；183 TS + 91 Python。
- **全表排序**：MAC 分批 400 只拉全 A 5,615 只报价，按涨幅/跌幅/成交额/现价重排；榜单首屏 *ST航图 +20.04%。
- **Linux 包重建**：PyInstaller 6.22.3 重建 sidecar（MAC/F10/本地写回）；AppImage 130 MB `cc85c037…`、deb 105 MB `a40525f6…`，AppImage 实机启动截图；包内全表排序、MAC 资金流、组合预警（且/或）、垂直线/文字、多周期、F10 18 页签、条件预设、多预设自动池、浏览器通知、数据湖归档历史均已验证；Linux 桌面关联改为 pythontdx。
- **MAC 报价兜底**：`0x122B` 三步握手 + 字段 0~7 + 五档；7709 报价失败时自动切 MAC，89 Python。
- **REITs 分栏**：基金内按 508/180 前缀单列，101 条。
- **F10 交易数据扩充**：涨停/跌停/可转债/主力盘口四个分区；涨停 30 行实测。
- **预警历史持久化**：最近 50 条触发记录写入状态，重启后仍可查看；清空同步落盘。
- **布局精修**：自选股标题不再竖排；图表工具栏拆为「周期」「工具/操作」两行；MA 图例移入图内浮层；chip/分段控件统一圆角与悬停。
- **市场列表分栏扩充**：基金 13,214、债券 982、B股；全 A/指数/科创/创业/北证保留。
- **市场列表**：代码表分栏（全A 5,615/指数 1,678/科创/创业/北证），当页 0x054c 快照，搜索/分页；板块入口。
- **本地跨库查询**：local 引擎 ATTACH stats.db，可 JOIN `stats.tdxstat`；拒绝写操作。
- **写回分钟文件**：.lc1/.lc5 float32 与 .5 整数分；3 根 roundtrip。
- **写回 .day**：原子替换，价格分/量股；3 根 roundtrip 验证。
- **自选 CSV**：导出/导入 CSV（分组列、引号转义、无表头兼容）；状态栏格式切换。
- **本地数据湖查询**：数据工具「本地」引擎只读查询 local_bars.db；拒绝非 SELECT/WITH。
- **本地数据湖导入**：原始文件按 sha256 存 raw/，JSONL.gz、SQLite `local_bars`、manifest；
  重复导入按 code/date 去重。
- **本地文件 CSV**：解析结果可直接导出 UTF-8 BOM CSV。
- **本地分钟文件**：.lc1/.lc5（float32）与 .5（int 价格）读取；3 根 fixture 截图。
- **本地 .day 读取**：32 字节记录解析、只读、成交量换算成手；每文件最多 500 根展示。
- **公式组合回测**：前 N/全市场分块回测，等权日收益聚合；前 100 实测 129 天/1151 次调仓；
  全市场 5,579 只/12 块/117.7 秒/163 天/-6.29%/回撤 7.96%。
- **独立 K 线窗口**：图表头「新窗」打开同一渲染层的 detached chart；Web 不支持。
- **持股回溯**：按当前持股数×120 日收盘模拟市值曲线；明确不是历史成交回放。
- **组合持仓**：本地持股/成本、市值/浮动盈亏/权重；纯函数测试 2 个。
- **涨跌家数**：状态栏每 30 秒展示全 A 股涨/跌/平；启动即拉一次。
- **组合分析**：当前自选分组当日快照，等权平均/涨跌家数/成交额合计；点击行切主行情。
- **快捷键**：全局 / 搜索、R 刷新、T 主题、? 帮助、Esc 关闭；帮助面板列出 9 条。
- **设置面板**：主题、刷新间隔、失焦暂停、自选迷你图、恢复默认；标题栏齿轮入口。
- **F10 交易数据**：两融/大宗/龙虎榜/沪深股通 4 分区；table0 原始列；
  600519 两融实测 18 行。
- **分价表**：当日逐笔（≤1800 笔）按价位聚合成交量/笔数/占比；右侧新增「分价」页签；支持历史日期与大单手数门槛。
- **画线工具**：水平线、两点趋势线、清线；按 code+period 写入设置，重启恢复。
  修复设置里嵌套对象数组 IPC “could not be cloned”。
- **区间统计**：图上点两下，显示区间根数/涨跌/最高最低/振幅/成交量；几何统计 +1 测试。
- **对数坐标**：K 线线性/对数切换，设置记忆；几何函数 +1 测试。
- **2/3/45 日 K**：0x052d period=9 + N；图表头下拉选择。
- **10/20 分钟 K**：0x052d period=8 + N；图表头 10/20 快捷。
- **季 K / 年 K**：0x052d period=10/11；图表头季/年切换；年 K 已截图。
- **K 线副图**：MACD/KDJ/RSI 副图开关，副图与主图共享 K 线，最近 160 根；设置记忆。
- **指标参数编辑**：MACD 快/慢/信号、KDJ N/M1/M2、RSI 周期、BOLL 周期/倍数；参数随重启恢复。
- **技术指标面板**：MACD(12,26,9)/KDJ(9,3,3)/RSI14/BOLL(20,2)，
  本地计算，最近 160 根日 K，显示最新值。
- **5s/15s K**：0x052d period=13 + N 秒参数；秒级时间戳按 2003-12-31 起的秒数解码；
  5s 已截图。
- **分钟 K**：0x052d 接入 1/5/15/30/60 分钟；分钟时间戳按 packed date+minute 解码；
  图表头新增 1/5/15/30/60 快捷切换，5m 已截图。
- **K 线复权开关**：日/周/月 K 可切不复权/前复权/后复权；0x052d adjust=0/1/2，
  实测 600519 旧价 1713.80 / 1560.28 / 10579.06。
- **多股同列**：当前分组最多 6 只，支持 60 根日 K 与当日分时；
  点击卡片切换主图。
- **自选导入/导出**：状态栏 JSON 备份；导出全部分组，导入追加分组，
  ID 冲突自动改名，不覆盖现有自选。
- **数据工具 Parquet 按钮**：一键导出 16,200 行 / 32 文件，展示目录/manifest/schema；
  需要 pyarrow，缺失时明确报错。
- **可选 Parquet 导出**：`python/parquet_export.py` 按 `trade_date` 分区写 Parquet
  （需 pyarrow；本机 pyarrow 26 隔离实测 16,200 行/32 文件，默认环境测试跳过）；
  DuckDB 2.0 查询层已用隔离目录实测 20 行；DuckDB/Parquet 均非默认依赖。
- **自定义版面槽**：保存当前左右栏宽度，最多 3 套，可应用/删除。
- **专注模式**：F 切换、Esc 退出，隐藏左右栏让图表占满；截图 `focus-mode.png`。
- **窗口位置记忆**：第二主窗口、独立 K 线窗口分别持久化 bounds（主窗口原逻辑不变）。
- **下载落盘**：主进程 will-download 显式写入系统下载目录，实存全市场 CSV（5,615 行/557 KB）。
- **1024 宽复核**：F10 17 页签自动换行，scrollWidth=clientWidth=961。
- **Web 写操作验证**：`state.patch` 实测新增分组并落 localStorage（2→3 组），非只读。
- **Web 截图验收**：`scripts/web-shot.cjs` + `npm run shot:web`，1440×900 实拍 Web 只读页。
- **选股股票池**：选股结果一键存为新自选分组（100 只），截图 `screener-pool.png`。
- **矩阵复核**：校正公告/财务/龙虎榜/盘后下载/本地行情/数据湖等过期状态；124 个截图引用全部存在。
- **预警「或」组合**：条件关系可选且/或；新增 OR 测试；188 TS。
- **多预设并行跟踪**：最多 10 个预设各自 60 秒更新自动池；修复 tracking 数组 IPC 克隆。
- **自动选股池**：单预设 60 秒重扫，整组替换「自动池 · 预设名」；实测跟踪中/自动池出现。
- **选股条件预设**：保存/应用/删除最多 10 个条件；截图 `screener-presets.png`。
- **60轮新预算**：max 200→260；目标 active；首项全市场排行。
- **0x056a 历史探测**：历史日期实测 0 点，确认仅当日；撤回日期选择器。
- **1024 行情头部**：名称/价格/按钮自动换行，修复名称逐字竖排与指标重叠。
- **Web 1024 验收**：web-shot 支持宽高环境变量；1024×720 三栏正常。
- **F10 按需加载**：打开只取公告，切页签才请求对应数据；截图 f10-lazy.png。
- **除权除息标记**：日 K 用 D 标出除权派息日；截图 kline-dividend.png。
- **最近搜索键盘导航**：↑↓/回车可打开最近记录。
- **K 线导出周期**：日/周/月 × 120/240/480；实测周K6只/720根。
- **F10 19 页签 1024 验收**：两行换行，无横向溢出；截图。
- **行业 HTTP 路由测试**：mock 桥接响应；Python 110。
- **涨跌分布纯函数**：13 档边界修正，合计 5615；202 TS。
- **F10 行业**：行业汇总/行业新闻/行业研报三区；实测新闻 100 行。
- **持仓导出**：组合分析导出 CSV；实测贵州茅台 100 股。
- **配置备份**：设置面板导出/导入 JSON；截图 settings-backup.png。
- **复盘速度**：0.5/1/2/4x；截图 replay-speed.png。
- **均线周期可配**：设置里改 3 条 MA 周期，图表实时生效；截图 chart-ma-config.png。
- **涨跌分布**：全市场 5615 只按 13 档绘制红绿柱；截图 market-distribution.png。
- **自动归档**：工作日 15:05–15:40 自动归档全市场；纯函数 3 测试。
- **分时预警线**：分时图同样画价格目标线；截图 minute-alert-line.png。
- **预警目标线**：价格预警在日 K 画虚线/标签；截图 kline-alert-line.png。
- **最近搜索**：搜索框聚焦显示最近 8 条，可清空；截图 search-recent.png。
- **OBV 能量潮**：面板/副图；197 TS；截图。
- **DMI/ADX**：+DI/-DI/ADX 三线，面板/副图；196 TS；截图。
- **BIAS 乖离率**：6/12/24 三线，面板/副图；195 TS；截图。
- **CCI 顺势指标**：指标面板/副图/参数；194 TS；截图。
- **WR 威廉指标**：指标面板/副图/WR 参数 0–100；193 TS。
- **多股同列 9 格**：6/9 格切换，最多 9 只；截图 multi-9.png。
- **主图公式**：公式面板「应用到主图」，归一化叠加 + 清公式；截图 chart-formula.png。
- **窗口置顶**：图表「置顶」切换当前窗口 always-on-top；截图 chart-pin.png。
- **状态栏涨跌停**：0x054b 全市场快照计数，显示「停 53/148」；109 Python。
- **成交明细全部**：一键加载 1800 笔；实测 1800 行。
- **资金流四档**：点击日期展开超大/大/中/小净额；截图 `money-flow-tiers.png`。
- **涨停/跌停/炸板**：全市场 MAC 快照本地判定（10/20/30/ST5），异动面板新增 4 页签；192 TS。
- **全市场排行**：排行榜切「全市场」按 MAC 排序 5,615 只/前 300；截图 `ranking-full.png`。
- **第200轮收尾**：188/108；139截图零缺失；180/30/1/6；目标保持 active，不虚假完成。
- **第198轮状态**：工作区干净、229 提交领先、139 截图零缺失、180/30/1/6。
- **AppImage 结构核对**：desktop Exec/StartupWMClass、ELF 主程序、侧车 pong。
- **deb 结构核对**：桌面 Exec/Icon/StartupWMClass、512 图标、ELF 主程序、侧车 ping 通过。
- **最终核对**：139 个截图引用零缺失；矩阵 180/30/1/6；包哈希与报告一致。
- **验收报告**：新增 `docs/10-验收报告.md`，汇总证据/缺口/复现命令。
- **HTTP 路由验收**：11 条新接口真实 200；F10 数据桌面/Web 共用。
- **合法边界审计**：仅 TDX 端点；无交易/7727/付费数据；命令证据入 docs/09。
- **Web 通知授权**：设置内申请 Notification 权限，授权后预警走系统通知；实测状态「已授权」。
- **桥接验收**：9 个 F10/数据湖命令逐个实测（56/30/1/9/3/180/18/1679/5615 行），130 个截图引用全存在。
- **收盘归档脚本**：`npm run archive:snapshot`，cron 可挂；实测 5,615 行。
- **数据湖归档历史**：列最新 20 个 trade_date、行数/大小/SHA；108 Python。
- **F10 增减持计划**：7615 `gdzjcjh` 6 行，金额区间/进度/已增持；107 Python。
- **F10 实控人**：7615 `kggd` 控股股东/实际控制人/控制关系；106 Python。
- **数据湖快照归档**：`lake/quotes/trade_date=/` JSONL.gz+CSV+manifest，5,615 行；105 Python。
- **F10 机构持仓**：7615 `jgcg` 9 期，家数/持股/占比/户均；104 Python。
- **F10 增减持**：7615 `cgbd` 44 行，变动区间/均价/数量/方式；103 Python。
- **F10 流通股东**：7615 `ltgd` 第二表 180 行，6 列精简展示；102 Python。
- **F10 股本结构**：结构/变动/回购/限售四分区；东方财富结构 18 行；101 Python。
- **F10 股东人数**：7615 `gdrs` 30 行，户均持股/环比/变动；100 Python。
- **F10 分红**：7615 `fhrz/fh`，东方财富 34 行；字段中文化；99 Python。
- **两融历史**：7615 区间通道 `rzrq_sj`，东方财富 122 行；98 Python。
- **全市场快照**：MAC 分批 5,615 只，导出代码/价格/涨跌幅/成交额/换手/量比/涨速 CSV。
- **自选 K 线批量导出**：6 只/1,440 根，CSV + JSONL.gz + manifest；97 Python。
- **图表 CSV**：当前 K 线（OHLCV）/分时（价格/均价/量）按 code+period 导出。
- **CSV 导出**：数据工具把 tdxstat / tdxstat2 全量导出为 UTF-8 BOM CSV，
  实测各 8,100 行；Parquet 可选脚本已实测，DuckDB 未接。
- **SQLite 只读查询**：数据工具支持单条 SELECT/WITH，最多 500 行；只读连接，
  拒绝多语句与非查询语句；默认查询 tdxstat。
- **公式自选池筛选**：对当前分组最多 20 只逐一拉 120 根日 K，
  公式最新值 > 0 的进入结果；点击结果切主图。不是全市场扫描。
- **公式单标的回测**：上一根信号→今日开盘成交，收盘计权益，单边手续费 0.03%；
  展示策略收益、买入持有、交易次数、最大回撤。
- **公式保存**：公式写入 AppState.formulas，支持保存/删除/点击应用；
  仍不保存到通达信格式，也不做公式选股/回测。
- **公式预览**：安全表达式求值（MA/EMA/REF/ABS/MAX/MIN/CROSS + 四则/比较），
  与收盘价叠加显示；不保存公式、不执行任意代码，未知变量/函数直接报错。
- **逐笔复盘**：当日/历史日期逐笔 500 笔内回放，显示最近 20 笔价格/量/方向；700ms/笔。
- **分时复盘**：当日 MinuteTrend 逐分钟切片回放；与日 K 共用控制条，切片不请求未来数据。
- **日 K 复盘**：逐根前进/播放（700ms）、时间轴、当前 OHLC/量/涨跌幅；
  图表只接收 `bars.slice(0, index+1)`，不请求未来数据。
- **条件选股**：全市场 5,579 只按价格/涨幅/成交额/换手/振幅筛选，
  结果最多 100 条、可点击切股；扫描结果缓存 60 秒。
- **板块指数报价**：`tdxzs.cfg` 映射 880xxx（银行 880471、光伏 880544…），
  行业/板块详情显示指数价格与涨跌幅；板块 K 线仍未接。
- **本地行情预警**：价格/涨幅/量比/换手/振幅规则、同一天同规则只触发一次、
  应用内 toast + Electron 系统通知；Web 端在已授权时用浏览器通知。
  规则随 AppState 持久化，标题栏铃铛打开规则与触发记录。
- **行业分类**：`0x06b9` 下载 `tdxhy.cfg`，结合 `zhb.zip` 的 `incon.dat`
  生成 111 个通达信行业/5,587 只成分股；板块弹窗新增「行业」页签。
- **板块/概念**：`0x06b9` 下载 `block_gn/fg/zs/dat`，按 384 字节头 + 2813 字节记录解析；
  概念 269 块/41,364 代码、风格 161 块/20,092 代码、指数 117 块、一般 100 块；
  左栏板块、右栏成分股行情，点击切股。
- **数据工具弹窗**：标题栏「数据」打开；一键下载 `zhb.zip` 摘要，或规范化导出
  JSONL.gz + SQLite + manifest，界面展示 8,100 行 / 16 分区 / 3 行空日期跳过。
- **共享拼音搜索**：搜索实现移到 `src/shared/search.ts`，桌面与 Web 共用；
  Web 首次搜索时才懒加载 pinyin-pro（独立 304 KB chunk），首屏不背词典。
- **Web 单端口托管**：`tdx_server.py --web-dir out/web` 同时提供静态页与 API/SSE，
  SPA 路由回退 `index.html`，路径穿越返回 403，支持 GET/HEAD。
- **Web SSE 行情流**：`GET /api/stream?codes=…&interval=…` 按 3 秒推送；
  Web 只读页从轮询切到 EventSource，保留 HTTP 快照作为首帧。
- **Web 只读前端**：`src/web` 注入 `window.api` HTTP 适配器，复用 `src/renderer`
  与 `src/shared`；`npm run dev:web` / `build:web`；Web 仍为只读、无写操作。
- **只读 HTTP API**：`python/tdx_server.py` 用标准库提供行情、排行、逐笔、竞价、
  资金流、F10、K 线、分时等 JSON 接口；默认只绑 `127.0.0.1:8765`，无鉴权，
  所有 Bridge 调用串行化；WebSocket/Web UI 尚未接。
- **数据湖规范化**：`tdx_stats_export` 写原始 ZIP + 按 `trade_date` 分区的
  `tdxstat.jsonl.gz` / `tdxstat2.jsonl.gz` + manifest（源 SHA256、解析器版本、
  分区计数、空日期跳过数）；另生成 SQLite 查询层 `stats.db`（tdxstat/tdxstat2/meta）。
- **批量快照 / 增量刷新**：`0x054c` 与 `0x0547` 的请求、解析、真实 fixture 落地；
  Python 测试 17 → 75。
- 实时行情主链路从 `0x053e` 切到 `0x0547`；`0x053e` 保留兼容与差分。

---

## [未发布] - v0.6 数据源迁移

**主题：A 股行情从腾讯 web 接口切到通达信 7709 协议。**

### 变更

- **行情层改为 Python sidecar**：`python/tdx_bridge.py` 持有 TCP 连接，
  主进程通过 JSON Lines 调用；协议/解析不再散落在 TS 业务代码里。
- **实时五档**：`0x053e` 批量拉取，单次最多 80 只；实测 80 只约 12ms。
- **K 线**：`0x052d` 服务端前复权（`adjust=1`），日/周/月与腾讯 qfq 逐根一致。
- **分时**：`0x0537` 240 点，含均价；五日分时用 5 次 `0x0fb4`，自带昨收。
- **北交所**：market=2 支持；指数行情与 K 线单独处理（无盘口、K 线多 4 字节）。
- **搜索**：本地 5.2 万条代码表 + `pinyin-pro`，支持 `gzmt` / `wly` / 中文 / 代码。
- **基本面**：`0x0010` 财务批量补流通市值、总市值、换手率、市净率。

### 移除

- 删除 `src/main/services/tencent/` 与 `http.ts`（腾讯 web 接口退出运行时）。
- 移除默认的「港股」分组：7709 不提供港股，留着只会显示「—」。
- 港股/美股搜索不再返回；手动输入会提示「当前数据源暂不支持港股/美股」。

### 工程

- 新增 17 个 Python 协议测试（真实报文 fixture）与 1 个桥接进程 ping 测试；
  TS 侧 196 → 157（删掉腾讯解析的 44 个用例，新增拼音搜索 4 个）。
- `npm run check` 现在包含 Python 测试；打包前自动跑 `build:python`（PyInstaller）。
- `electron-builder.yml` 通过 `extraResources` 把桥接程序放进 `resources/tdx-bridge/`。

### 文档

- 新增 `docs/00-项目章程.md`：固化六条目标（G1~G6）、A 股范围、
  双前端 + Python 后端目标架构、数据湖/ML 要求、功能对齐矩阵与决策优先级。
- 新增 `docs/08-通达信资料索引.md`：A 股协议矩阵（7709 / MAC / 7615 / 文件 / 离线）、
  主机与「最新 IP」策略、官方下载、参考项目与待验证清单。
- README / AGENTS / PRINCIPLES / PLAN / docs 01·02·03·05·07 按新目标更新；
  明确 Web 端与 Python 服务化仍是规划，不把目标写成现状。

### 验证（2026-10-30，Linux 开发机）

- `npm run check` exit 0：类型检查、ESLint、157 个 TS 测试、17 个 Python 测试全绿。
- `npm run build` exit 0；生产构建实机启动并截图（2560×1640），DOM 回读真实行情，
  默认窗口无滚动条，分时图正常绘制。
- Python 桥接直连六个命令全部 ok：`ping`、`quotes`、`kline`、`minute`、
  `five_day`、`code_list`（52,661 条代码）。
- **仍未验证**：PyInstaller 打包产物、Windows / macOS 实机（见 `PLAN.md` 第三节）。

### 已知边界

- 源码运行已验证；PyInstaller 单文件打包与 Windows 实机验证**尚未执行**
  （当前环境没有 PyInstaller / Windows）。
- 港股/美股/期货/期权不做，7727 扩展行情不接入；这是范围决定，不是待办。
- PE TTM、量比、涨跌停价暂缺，界面显示「—」。
- `serverTimeRaw` 语义未确认，行情时间暂用接收时间。

---

## [0.5.0] - 2026-09-22

**主题：把 K 线的缩放与光标做成一套完整交互** —— 键盘、滚轮、指针三种输入
落到同一套窗口换算上，并以用户实测反馈为准修掉了三处「用起来别扭」。

### 新增

- **K 线键盘缩放**：指针停在图上（或已聚焦图表）就能用 `↑` / `↓` 改变可见根数，
  当前档位显示在图表左上角。到顶 / 到底后不再变化（不做环绕）；换档后蜡烛会自动变宽变窄。
  均线仍在**全量**数据上计算再切片，所以窗口起点不会出现断头的均线；
  窗口最左那根的涨跌幅也仍与前一根比较，不会退化成 0。
- **十字光标支持键盘驱动**：`←` / `→` 逐根移动光标并读出那一根的数据；
  走到窗口边缘时**窗口跟着平移**，所以能一路走到任意一根，不必先缩小到 160 根；
  `End` 一键回到最新一根，`Esc` 收起光标。鼠标悬停与键盘共用同一份光标状态，
  两者不会各指一根。键位对齐主流行情软件（`↑↓` 伸张 / 收缩、`←→` 定位十字光标）。
- **滚轮缩放**：在 K 线图上滚动鼠标即换档，向上滚放大（与 `↑` 一致）。
  锚点是**鼠标位置那一根**，缩放前后它落在屏幕上的同一处 —— 指针停在哪儿就盯着哪儿看。
  触控板的「很多个小 deltaY」与鼠标滚轮的「一格 100」走同一套累加器，
  攒够一格才换档；一次事件最多换一档，快速甩动不会跳档。
- **记住缩放档位**：档位存进 `AppSettings.klineZoom`，下次打开还是这个尺度
  （写入时即落盘，走的是既有的设置通道；旧存档没有这个字段也能正常启动）。

### 变更

- **K 线档位表加密**：`160/120/80/50/30` → `160/140/120/100/85/70/60/50/40/35/30`
  （相邻比例由 1.5~1.67 收到 1.25 以内）。用户实测反馈「缩放幅度太大、一下跳太多」，
  代价是换档要多按几下 —— 所以滚轮才是它的主要入口。这条要求已经写成回归测试
  （`chart-geometry.test.ts` 里断言相邻档位比例 ≤ 1.25）。

### 修复

- **缩放后光标指到的 K 线会漂移**（用户实测反馈）。
  根因是状态里存的是**窗口内的相对下标**，窗口一变，同一个下标就指向了另一根 K 线。
  改为存绝对下标，并让缩放以光标为锚点重算窗口 —— 贴到数据右端时窗口无法再右移
  （不能在最新一根右侧留白），此时只能钳位，但光标**始终留在窗口内**（`docs/06` 第 23 条）。
- **第一次用键盘怎么按都没反应，焦点还跑到上面的 tab 上**（用户实测反馈）。
  根因是键盘监听挂在图表自己身上 —— 等于「必须先点一下图，键盘才生效」，
  可滚轮不用点就能用，同一张图两套规则，第一次必然踩空。
  点完「日K」标签后焦点留在那个按钮上，`↑` 落在按钮上、图一动不动，
  Chrome 又因为「发生了键盘操作」把焦点圈画到了那个标签上。
  改成「**指针在图上，或图有焦点**」就归这张图管（判断抽成纯函数 `chartOwnsKeys` 单独测），
  接管的同时把焦点收回图表；落在输入框里的按键一律让路
  （搜索框要用 `↑↓` 选联想项，见 `docs/06` 第 26 条）。

### 工程

- 单元测试 147 → **196**：新增可见窗口换算、档位切换、以光标为锚点的缩放、
  光标步进与边缘平移、鼠标位置换算、滚轮累加器、档位吸附、键盘归属判断，
  以及「每一档的蜡烛实体宽度都落在可读区间」「相邻档位比例 ≤ 1.25」——
  把**视觉指标**和用户提的手感要求都写成回归测试。
- 截图工具（`src/main/capture.ts`）新增五个环境变量：
  `PYTHONTDX_CAPTURE_CLICK` / `_FOCUS` / `_KEYS` / `_PROBE` / `_EVAL`。
  可以先把界面点到某个状态、注入**真实按键**、再把结果读回终端，
  **键盘交互从此也能自动验证**，不必只靠手按。三个真实缺陷就是这么查出来的
  （见 `docs/06` 第 22 条）。
- `PYTHONTDX_CAPTURE_KEYS` 现在同时接受 DOM 键名与 Electron 加速器键名
  （`ArrowLeft` 与 `Left` 等价）。写成 DOM 键名时 `sendInputEvent` 不报错、
  只是**按键毫无反应**，静默失败过一次，索性两种都收（`docs/06` 第 24 条）。
- 截图工具新增 `PYTHONTDX_CAPTURE_WHEEL`，可以注入滚轮（写法 `-100@.chart-host@0.25`）。
  它内部会把 deltaY 换算成 DOM 的单位（**符号相反、数值还要除以 `devicePixelRatio`**），
  并在每次注入后把「请求值 vs 实收值」打出来自检 —— 这段换算本身就是先量出来再写的
  （`docs/06` 第 25 条）。
- 截图工具新增 `PYTHONTDX_CAPTURE_POINTER`（真实指针：`move@选择器@比例`、
  `click@选择器@比例`）。它的存在本身就是一条教训：程序化 `element.click()`
  **不会移动焦点**（焦点是 mousedown 的默认行为），所以「点完 tab 后焦点留在按钮上」
  这类问题用它复现不出来（`docs/06` 第 26 条）。
- 截图工具退出前会先把内存里的状态落盘。它走的是 `app.exit()`，
  而 `app.exit()` **跳过 `before-quit`** —— 正式关窗口才有的落盘时机，
  于是「点完档位马上退出」丢过一次设置。

### 文档

- 新增 `docs/07-手动编译发布手册.md`：把「从代码改完到把 exe 交出去」的
  八步流程、每步的判定标准、故障速查表与验收清单写成一份可照着敲的手册。
  `PLAN.md` 第九节精简为总览并指向它，避免两处流程各自漂移。
- `README.md` / `AGENTS.md` 的文档索引补上 `docs/07`；
  修正 `docs/06` 的条目数（20 → 21，上一批新增了第 21 条）。
- `docs/01` 的打包示例从 `0.3.0` 更新到当前版本，并指向发布手册。

---

## [0.4.0] - 2026-09-21

**主题：还技术债** —— 不动功能面，把最薄的一块测试覆盖补上，
并修掉两个「看一眼就知道不对」的显示问题。

### 新增

- **图表加载骨架屏**：用 CSS 拼出图表形状（网格线 + 价格区 + 成交量柱）
  配合已有的微光动画。此前首屏拉数据时图表区是**一整块空白**，
  看起来像界面坏了；现在等待过程可预期。
- **分组拖拽排序**：分组标签可拖动调整顺序，落点用竖线指示。
  与「拖股票到分组」靠两个独立信号区分，互不打架。

### 变更

- **迷你走势图改用当日分时**（原为最近 30 个交易日收盘价）。
  原因是它与旁边那行「今日涨跌幅」尺度不一致，会出现
  「线在往下走、数字却是 +1.09%」的自相矛盾画面。
  现在两者说的是同一件事，每分钟刷新，非交易时段不请求。
- 迷你走势图新增原生 tooltip「当日分时走势」，明确标注周期。

### 修复

- **迷你走势图的颜色与涨跌幅不一致**：线色原本由「末点 vs 首点」决定，
  高开回落的股票（日内跌、相对昨收仍涨）会画成绿线却显示红色 +1.09%。
  改为由「现价 vs 昨收」决定，与涨跌幅数字**同源同色**。
- **K 线纵轴在退化区间下会除以 0**：最高价等于最低价时
  `yMax - yMin` 为 0，坐标换算产生 `NaN`。已在几何层加保护。
- **股票名里混进对齐填充空格**：腾讯会用空格给名字补位，
  实测 `五 粮 液`、`万  科Ａ`、`南  玻Ａ`、`特  力Ａ`。
  自选股列表里会直接显示成「五 粮 液」。
  新增 `normalizeStockName()`：纯中文名去掉全部空格，
  含英文字母的（如港股 `INTL GENIUS`）只压缩连续空白——不能一并抹掉，
  否则会变成 `INTLGENIUS`。
  存量数据会在下一次行情刷新时**自动纠正**（名称纠偏逻辑本来就是为此设计的）。

### 工程

- **图表坐标换算全部抽成纯函数**（`src/renderer/src/lib/chart-geometry.ts`，
  18 个导出函数）：横轴槽位、纵轴缩放、成交量区、路径生成、刻度算法、
  槽位定位、降采样。此前的唯一验证手段是「截图看一眼」，
  而截图看不出「第 137 个点的 y 坐标偏了 1.5px」。
- 图表组件退化为纯渲染层，可读性显著提升。
- 单元测试从 68 个增加到 **147 个**：新增 `chart-geometry.test.ts`（63 个）与
  `tone.test.ts`（8 个），并扩充了既有解析与格式化用例的边界覆盖。
- 顺带清理：`toneColorVar` / `toneLineVar` / `sparklineTone` 统一收进 `lib/tone.ts`，
  消除组件里重复的颜色判定函数。

### 文档

- `PLAN.md`：TD1~TD4 移入「已偿还」并记录还法；新登记 TD10（设置项无 UI）、
  TD11（迷你图请求量随自选股线性增长）。

### 已验证

- `npm run check` 全绿（typecheck 0 错 / lint 0 问题 / 147 测试通过）
- 分时图与 K 线图在重构前后**截图比对无差异**
- 迷你图颜色修正后用真实接口数据核对：6 只自选股的涨跌方向与线色全部一致
- 发布时重新构建并实测 Windows 产物：`pythontdx-0.4.0-portable.exe` **106.13 MB**、
  `pythontdx-0.4.0-setup.exe` **106.37 MB**（解包后 367.9 MB）；
  便携版从双击到页面加载完成**约 2 秒**（三次实测 2.03s / 1.96s / 2.01s），
  正常退出后 `%TEMP%\pythontdxPortable` 无残留。

---

## [0.3.0] - 2026-09-21

**主题：可分发** —— 从「能跑起来」到「能交到别人手里」。

### 新增

- **Windows 单文件便携版**：`npm run build:win:portable` 产出
  `pythontdx-0.3.0-portable.exe`（106 MB），双击即用，
  不安装、不写注册表、不需要管理员权限。
- **便携版数据就近存放**：检测到 `PORTABLE_EXECUTABLE_DIR` 时，
  自选股与设置写在 exe 旁边的 `pythontdx-data/` 里 ——
  拷走 exe + 这个目录，换台电脑接着用。
  目录不可写（只读介质 / Program Files）时自动回退到系统默认目录。
- 新增命令 `build:win:portable`（只出便携版）与 `build:win:setup`（只出安装包）。

### 变更

- `npm run build:win` 现在**同时产出** NSIS 安装包与便携版单 exe。

### 工程

- electron-builder 打包所需的 NSIS 工具链改走 npmmirror 镜像
  （`.npmrc` 的 `electron_builder_binaries_mirror`），
  解决国内网络下 GitHub Releases 不可达导致打包直接失败的问题。

### 文档

- 新增本文件 `CHANGELOG.md`。
- `README.md` / `docs/01` 补充分发章节与两种产物对比。
- `docs/06-踩坑笔记.md` 新增第 19、20 条（打包镜像、便携版的解压开销误区）。
- `PLAN.md`：记录第一阶段验收通过，更新待验证项与技术债。

### 实测数据（供参考）

在开发机（Windows 10 x64）上重复多次测量所得：

| 产物                           | 从双击到界面就绪 | 磁盘占用        | 说明                                                |
| ------------------------------ | ---------------- | --------------- | --------------------------------------------------- |
| `pythontdx-0.3.0-portable.exe` | **约 2 秒**      | 单文件 106 MB   | 每次启动解压约 368 MB 到 `%TEMP%\pythontdxPortable` |
| NSIS 安装版                    | **约 1 秒**      | 安装后约 368 MB | 无解压开销                                          |

> 单文件免安装只比安装版慢约 1 秒，代价比想象中小。
> 但注意：应用被**强杀**（任务管理器结束进程）时 `%TEMP%` 下会残留约 368 MB，
> 正常退出会自动清理。
>
> 这些数字是**实测**而非估算：便携版连续 3 次均为 2 秒，安装版 2 次均为 1 秒。
> 首次构建时 7z 工具链尚未缓存，产物为 95.6 MB；缓存就绪后稳定在 106 MB。

---

## [0.2.0] - 2026-09-21

**主题：工程化 + 交互深度** —— 补齐质量基建，并把行情软件该有的交互做透。

### 新增

**布局**

- **三栏一屏布局**：自选股 | 图表主区 | 盘口与指标。
  默认窗口尺寸下**不出现任何滚动条**：高度锁死、只有图表吸收剩余高度、
  盘口行按可用高度均分、SVG 按容器真实像素绘制。
- 窗口宽度不足时自动收紧两侧栏，把宽度让给图表。

**自选股**

- **多分组**：新建 / 双击就地改名 / 删除（被删分组的股票自动并入其它分组，不丢数据）。
- **拖拽排序**：原生 HTML5 拖拽，支持组内排序与拖到分组标签上的跨组移动，
  带落点指示线与分组高亮。
- **行内迷你走势图**：最近 30 个交易日收盘价，并发上限 3，3 分钟刷新一次。

**图表**

- **五日分时**：`TrendChart` 泛化为支持多日，每个交易日一条独立折线并按当天涨跌上色，
  带日期轴与交易日分隔线。
- **十字光标读数联动**：鼠标在图上移动时，卡片标题区的图例会切换成
  光标位置的 时间 / 价格 / 涨跌幅 / 均价 / 成交量，移开自动还原。
- 分时图纵轴留白从 8% 收紧到 2%，折线不再挤在中间一条带里。

**工程**

- **ESLint 10（flat config）** + typescript-eslint + eslint-plugin-solid，
  开启 `solid/reactivity`、`solid/no-destructure` 等响应式规则。
- **Vitest 单元测试**：68 个用例，全部以真实接口报文为 fixture，
  覆盖 A 股/港股字段布局、五日分时的昨收推导、累计量转增量、
  代码归一化、交易时段判断、数字格式化。
- **`npm run check`**：一条命令跑完 类型检查 + Lint + 测试。
- **`npm run shot` 界面截图验收**：构建后启动应用、等数据加载完、截图退出。
- **应用图标**：`scripts/generate-icon.mjs` 用纯 Node 手写 PNG/ICO 编码生成，
  零图形库依赖。
- **`npm run icon`**：改几个颜色常量即可重新出图。

**数据**

- 持久化结构 **v1 → v2 迁移**：扁平的 `watchlist` 变为分组的 `groups`。
  策略是「读的时候兼容旧格式、写的时候只写新格式」，用户无感知。
- `activeGroupId` 读入时校验引用完整性，避免删组后找不到当前分组。

### 修复

- **分时图昨收为 0**：`qt` 快照嵌在 `data.<代码>` 里而非响应顶层，
  按顶层取导致昨收变成 0、涨跌幅算出 `Infinity`、界面显示成 `—%`。
  （截图工具发现的，已补回归测试）
- **`000858`（五粮液）被误判为沪市**：`000xxx` 前缀存在歧义
  （既是深市主板股票，也可能是上证指数），现一律按深市股票解释，
  查指数需显式写 `sh000001`。（单元测试发现的，已补回归测试）
- **`TrendChart` 闭包捕获派生值**：横轴格数被闭包固定，切换天数后不会更新。
  改为在函数内读取响应式源。（ESLint `solid/reactivity` 发现的）
- **用 `createMemo` 做副作用**：改为 `createEffect` + `on`，语义更准确。
- **`ref={变量}` 的隐式赋值**：Solid 依赖编译器偷偷赋值，
  静态分析看不到，改为显式回调写法。

### 变更

- 状态栏去掉了一处写死的「延迟约 3s」占位文案（未实测的数字不展示）。
- `src/main/window.ts` 拆出 `diagnostics.ts`（渲染层日志转发）与
  `capture.ts`（截图工具），窗口模块回归单一职责。

### 文档

- 六篇文档全面同步：新增五日分时接口手册、三栏布局设计说明、
  8 条新踩坑记录（第 13~18 条）、路线图 v0.2 完成清单。

---

## [0.1.0] - 2026-09-21

**主题：从 0 到能跑** —— 搭起三进程骨架，打通真实行情数据。

### 新增

- **工程骨架**：electron-vite 统一管理 main / preload / renderer 三个构建目标；
  TypeScript strict + `verbatimModuleSyntax`；Prettier + EditorConfig +
  `.gitattributes`（统一 LF）+ VS Code 调试配置。
- **三进程分层与共享类型契约**：`src/shared` 存放三端共用的类型与纯函数，
  新增 IPC 通道漏实现会直接编译报错。
- **无边框窗口** + 自绘标题栏 + 窗口尺寸位置记忆（防抖落盘）。
- **腾讯行情接口接入**（实测校对过字段表）：
  实时快照（GBK，88/78 字段分别适配 A 股与港股）、当日分时、K 线（前复权）、
  搜索联想（GBK）。
- **HTTP 客户端**：GBK/UTF-8 双编码、超时、中文错误归一化、一次重试。
- **TTL 缓存 + 同 key 并发请求合并**：避免网络抖动引发重试风暴。
- **行情轮询器**：交易时段感知、盘后自动降频到 30s+、窗口不可见时暂停。
- **自选股**：增删、搜索联想添加（240ms 防抖 + 键盘导航 + 纯代码直加）、
  JSON 持久化（150ms 防抖 + 临时文件原子替换）。
- **手绘 SVG 分时图**：面积渐变、均价线、成交量柱、十字光标、
  价格 + 涨跌幅双轴刻度、固定 241 格横轴（盘中右侧留白）。
- **手绘 SVG K 线图**：蜡烛、MA5/10/20、成交量、浮层读数。
- **五档盘口**：挂单量占比条；**关键指标**面板：换手率、振幅、量比、
  市盈率、市净率、市值、涨跌停价。
- **深浅双主题**：全部颜色收在一份设计令牌（`tokens.css`）里。
- **开发期诊断**：渲染层 `console.*` 转发到终端，白屏排查不用开 DevTools。
- **持久化**：`electron-builder.yml`、`.npmrc`（npmmirror 镜像，
  解决 Electron 二进制下载失败）。
- 六篇说明文档：快速开始、架构设计、接口手册、设计系统、路线图、踩坑笔记。

<!--
  仓库地址：http://gitlab.riverzhou.cn/river/Electron-Vite-SolidJS

  版本对比链接可以按 Keep a Changelog 的惯例补在这里，GitLab 的格式是
  <仓库地址>/-/compare/<旧 tag>...<新 tag>，例如：
  [0.4.0]: http://gitlab.riverzhou.cn/river/Electron-Vite-SolidJS/-/compare/v0.3.0...v0.4.0

  暂时没写，是因为这些链接需要实际点开确认可用（内网地址在外部环境打不开），
  与其放一堆可能是死链的引用，不如留个格式说明。
-->
