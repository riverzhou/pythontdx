# python/ —— 数据后端

通达信协议、行情调度与缓存、离线同步、数据湖。**数据逻辑的唯一实现**：
Electron 与 Web 都通过本地 HTTP 取数，渲染层不再持有第二套行情缓存（`PRINCIPLES.md` A2）。

只依赖 Python 标准库；DuckDB 等分析依赖只在数据工具里按需使用。

## 对外形态

| 形态                | 入口                          | 谁在用                                   |
| ------------------- | ----------------------------- | ---------------------------------------- |
| HTTP + WebSocket    | `tdx_server.py`（桌面以 `--serve` 拉起） | 桌面（主进程拉起）与 Web（单端口托管） |
| 进程内模块          | `from tdx_bridge import Bridge` | `scripts/`、测试、离线同步              |
| JSONL stdio（调试） | `tdx_bridge.py`               | 本地排查；**不再是应用的数据通道**       |

`tdx_bridge.py` 的 stdin/stdout 循环保留下来，一是方便单命令调试，二是 Nuitka
单文件下离线同步 worker 复用同一个可执行文件（`--offline-worker`）。

## 开发

```bash
# 只起后端：浏览器 / curl 直接访问
python3 python/tdx_server.py --port 8765
python3 python/tdx_server.py --port 8765 --web-dir out/web   # 顺带托管 Web 产物

# 调试单条 Bridge 命令（不经过 HTTP）
echo '{"id":1,"cmd":"ping"}' | python3 python/tdx_bridge.py
echo '{"id":2,"cmd":"quotes","payload":{"codes":["sh600519"]}}' | python3 python/tdx_bridge.py
```

解释器由 `scripts/python.mjs` 统一挑选，可用 `PYTHONTDX_PYTHON` 指定。

HTTP 路由清单与两端一致性核对表见 [`docs/02`](../docs/02-架构设计.md) 与
[`docs/23`](../docs/23-前后端边界与双端一致性.md)。

## Bridge 能力（命令名即能力，HTTP 路径见 docs/02）

| 命令 | payload | 返回 |
| --- | --- | --- |
| `ping` | — | `"pong"` |
| `code_list` | — | 全量代码表（约 5.2 万条） |
| `quotes` | `{ codes: string[] }` | `Quote[]`（`0x053e`，五档兼容） |
| `snapshots` | `{ codes: string[] }` | `Quote[]`（`0x054c`，买一/卖一） |
| `refresh` | `{ codes: string[], cursors?: Record<string, number> }` | `Quote[]`（`0x0547`，五档基线） |
| `category` | `{ category?, sortType?, start?, count?, ascending?, filterRaw? }` | `Quote[]`（`0x054b`，服务端排序） |
| `trades` | `{ code, start?, count?, date? }` | `TradeTick[]`（`0x0fc5` / `0x0fc6`） |
| `auctions` | `{ code, date?, selector?, start?, limit? }` | `AuctionPoint[]`（`0x056a`） |
| `file_read` | `{ path, offset?, size? }` | `FileContentChunk`（`0x06b9`，contentHex） |
| `file_download` | `{ path, chunkSize?, maxBytes? }` | 完整文件落盘 + SHA256 |
| `tdx_stats` | — | 下载 `zhb.zip`，返回两份 CFG 摘要与样本 |
| `tdx_stats_export` | — | 原始 ZIP + 按日期分区的 JSONL.gz + manifest |
| `money_flow` | `{ code }` | 最近 5 日资金流（`0x0ffc`） |
| `f10_catalog` | `{ code }` | F10 段落目录（`0x02cf`） |
| `f10_content` | `{ code, filename, start, length }` | F10 段落正文（`0x02d0`） |
| `kline` | `{ code, period, count }` | `KLineSeries` |
| `minute` | `{ code }` | `MinuteTrend` |
| `five_day` | `{ code }` | `MultiDayTrend` |
| `top_board` | `{ category?, size? }` | 9 个榜单（`0x053f`） |
| `unusual` | `{ count? }` | 主力监控 19 类事件（`0x0563`） |
| `volume_profile` | `{ code }` | 成交分布（`0x051a`；免费主站暂不响应） |
| `mac_server_info` | — | MAC 0x120F 交易日/交易时段 |
| `mac_symbol_info` | `{ code }` | MAC 0x122A 股票摘要 |
| `mac_quote_detail` | `{ code, date? }` | MAC 0x122D 单只快照 + 分时 |
| `mac_kline` | `{ code, period, start?, count?, adjust? }` | MAC 0x122E K 线 |
| `mac_auctions` | `{ code, start?, count? }` | MAC 0x123D 竞价 |
| `mac_tick_charts` | `{ code, date?, days? }` | MAC 0x123E 多日分时 |
| `finance_history_catalog` | — | gpcw.txt 清单（计算服务器） |
| `finance_history_archive_save` | `{ filename }` | 下载 gpcw zip → `lake/finance_history` |
| `f10_stock_info` / `f10_topic_ids` / `f10_stock_score` / `f10_finance_diagnosis` | `{ code }` | 7615 补齐 Entry |
| `f10_industry_page` | `{ hy, section }` | 7615 行业 20 子页 |
| `offline_sync_catalog` | — | 数据集/预设/窗口状态 |
| `offline_sync_status` | — | 当前任务进度（priority 请求） |
| `offline_sync_start` | 见 `offline_sync.normalize_options` | 启动多进程并行同步 |
| `offline_sync_cancel` | — | 取消并回收 worker |
| `shutdown` | — | `"bye"` 后退出 |

