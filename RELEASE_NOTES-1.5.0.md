# pythontdx 1.5.0 发布说明

- 版本：`1.5.0`
- 日期：2026-11-06
- 平台：Windows x64、Linux x64、macOS arm64
- 定位：社区 PR 收口 + 前后端边界重整 + 稳定性修复

## 这个版本做了什么

1.5.0 合并了社区 PR #1（收盘降频、涨跌家数缓存、F10 解耦行情锁），
并在审核后把“数据逻辑归 Python、TS 只负责展示”落成了硬约束：

- 行情、分时、五日、K 线增量、涨跌家数缓存全部只有 Python 一份实现；
- 桌面（IPC/stdio）与 Web（HTTP/SSE/WS）只是同一批 Python 方法的两种传输；
- 新增 `PRINCIPLES.md` A2/A8 与 `docs/23-前后端边界与双端一致性.md`；
- 删除 TS 侧重复的 `TtlCache`、`shared/kline-live.ts`、桌面涨跌家数缓存。

## 社区 PR #1

- 收盘/午休自动降频：桌面 `QuotePoller` 与 Web SSE/WS 按交易时段降速；
- 涨跌家数分页扫描，页间释放行情锁，Web 端按时段 TTL + 跨日失效；
- F10 路由移出行情锁；7615 网关按延迟排序、失败冷却 60 秒；
- 行情编排下沉 `Bridge.live_quotes`；
- 逐笔面板收盘后降频；Web/K 线推送防重入。

## 审核后修复

- **盘中行情时间偶尔显示「—」**：`updateTime` 被置为 JSON `null`，状态栏不认。
- **Windows 403 断连**：跨源写请求未排空 body，客户端收到 RST 而不是 403。
- **开盘第一帧被拖后**：低频轮询在 12:59:59.6 醒来会跳过 400ms 的边界。
- **取消订阅后仍空转**：在途请求的 `finally` 复活定时器。
- **实时 K 线每秒落盘**：tail 请求原来每秒重写一个 20 根 parquet。
- **Web 轮询堆叠**：`setInterval` 改为链式调度 + 退避。
- **Python 缓存无上限**：加 FIFO 上限，长期运行不涨内存。

## 架构与缓存

| 能力 | 1.5.0 实现 |
| --- | --- |
| 实时行情 | Python `live_quotes`（快照/增量/竞价/MAC 兜底） |
| 分时 / 五日 / K 线 | Python `minute_cached` / `five_day_cached` / `kline_cached` |
| 实时 K 线 | Python `kline_live`（tail 20 根、60 秒全量、断层重取、tail 不落盘） |
| 涨跌家数 | Python `breadth_begin/breadth_step`（分页、TTL、跨日） |
| 降频 | `pollDelayMs()` / `_quote_interval()` 同一组测试向量 |

## 验证

- `npm run check`：366 TS（364 通过 / 2 skipped）+ 324 Python（323 通过 / 1 skipped）。
- 新增 Python 测试：缓存 TTL、K 线增量/断层/不落盘、涨跌家数聚合/跨日、
  时段边界、403 请求体排空。
- 新增 TS 测试：`pollDelayMs`、临近边界、`QuotePoller` 取消后不空转。
- Windows 本机构建与启动验收见 `docs/07` 第四十七节；三平台二进制由
  tag `v1.5.0` 的 GitHub Actions run `42162458126` 构建，12 个资产已发布到
  <https://github.com/riverzhou/pythontdx/releases/tag/v1.5.0>。

## 升级提示

- 缓存行为与 1.4.0 不同：Web 的 K 线/分时也走 Python TTL；
  需要强制最新数据时传 `fresh=true`（推送路径已自动传）。
- 桌面主进程不再持有行情缓存；如果排查数据问题，先看 Python 日志与
  `Bridge` 缓存，而不是 Electron 主进程。
- 本地数据目录不变，升级不会删除已有归档。

## 已知边界

- 只做 A 股 + 通达信；7727/EX、港股/美股/期货不做；
- 桌面与 Web 各自启动一个 Python 进程；同机同时运行会有两条 7709 连接；
- 节假日表缺省只按周末判断；
- 全市场 ticks/history_minute 仍需显式确认磁盘空间。
