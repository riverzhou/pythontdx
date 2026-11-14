# pythontdx 1.6.0 发布说明

- 版本：`1.6.0`
- 日期：2026-11-06
- 平台：Windows x64、Linux x64、macOS arm64
- 定位：TDX 交易日历 + Electron/Web 部署模式收口

## 这个版本做了什么

1.6.0 把「节假日」从可选本地文件升级为**通达信自己的交易日历**，并明确
Electron 桌面与 Web 二选一部署：

- 内置 TDX 官方 `Except2025/2026.zip` / `neednote_RecentHSHoliday.txt` 快照；
- MAC `0x120F` 的 `today` / `lastTradingDay` 识别官方文件之外的临时休市；
- 新增 `market_status` 命令 / `POST /api/market_status`；
- `MarketSession` 增加 `holiday`（「节假日休市」）；
- 桌面 Poller、Web SSE/WS、分时/K 线/逐笔刷新、离线同步保护窗口共用同一份日历；
- 设计上 Electron 与 Web **不同时使用**，同机只允许一个 Python 后端持有 7709 连接。

## 交易日历

### 数据来源

1. **TDX 官方节假日文件**：
   <https://www.tdx.com.cn/products/autoup/Except2026.zip>（2025 年同理）；
   包内 `neednote_RecentHSHoliday.txt` 一行日期即休市日；
2. **MAC 0x120F**：`today` 与 `lastTradingDay`；`today != lastTradingDay` 表示今天休市；
3. **用户追加**：`<数据目录>/trading_holidays.json`，用于临时休市/调休。

仓库快照：`python/fixtures/tdx_holidays.json`（2025/2026），随 sidecar 打包。

### 行为

- 交易/竞价 1 秒；午休 30 秒；节假日/收盘 60 秒（行情）、30 秒（Web 轮询下限）；
- 交易日边界计算自动跳过节假日，春节/国庆不会每个工作日空转；
- 离线同步在节假日不触发 08:45–15:45 保护窗口；
- 前端标题栏/状态栏显示「节假日休市」；
- 未来年份未覆盖时按工作日 + 服务端状态，不伪造交易日。

## 部署模式

- 桌面模式：Electron 拉起 stdio sidecar，数据只走 IPC；
- Web 模式：单独运行 `tdx_server.py`，浏览器走 HTTP/SSE/WS；
- 两种模式共用同一批 `Bridge` 方法与同一套测试，但**不同时使用**；
- 不设计双开后端/共享缓存；未来多端同时访问应改为单 HTTP 后端的架构。

## 验证

- `npm run check`：369 TS（367 通过 / 2 skipped）+ 331 Python（330 通过 / 1 skipped）。
- 新增：TDX 官方节假日解析、0x120F 状态、`holiday` 会话、春节/国庆边界、
  离线窗口、Web/桌面 `market_status` 契约测试。
- 本地 Windows 构建与启动验收见 `docs/07`；三平台二进制由 tag `v1.6.0` 的
  GitHub Actions run `42166373012` 构建，12 个资产已发布到
  <https://github.com/riverzhou/pythontdx/releases/tag/v1.6.0>。

## 升级提示

- 旧版 `trading_holidays.json` 仍兼容，作为**追加**休市日；
- 1.6.0 起节假日状态来自 TDX 官方文件 + 服务端，不需要手动维护 2025/2026 日期；
- 若部署 Web，请只运行一个 Python 后端；不要与桌面同时连接同一批主站。

## 已知边界

- 只做 A 股 + 通达信；7727/EX、港股/美股/期货不做；
- 当前内置 2025/2026 官方快照，2027 需按 TDX 新 `Except2027.zip` 更新；
- 官方文件未列出的临时休市依赖 0x120F 当天状态；前端最多晚 5 分钟刷新；
- 全市场 ticks/history_minute 仍需显式确认磁盘空间。