成功：`{"id":1,"ok":true,"result":...}`；失败：`{"id":1,"ok":false,"error":"中文原因"}`。

## 目录

```text
python/
├─ tdx_server.py        入口：HTTP/WS 门面 + 静态页面托管
├─ tdx_bridge.py        门面 + Bridge 编排：行情/逐笔/竞价/选股、本地缓存、备份恢复
├─ tdxproto/            协议层（单向依赖，base 不依赖本包其他模块）
│  ├─ base.py           异常、数据目录、代码归一化、市场常量
│  ├─ constants.py      命令号、批量上限、TTL、connect.cfg、主站选择、合并规则
│  ├─ cache.py          进程内缓存规则（TTL/容量/键）
│  ├─ codec.py          帧编解码、varint、u16/u32/f32、量纲换算
│  ├─ session.py        单会话握手、请求-响应配对、心跳
│  ├─ requests.py       请求体构造
│  ├─ parsers.py        响应解析（行情/K 线/分时/F10）
│  ├─ blocks.py         板块与扩展数据解析（自定义板块/榜单/异动/成交分布）
│  └─ business.py       全市场代码索引（CodeIndex）与筛选
├─ tdx_mac.py            MAC 0x1c / 0x12xx 行情
├─ tdx_mac_ext.py         MAC 扩展：服务端信息、摘要、K 线、竞价、多日分时
├─ tdx_f10.py            7615 TQLEX 在线 F10 / 公告
├─ tdx_local.py           本地 .day 文件读取
├─ subscription_hub.py    进程内订阅合并（同一组代码只轮询一次）
├─ push_manager.py        面板级推送服务端调度
├─ offline_sync.py        离线全量同步：多进程 × 多线程 × 多服务器
├─ *_archive.py           一类数据一个归档器（snapshot/tick/auction/flow/code/…）
├─ data_*.py              数据目录、覆盖统计、完整性校验
├─ formula.py / patterns.py / gbbq.py   领域计算（纯函数）
├─ tests/                 测试（34 个 test_*.py；`__init__.py` 让 discovery 递归）
├─ fixtures/              真实报文与节假日快照
├─ build.py               Nuitka 打包
└─ connect.cfg            内置主站列表（随包分发）
```

模块归属规则、命名与「新代码放哪」见 [`docs/24`](../docs/24-项目结构与命名规范.md)。

## 测试

```bash
npm run test:python
# 等价于：python3 -m unittest discover -s python -p 'test_*.py' -v
```

- 测试与源码**分目录**：源码在 `python/`，测试在 `python/tests/`；
- 一个模块一个 `test_<模块>.py`，跨模块回归包用 `test_<主题>_regressions.py`；
- 报文类用例一律读 `python/fixtures/*.hex`，不在测试里内联长 hex。

## 打包

```bash
python3 -m pip install -r requirements.txt
python3 python/build.py          # 或 npm run build:python
# 产物：python/dist/tdx-bridge（Windows：tdx-bridge.exe）
```

`electron-builder.yml` 的 `extraResources` 把它复制到 `resources/tdx-bridge/`；
主进程在 `src/main/services/server.ts` 里按这个路径拉起 `--serve`。
**打包前必须先跑 `npm run build:python`**，否则 electron-builder 会报找不到 `python/dist`。

Nuitka onefile 产物是机器码，不携带 Python 源码；如果更在意启动速度或调试，
可以改 `--onedir`，同时调整 `extraResources` 与 `server.ts` 的路径。
