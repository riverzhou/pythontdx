# 17 · eltdx 协议差距与补齐清单

> 审计对象：本机 `D:\GitHub\eltdx`（Python API + Rust 协议引擎） vs `D:\GitHub\pythontdx`（纯 Python 实现）。
>
> eltdx 版本：`v3.3.2-2-gf3bfa3d`（`git describe`，2026-11-01 提交 `f3bfa3d`）。
> pythontdx 版本：`v1.3.0`（2026-11-04）。
>
> **审计快照**：2026-11-04 13:20 左右的工作区。pythontdx 工作区当时**存在并发未提交改动**
> （`code_archive.py`、`offline_sync.py`、gotdx 的 3 条新命令 `0x0563/0x053f/0x051a` 等），
> `python/tdx_bridge.py` 处于持续增长状态（7.2k → 7.8k 行；写作期间从 7,573 涨到 7,780，sha256 前缀也从 `63ad63a0` 变到 `826715e5`）。
> 因此本文 pythontdx 侧行号**只能当近似值**（±120 行都可能漂移），**复核请以函数名 grep 为准**；
> eltdx 侧未被改动，行号稳定。凡「快照行号」明显过期处，以函数名为准即可，不影响结论。
>
> 方法：静态阅读 + `grep` 常量/请求构造/解析函数/落盘调用 + 运行现有离线单测（`python -m pytest python/test_protocol_extra.py python/test_local.py`，16 passed）。
> 未联网抓包、未安装 eltdx、未运行 Rust；凡未实测的语义均标「未验证」。
>
> **许可**：eltdx 采用自定义「非商业学习与数据研究」许可（`D:\GitHub\eltdx\LICENSE`），
> 与项目 GPL-3.0-or-later 不兼容。本文只写协议结论与字段语义，**不复制 eltdx 源码、夹具或文档正文**，
> 短引用仅用于定位。补齐实现必须独立重写。

## 落地状态（主代理追加，2026-11-04 晚）

| 审计项 | 状态 | 落点 |
| --- | --- | --- |
| P0-1 `0x054c` 记录头校验 | ✅ 已修 | `_split_quote_records` / `parse_snapshots`；`test_p0_fixes.py` |
| P0-2 分时 5 类 keyed 归档 | ✅ 已修 | `python/code_archive.py` + 5 个 `*_archive_save` |
| P0-2b 其余 6 类 keyed 归档 | ✅ 已修 | block_meta/category_quotes/market_news/channel_news/f10_market/f10_detail |
| P0-3 短页截断 | ✅ 已修 | `full_kline` / `delisted_history` 只在空页停，重复页标 `complete=false` |
| P0-4 本地 `.day` 系数/残尾 | ✅ 已修 | `tdx_local.security_coefficients` + 残尾容忍 + 写回反向换算 |
| P0-5 `0x0ffc` 资金流落盘 | ✅ 已修 | `Bridge.money_flow` 写 `lake/money_flow`（`source=7709 0x0ffc`） |
| P1-3 `0x0010` 5 个股本字段 | ✅ 已补 | `parse_finance` 补 state/sponsor/legalPerson/B/H + recordHex |
| P1-1/1-2 行情/K 线字段 | ⚠️ 部分 | K 线 milli/volumeRaw/amountRaw、报价 currentHand/openAmount/recordHex、代码表扩展、0x0fc6 priceBase 已做；报价 tailMetrics 布局未验证、K 线 recordHex 未落盘 |
| P1-8 历史财务 gpcw | ✅ 已做 | `finance_history.py` + 计算服务器 0x06b9；5,572×658 实测 |
| P1-9 本地 GBBQ | ✅ 已做 | `gbbq.py`；本机 202,313 条验证 |
| P1-10 MAC 命令 | ⚠️ 14 ✅ + 1217 空分片：0x120F/1215/1217/1218/122A/122B/122C/122D/122E/122F/1231/1237/123D/123E/124A；1217 实测空分片 | docs/19 |
| P1-11 7615 | ✅ 7 Entry / 9 HQServ 页 / 20 行业子页 / 84 频道 / 涨跌停梯子 131 行 | docs/03 §3.14.2 |
| P1-12 generation/deadline/retry-safe | ⚠️ 部分：帧上限、单请求 deadline、重连清 push 队列已做；epoch/generation 与 send 完成标记未做 | 见 §5 |



---

## 0. 一句话结论

**命令字层面已经追平（eltdx 的 26 条 7709 命令 pythontdx 全部有常量、有请求构造、有 dispatch 入口；24 条数据命令都有解析，
0x0004/0x000d 只发不解析回包），
真正的差距在「字段是否落盘」「归档粒度是否按 key 分片」「本地文件系数/容错」「运行时语义」「7615/MAC 覆盖面」五处。**
其中归档分片与 0x054c 单记录错标是会造成**静默数据错误/数据丢失**的 P0；`docs/14`、`docs/15` 有多处
「已完成」描述与代码不符（既有过时低估，也有夸大）。

---

## 1. 审计范围与方法

### 1.1 两侧代码地图

| 层 | eltdx | pythontdx |
|---|---|---|
| 7709 命令 | `crates/eltdx-protocol/src/commands/*.rs`（14 个模块，约 6.8k 行） | `python/tdx_bridge.py`（解析/请求/业务/归档合一，约 7.8k 行） |
| 7709 运行时 | `crates/eltdx-runtime/src/*.rs`（16,762 行：Engine/Supervisor/Slot/pin/push） | `TdxConnection`（单 socket，`tdx_bridge.py:556` 起） |
| MAC | `src/eltdx/mac/`（bitmap/commands/client，约 4.2k 行） | `python/tdx_mac.py`（802 行） |
| 7615 F10 | `src/eltdx/f10/`（client 2,534 行 + fields/models/news，约 5.0k 行） | `python/tdx_f10.py`（1,576 行） |
| 本地文件 | `src/eltdx/offline/`（14 个模块，1,990 行） | `python/tdx_local.py`（207 行）+ `local_import.py` |
| 数据落盘 | 无数据湖（由调用方自理） | 20+ 个 `lake/*`、`cache/klines`、`exports/*` 数据集，manifest+SHA256 |

### 1.2 统计口径

- 「命令」指 7709 的 `msg_type`（u16），不是业务 API 名称。
- 「字段」指 wire 上可解析、eltdx 已建模的字段；「未落盘」指 pythontdx 解析后没有进入返回 dict / 归档列。
- 「可批量」指官方 bridge/HTTP/离线任务能否一次覆盖多代码或多 key；仅单只接口不算批量。
- 证据格式 `文件:行`；eltdx 用仓库相对路径，pythontdx 用 `python/...`。

### 1.3 审计边界

- 只看 A 股相关协议；EX 7727、MAC-EX、港股/美股/期货/期权、基金/债券 F10 不在补齐范围（见 §8.4）。
- 只审计「协议与技术」，不评价 UI。
- pythontdx 工作区并发新增的 3 条命令（0x0563/0x053f/0x051a）来自 gotdx 调研，**不属于 eltdx 对照范围**，本文只在命令计数时注明。

---

## 2. 命令级对照

### 2.1 7709 命令逐条对照（eltdx 26 条）

结论先行：**缺失命令字 0 条**。pythontdx 的 26 个 `CMD_*` 常量（`python/tdx_bridge.py:346-371`）逐一对应 eltdx 的 26 个
`TYPE_*` 常量（`crates/eltdx-protocol/src/commands/*.rs`），且每个常量都出现在真实的 `conn.request(...)` 调用里
（不是死常量）；`dispatch()`（`python/tdx_bridge.py:7119` 附近）也都有对应入口。
下表「差异」列才是真实差距。

| # | 命令 | eltdx 常量（文件:行） | pythontdx 常量（行） | 请求体逐字节一致 | pythontdx 解析函数（行） | 差异摘要 |
|---|---|---|---|---|---|---|
| 1 | `0x0004` 心跳 | `session.rs:8` | `:347` | 是（空体） | `_transact` 内联（`:665` 附近） | eltdx 解析心跳回包的服务器日期（`session.rs:81-96`）；pythontdx 读完即丢，不取服务器日期 |
| 2 | `0x000d` 握手 | `session.rs:9` | `:346` | 是（`b"\x01"`） | 无（`_connect` 丢弃回包） | eltdx 解析 189B 握手信息：服务器时间/两段交易时段/服务器名/产品标识（`session.rs:54-79`）；pythontdx 全部丢弃 |
| 3 | `0x000f` 股本变迁 | `corporate.rs:11` | `:369` | 是（2+7N） | `parse_capital_changes`（`:3208`） | 字段基本齐；无 `record_hex`/raw；尾部多字节直接报错（eltdx 容忍，`corporate.rs:238-260`） |
| 4 | `0x0010` 财务批量 | `corporate.rs:12` | `:368` | 是（2+7N） | `parse_finance`（`:3272`） | 解析 136B 中 **31 个 float 的 26 个**（缺 offset 20/24/28/32/36 五个股本结构字段），归档再少 7 项，且两个派生字段命名错误（§3.7） |
| 5 | `0x02c5` 板块元数据 | `resources.rs:160` | `:359` | 是（40B 文件名） | `parse_block_meta`（`:1653`） | 一致（eltdx 也只给 size+md5 字符串，不保留原始 32B） |
| 6 | `0x02cf` F10 目录 | `corporate.rs:634` | `:357` | 是（12B） | `parse_f10_catalog`（`:1763`） | 一致（eltdx 也只给 name/filename/start/length，不给 raw） |
| 7 | `0x02d0` F10 正文 | `corporate.rs:635` | `:358` | 是（102B） | `parse_f10_content`（`:1795`） | 一致；正文写 `lake/f10_pit`（parquet 单行 JSON） |
| 8 | `0x044d` 代码表 | `security.rs:6` | `:367` | 是（14B） | `parse_security_list`（`:3158`） | 只取 code/name/decimal/kind；丢 multiple、昨收、量比基准、未知字段（§3.16） |
| 9 | `0x044e` 代码数量 | `security.rs:7` | `:366` | 是（6B） | `parse_security_count` | 一致 |
| 10 | `0x0452` 特殊涨跌停 | `limits.rs:8` | `:370` | 是（14B） | `parse_special_limits`（`:2607`） | 字段齐；丢 f32 原始 4B；未知市场记录被跳过（eltdx 保留 `market=None` 记录） |
| 11 | `0x051b` 分时副图 | `minutes.rs:12` | `:363` | 是（28B） | `parse_minute_aux`（`:2730`） | 两种 selector 都支持；无逐点 `record_hex`/raw；归档分片见 §6 |
| 12 | `0x052b` 退市日线 | `delisted_bars.rs:12` | `:371` | 是（12B） | `parse_delisted_bars`（`:2634`） | 无 OHLC 合法性校验、无 prevClose、无 `record_hex`；翻页以短页停止（§3.2） |
| 13 | `0x052d` K 线 | `klines.rs:11` | `:360` | 是（42B） | `parse_bars`（`:2539`） | 有 amount/指数家数；缺千分价格、差分原始值、record_hex、可转债手数、`bar_time=end`；定点复权只支持单页（§3.1） |
| 14 | `0x0537` 当日分时 | `minutes.rs:13` | `:361` | 是（12B） | `parse_today_minute`（`:2684`） | 丢头部 `reserved_zero`；price<=0 的点被丢弃；无 record_hex |
| 15 | `0x053e` 旧版批量行情 | `quotes.rs:11` | `:348` | 是（8B 前缀+2B count+7N） | `parse_quotes`（`:1049`） | 丢 active1、服务器时间、现手、开盘金额、交易状态、4 个尾部指标、涨速/active2、record（§3.3） |
| 16 | `0x0547` 增量刷新 | `quotes.rs:12` | `:350` | 是（2+11N） | `parse_refresh`（`:1426`） | 丢 status/现手/开盘金额/active/tail；推送只在其他请求期间被动收割（§3.5、§5） |
| 17 | `0x054b` 分类行情 | `quotes.rs:13` | `:351` | 是（18B；`sort_reverse` 默认值有差异） | `parse_category_quotes`（`:1525`） | 丢内盘/外盘/after_outer/开盘金额/56B 尾巴大部分；`lockedAmount` 为自造（§3.6） |
| 18 | `0x054c` 显式代码快照 | `quotes.rs:14` | `:349` | 是（8B 前缀+2B count+7N） | `parse_snapshots`（`:1318`） | **单记录/子集返回时可能把他人记录标成请求代码**（P0）；丢 active1/时间/现手/开盘金额/tail（§3.4） |
| 19 | `0x056a` 集合竞价 | `auctions.rs:10` | `:354` | 是（28B） | `parse_auctions`（`:1619`） | 字段齐；丢 offset14 保留字节与 raw；默认 selector 0 vs eltdx 3（未验证语义） |
| 20 | `0x06b9` 服务器文件 | `resources.rs:10` | `:355` | 是（8+300B） | `parse_file_chunk`（`:1661`） | 内容以 `contentHex` 返回（2 倍内存）；未保留 trailing payload 原始字节 |
| 21 | `0x0fb4` 历史分时 | `minutes.rs:14` | `:362` | 是（11B） | `parse_history_minute`（`:3109`） | 第二个 varint（均价增量）被忽略；`avg` 用累计额/量**自造**（§3.11） |
| 22 | `0x0fc5` 当日逐笔 | `trades.rs:12` | `:352` | 是（12B） | `parse_trades`（`:1551`） | 无 date/datetime、无 priceAcc/priceDelta、无 record_hex；竞价特殊量语义 eltdx 也留空 |
| 23 | `0x0fc6` 历史逐笔 | `trades.rs:13` | `:353` | 是（16B） | `parse_trades`（`:1551`） | 价格基数 f32 被跳过不返回；其余同上 |
| 24 | `0x0fd1` 小走势 | `minutes.rs:15` | `:364` | 是（37B） | `parse_sparkline`（`:2770`） | 字段齐；无 raw、无 basePrice 原始 4B、无市场名回退 |
| 25 | `0x0feb` 近期分时 | `minutes.rs:16` | `:365` | 是（11B：selector u32 + market u8 + code 6B；已实测 `len=11`） | `parse_recent_minute`（`:3065`） | 字段齐；无 raw/record hex |
| 26 | `0x0ffc` 资金流日数据 | `money_flow.rs:9` | `:356` | 是（38B + msg_id 路由） | `parse_money_flow`（`:1684`） | 字段齐（21 个 u32+16 桶+13 派生）；**bridge 自身不落盘**（§6） |

补充：

- pythontdx 工作区另有 3 条 eltdx 没有的命令常量：`CMD_UNUSUAL=0x0563`、`CMD_TOP_BOARD=0x053F`、`CMD_VOLUME_PROFILE=0x051A`
  （`python/tdx_bridge.py:373-375`，来自 gotdx 调研，未提交）。因此「命令字数量」现在是 29 vs 26；
  但它们不属于本次 eltdx 对照，且没有 eltdx 侧交叉验证，本文不纳入差距结论。
- 所有 26 条请求体布局，本次逐条比对了 pythontdx 的 `*_data()` 与 eltdx 的 `frame()`：**字节级一致**
  （含 0x052d 42B、0x0547 11N、0x06b9 300B 路径、0x0ffc 38B + `0x7e2d` 路由、0x0feb 日期 selector 公式）。

### 2.2 命令级结论：三个「有 ≠ 全」

| 维度 | 结论 | 证据 |
|---|---|---|
| 命令字 | 26/26 全覆盖，0 缺失 | `tdx_bridge.py:346-371`；各 `conn.request(CMD_*)` |
| 请求布局 | 26/26 字节级一致 | 对照 `commands/*.rs` 的 `frame()` 与 `*_data()` |
| 字段落盘 | 约 7 条命令存在「解析到但没返回/没落盘」 | §3 各表 |
| 归档粒度 | 11 类 keyed 数据集同日只保留第一份（5 个分时族 + block_meta/category/资讯/F10 market/detail） | §6「同日后静默 skipped」 |
| 语义 | 翻页终止、单记录快照、0x0fb4 均价、本地系数有偏差 | §3、§4 |

### 2.3 MAC 命令对照

eltdx MAC 有 17 个 `MSG_ID`（`src/eltdx/mac/commands.py` 各处），pythontdx 只实现 5 个。

| MAC 命令 | eltdx（commands.py 行） | pythontdx（tdx_mac.py 行） | 业务 | 差距 |
|---|---|---|---|---|
| `0x122B` 批量报价 | `:81` | `:260` 请求 / `:272` 解析 | 自定义字段报价 | 位图 122 位齐（§3.19）；无 0x122B 之外的字段子集/后处理 |
| `0x122C` 板块成分 | `:162` | — | 板块成分报价 | **缺** |
| `0x122D` 当日分时 | `:341` | — | 单日分时 | **缺**（7709 0x0537 可替代） |
| `0x122E` MAC K 线 | `:247` | — | 支持复权的 K 线 | **缺**（7709 0x052d 可替代，但可交叉验证） |
| `0x122F` 逐笔 | `:566` | `:431` 请求 / `:385` 解析 | 秒级逐笔 | 已有（作为历史逐笔兜底） |
| `0x1231` 板块列表 | `:692` | `:777` | 板块列表 | 已有 |
| `0x1218` 资金流/所属板块 | `:780`、`:821` | `:513` 解析 | 资金流 | 已有（head_flag 1/2 两种；pythontdx 只做资金流） |
| `0x1237` 异动 | `:995` | `:662` 解析 | 沪深异动 | 已有 |
| `0x123D` 集合竞价 | `:879` | — | MAC 竞价 | **缺** |
| `0x120F` 交易时段 | `:1068` | — | 服务器交易时段 | **缺** |
| `0x124A` K 线偏移 | `:1127` | — | K 线数据偏移 | **缺** |
| `0x123E` 多日分时 | `:428` | — | 最多 5 日分时 | **缺**（pythontdx `five_day` 用 0x0fb4 循环） |
| `0x254D` 分时缩略采样 | `:1153` | — | 240 个价格点 | **缺** |
| `0x2562` 商品列表 | `:1184` | — | 扩展市场商品 | 不做（EX 范围） |
| `0x1215` 远程文件元信息 | `:1234` | — | 文件大小/hash | **缺**（0x06b9 可读内容但无元信息） |
| `0x1217` 远程文件分段下载 | `:1256` | — | 文件下载 | **缺**（0x06b9 已够用） |
| `0x122A` 个股特征快照 | `:620` | — | 简要特征 | **缺** |

**结论**：MAC 侧 5/17，缺 12 条；其中 6 条 A 股有实际价值（0x122C/0x122D/0x122E/0x123D/0x120F/0x254D）。

### 2.4 7615 F10 Entry 对照（A 股相关）

eltdx 的 7615 客户端有 159 个方法（含美股 mg_*、港股 hk_*、债券/权证/期货等 89 个非 A 股方法），
A 股相关约 70 个；pythontdx 有 32 个 `fetch_*`（`python/tdx_f10.py`），**A 股方向缺约 12 类入口**
（若按页签细算：行业 13 个 `hy_*` 页、HQServ 9 个衍生页另计）。

| 能力 / Entry | eltdx 证据 | pythontdx | 差距 |
|---|---|---|---|
| 涨跌停列表 `CWServ.cfg_fx_lbtt`（含 summary） | `f10/client.py:140-178` | — | **缺**；且需要另一个 7615 主机 `hot.icfqs.com`（`client.py:36`） |
| 股票基础信息 `comreq:gpquery` | `client.py:194-197` | 只用了 comreq 的 `zygcfx`（`tdx_f10.py:679`） | **缺** gpquery |
| 题材 ID 列表 `comreq:rdtcgn` | `client.py:204-207` | — | **缺** |
| 增发获配日期/明细 `fhrz_zfhpmx` | `client.py:1700-1708` | — | **缺** |
| 财务诊断 `cwzd` | `client.py:1715` | — | **缺** |
| 个股总评 `ggzp` | `client.py:1725` | — | **缺** |
| 题材内对比 `rdtc_gndb` | `client.py:1758-1768` | — | **缺** |
| 题材行情 `HQServ.hq_nlp_tcihq` | `client.py:1925` | — | **缺** |
| 行业分析 13 个 `hy_*` 页 + 通用 `industry_analysis` 10 section（`hy_summary`/`hy_stage_rise`/…/`hy_index`） | `client.py:1179-1283`、`:366-407` | 只 3 页（汇总/新闻/研报，`tdx_f10.py:1091-1095`） | **缺 10+ 页** |
| 9 个 HQServ 排行/衍生页（`stock_stage_gain`/`stock_main_funds`/`stock_industry_rank`/`stock_industry_pct_rank`/`stock_board_member_quotes`/`stock_valuation_percentile`/`stock_pepb_percentile`/`stock_history_trend`/`stock_finance_weights`） | `client.py:1960-2099` | 只有 `ranking_detail`/`valuation` | **缺 9 页** |
| 公告/新闻/路演 `digest` 8 分区 | `client.py:1792` | 8 分区齐（7+interaction） | 一致 |
| 资讯频道：84 个频道枚举 | `f10/news.py:173-210` | 22 个（`tdx_f10.py:1216-1238`） | **缺 62 个频道** |
| 指数成分/跟踪产品（全自动翻页） | `client.py:1486-1594`（`zs_cfgsj_cfgjcsj`、`zs_jbxx_gzbd`） | 有单页 section（`MARKET_REPORT_SECTIONS` 的 `index_flow_members`/`index_tracking`） | 缺「自动翻页/独立返回模型」 |
| 板块/指数/大盘 26 个 section | `docs/F10_7615.md`（26） | 23 个（`tdx_f10.py:1457-1481`） | 缺 3 个 |
| 基金 30 section | `docs/F10_7615.md` | 30 个（`tdx_f10.py:1384-1406`） | 一致（但基金不属 A 股重点） |
| 结果集列名/重复列/ColDes | `f10/client.py:2248`、`models` 处理 `__2` | 只保留 `ColName` 列表；`rows` 是数组（`tdx_f10.py:1150-1159`） | 缺「命名字典行 + 重复列重命名 + ColDes 兜底」 |

**主机差异**：eltdx 有 3 个 7615 base URL（`static.tdx.com.cn`、`hot.icfqs.com`、`page2.tdx.com.cn`，`client.py:35-41`）；
pythontdx 只有 `TQLEX_URL = http://static.tdx.com.cn:7615/TQLEX`（`tdx_f10.py:13`），且超时硬编码 12s、无重试、无 IPv4 优先
（`tdx_f10.py:226-248`；eltdx 的 IPv4 优先见 `f10/_http.py:12-62`）。这直接决定「涨跌停列表」这类新能力要先加主机。

### 2.5 批量/单次上限对照

| 项 | eltdx | pythontdx | 结论 |
|---|---|---|---|
| 代码表分页 | 1600（`limits.rs:14`） | 1600（`tdx_bridge.py:343` 附近） | 一致 |
| K 线单页 | 800（`limits.rs:16`） | 800（`bars_data` 校验） | 一致 |
| 逐笔单页 | 1800（`limits.rs:17`） | 1800（`TRADE_PAGE`） | 一致 |
| 刷新代码数 | 100（`limits.rs:22`） | 100（`REFRESH_BATCH`） | 一致 |
| 股本变迁批量 | 200（`limits.rs:23`） | 75（`CAPITAL_BATCH`） | 我们更保守（非缺陷，吞吐低 2.7×） |
| 文件块 | 30000/60000（`limits.rs:18-20`） | 30000/60000 | 一致 |
| 0x053e/0x054c 代码数 | 最多 65535（`quotes.rs:1066-1071`） | 80（`QUOTE_BATCH`） | **自限 80**；5000 只需 63 次往返（P2 性能） |
| 0x054b 每页条数 | 不限制（u16） | 80（`category_data` 校验） | 自限；配合 `breadth_begin/step` 每步 8 页 |
| 财务批量 | 65535（`MAX_COMMAND_ITEMS`） | 80（`FINANCE_BATCH`） | 自限；可评估放宽 |
| 竞价 limit | 500（`auctions.rs:19`） | 500（`AUCTION_LIMIT`） | 一致 |

---

## 3. 字段级差距

> 表头统一：**字段** | **eltdx 证据（偏移/含义）** | **pythontdx 现状** | **影响**。
> 「丢弃」指 pythontdx 读了字节但没有输出/落盘；「未读」指从未解析。

### 3.1 `0x052d` K 线（最重要）

eltdx 的 `KlineBar` 有 24 个字段（`crates/eltdx-protocol/src/commands/klines.rs:98-121`），pythontdx 的 bar dict 只有 7-9 个
（`parse_bars`，`python/tdx_bridge.py:2539`）。

| 字段 | eltdx 证据 | 含义 | pythontdx | 影响 |
|---|---|---|---|---|
| `open/close/high/low` | `klines.rs:100-103` | 元 | 有（`/1000`） | 一致 |
| `open_price_milli` 等 4 个 | `klines.rs:104-107` | 千分价格（整数） | **无** | 无法做无损对齐/回放 |
| `last_close_price_milli` | `klines.rs:108` | 上一根收盘千分价 | **无** | 涨跌停/复权审计少基准 |
| `volume_raw` / `amount_raw` | `klines.rs:109-110` | compact-float 原始 u32 | **无**（只输出解码值） | 无法验证解码、无法回放 |
| `volume_wire_value` | `klines.rs:111` | wire 解码量 | 部分（`volume`） | — |
| `volume_lots` 可转债特例 | `klines.rs:112`、`:223-228` | 可转债量已是「手」，**不再 /100** | 一律 `/100` | 可转债量小 100 倍（A 股边界品种，P2） |
| `amount` | `klines.rs:113` | 成交额 | 有 | 已追平 |
| `open/close/high/low_delta_raw` | `klines.rs:114-117` | 差分原始值 | **无** | 断点校验/异常检测缺 |
| `up_count/down_count` | `klines.rs:118-119`、`:196-204` | 指数涨跌家数 | 有（仅 kind=index） | 已追平 |
| `record_hex` | `klines.rs:120` | 单条原始 hex | **无** | 归档不可字节级追溯 |
| 记录尾部校验 | `klines.rs:238-246` | 多余字节报错 | 无校验 | 静默接受脏报文 |
| 指数最小记录 20B | `klines.rs:149-158` | 每条记录长度下限 | 只查 `16B` 下限 | 指数截断时可能错位解析或报错 |
| `bar_time="end"` | `src/eltdx/_bar_time.py`、`api/bars.py:23-31` | 分钟 bar 右端点 | **无** | 与 Tushare/同花顺对齐时差一个周期 |
| 自动翻页 | `api/bars.py:120-138`：「短页不代表结束，只有空页才停」 | 全历史 | `full_kline` 以短页停止（`:6639` 附近） | **可能截断历史（P0）** |
| 定点复权自动翻页 | `api/bars.py` 同参数透传 anchor | 全量定点复权 | `full_kline` 的 `safe_adjust` 只允许 none/qfq/hfq（`:6639-6655` 附近） | 定点复权只有单页 800 根 |
| 显式 `include_raw` | `klines.rs` 各请求 `with_include_raw` | 保留 payload | 无 | 同 record_hex |

**证据补充**：pythontdx 的 `parse_bars` 会丢千分价/差分/record，是因为只构造 `date/open/close/high/low/volume/amount`
（`tdx_bridge.py:2539-2605`）；Parquet schema 也只有这 9 列（`python/parquet_store.py:33-42`）。

### 3.2 `0x052b` 退市日线

| 字段 | eltdx 证据 | pythontdx | 影响 |
|---|---|---|---|
| OHLC 合法性校验 | `delisted_bars.rs:105-118`（high/low 与 open/close 关系） | 无 | 脏数据入库 |
| `last_close_price_milli` | `delisted_bars.rs:100-104` | 无 | 缺基准 |
| `record_hex` / `include_raw` | `delisted_bars.rs:60-140` | 无 | 不可追溯 |
| 翻页终止 | `api/delisted_bars.py:83-96`：`page.count==0` 才停，max_pages 抛错 | 短页即停（`delisted_history`，`:6486` 附近） | **可能截断（P0）** |
| 代码归一 | `NormalizedCode::parse` 支持 `T000038`（`unit.rs` 测试） | `_delisted_code` 支持 T 前缀（`:6461` 附近） | 一致（但无测试） |

### 3.3 `0x053e` 旧版批量行情：丢弃最多

eltdx `LegacyQuote`（`quotes.rs:232-260`）字段 vs pythontdx `parse_quotes`（`:1049-1200`）：

| 字段 | eltdx 证据 | 偏移/含义 | pythontdx | 影响 |
|---|---|---|---|---|
| `active1` | `quotes.rs:235` | 记录头 `[7:9]` u16 | **未读** | 证券状态/活跃标志丢失 |
| `server_time_raw` | `quotes.rs:241` | varint，服务器时间 | **丢弃**（注释「语义未确认」） | 只能用本机接收时间 |
| `current_hand` | `quotes.rs:244` | varint，现手 | **丢弃** | 盘口最后一笔量缺失 |
| `open_amount_raw/yuan` | `quotes.rs:250-251` | varint，开盘金额 | **丢弃** | 集合竞价金额缺失 |
| `trading_status_raw` | `quotes.rs:254` | 5 档后 u16 | **丢弃**（`_u16` 后不赋值） | 停牌/收盘状态不可判 |
| `tail_metrics_raw[4]` | `quotes.rs:255` | 4 个 varint | **丢弃** | 旧版指标（涨速等）缺失 |
| `rise_speed_raw` | `quotes.rs:256` | 可选 i16 | **丢弃** | 涨速缺失 |
| `active2` | `quotes.rs:257` | 可选 u16 | **丢弃** | 状态位缺失 |
| `record_hex` | `quotes.rs:258` | 记录原始 hex | **无** | 不可追溯 |

pythontdx 的实际读取顺序见 `tdx_bridge.py:1049-1130`：`_u16` 交易状态后连读 4 个 varint 全部丢弃；
记录间 4 字节尾用 `is_record_start` 启发式判断（`:1106-1118`），语义与 eltdx 的 marker 校验不同但结果相近。

**数量校验差异**：`parse_quotes` 不接收请求列表，也不校验 `count` 与请求是否一致；`_quotes_7709` 用
`by_code` 过滤（`:4056-4064` 附近），服务端少返回时**静默少行**。eltdx `parse_legacy_quotes_payload`
用 `requested_codes` 校验 count 并对单只缺失做恢复（`quotes.rs:411-452`、`api/_batch.py:15-75`）。

### 3.4 `0x054c` 显式代码快照：P0 错标风险 + 字段缺失

| 字段 | eltdx 证据 | pythontdx | 影响 |
|---|---|---|---|
| 记录头 code 校验 | `quotes.rs:383-402`：单条返回他人证券时，**先完整解析再报 missing** | `_split_quote_records` 在 `len(items)==1` 时直接返回整段（`:1175-1176`）；`_parse_snapshot_record` 用请求的 market/symbol 而非记录头（`:1318` 附近） | **服务器返回他人记录时会标成请求代码（P0）** |
| `active1` | `quotes.rs:209` | 未读（价格从 offset 9 开始） | 状态丢失 |
| `time_raw` / `unknown_after_time_raw` | `quotes.rs:215-216` | 丢弃 | 服务器时间丢失 |
| `current_hand` | `quotes.rs:218` | 丢弃 | 现手缺失 |
| `open_amount_raw/yuan` | `quotes.rs:224-225` | 丢弃 | 开盘金额缺失 |
| `tail_raw` | `quotes.rs:228` | 丢弃 | 尾部指标缺失 |
| 内盘/外盘 | `quotes.rs:220-221` | **读了但没挂到 quote**（与 0x0547 不一致） | 字段静默丢失 |

**复现路径**：`parse_snapshots(body, [(0,'600519'),(0,'000001')], ...)`，若服务端只返回 `000001` 的记录且 `count=1`，
pythontdx 会把它当 `600519` 返回。现有测试只覆盖 2 条正常记录（`python/test_tdx.py:164`），未覆盖该分支。

### 3.5 `0x0547` 增量刷新

| 字段 | eltdx 证据 | pythontdx | 影响 |
|---|---|---|---|
| `active` | `quotes.rs:315` | 未读 | 状态丢失 |
| `status_or_reserved_raw` | `quotes.rs:322` | 读后丢弃 | 状态丢失 |
| `current_hand` | `quotes.rs:324` | 丢弃 | 现手缺失 |
| `open_amount_raw/yuan` | `quotes.rs:330-331` | 丢弃 | 开盘金额缺失 |
| `tail_raw` / `record_hex` | `quotes.rs:334-335` | 丢弃 | 不可追溯 |
| 推送队列 | `api/quotes.py` + runtime push（常驻 Slot 读线程） | 只在其他请求的 `_transact` 期间被动入队（`tdx_bridge.py:636-657`），`_drain_quote_pushes` 手动收割（`:4303` 附近） | **空闲时收不到推送（P2）** |
| generation | `ARCHITECTURE.md:47`：响应必须匹配 epoch/slot/TCP generation/request/message/boundary | 无 generation；`close()` 不清 `push_frames`（`TdxConnection.close`，快照 `:570` 附近） | **重连后旧帧可能被当成新帧合并（P1）** |

### 3.6 `0x054b` 分类行情

| 字段 | eltdx 证据 | pythontdx | 影响 |
|---|---|---|---|
| `active1` | `quotes.rs:265` | 未读 | 状态丢失 |
| `inside_dish/outer_disc` | `quotes.rs:278-279` | 读后丢弃（`_inside/_outside`） | 内外盘缺失 |
| `after_outer_raw` | `quotes.rs:280` | 丢弃 | — |
| `open_amount_raw/open_amount` | `quotes.rs:281-282` | 丢弃 | 开盘金额缺失 |
| `extra_pair_raw[10]` | `quotes.rs:295` | 丢弃 | 未公开扩展位 |
| `extra_meta_raw[24]` | `quotes.rs:298` | 丢弃 | 未公开扩展位 |
| `tail_raw[56]` / `record_hex` | `quotes.rs:299-300` | 丢弃 | 不可回放 |
| `lockedAmount` | eltdx 无此字段 | pythontdx 自造 `bids[0].price * bid_volume * 100`（`:1521`） | 口径自定，需在文档标注 |
| `sort_reverse` 默认 | `quotes.rs:115-130`：`sort_type==0` 时 0，否则 ascending ? 2 : 1 | 一律 2/1（`category_data`，`:722`） | **请求值可能不同（未验证影响）** |

### 3.7 `0x0010` 财务 136B：解析 26/31，落盘更少 + 命名错误

eltdx：`FINANCE_RECORD_SIZE=143`、`FINANCE_INFO_SIZE=136`（`corporate.rs:14-16`），
136B 内是 **31 个 4B float + 4 个头字段**（province u16@4、industry u16@6、updated u32@8、ipo u32@12），
共 35 个值，偏移 0/16/20/…/132（`corporate.rs:449-540`）。
pythontdx：`parse_finance` 偏移表只有 26 个 float + 4 个头字段（`tdx_bridge.py:3272-3340`），
**漏了 offset 20/24/28/32/36 五个字段**，因此 docs/14「只取 4 字段」是过时低估，docs/15「全部字段」也不成立：

| 缺失字段（eltdx 命名） | 偏移 | 含义 | 影响 |
|---|---|---|---|
| `guo_jia_gu_raw_float` | 20 | 国家股（万股） | 股权结构/国资分析缺 |
| `fa_qi_ren_fa_ren_gu_raw_float` | 24 | 发起人法人股（万股） | 同上 |
| `fa_ren_gu_raw_float` | 28 | 法人股（万股） | 同上 |
| `b_gu_raw_float` | 32 | B 股（万股） | A/B 股结构缺 |
| `h_gu_raw_float` | 36 | H 股（万股） | A/H 溢价分析缺 |

其余问题：

| 问题 | 证据 | 影响 |
|---|---|---|
| 归档 fields 列表少 7 项：`provinceId`、`industryId`、`floatSharesRaw`、`totalSharesRaw`、`floatSharesYuan`、`totalSharesYuan`、`reserved2` | `finance_archive_save`（`:6284` 附近）的 fields=… 列表 | 财务 PIT 缺省份/行业（选股/ML 常用） |
| `floatSharesYuan = floatShares*10000`、`totalSharesYuan = totalShares*10000` 命名错误 | `parse_finance`（`:3328` 附近） | 万股×10000 = **股**，不是元；下游易误用 |
| 无 `record_hex` / 143B 原始记录 | eltdx `corporate.rs:188`、`:560` | 不可字节级追溯 |
| 未知市场/非法代码**静默跳过**，不校验返回条数 | `parse_finance`（`:3288` 附近） | 少行不报错；eltdx 会校验 count/重复/缺失（`corporate.rs:322-390`） |
| 无 `on_missing`/批量回退 | eltdx `api/_batch.py:15-75`：整批失败时二分重试、缺失单只隔离 | 一只坏代码拖累整批或静默少行 |
| 无字段投影 `fields=` | eltdx `api/corporate.py:146-160` | 全字段传输，批量时浪费 |

### 3.8 `0x000f` 股本变迁

| 字段/行为 | eltdx 证据 | pythontdx | 影响 |
|---|---|---|---|
| 29B 记录全字段 | `corporate.rs:145-184`、`:385-448` | 有（`parse_capital_changes`，`:3208`） | 一致 |
| 类别名 1..15 | `corporate.rs:588-607` | 有（表 `:3204` 附近） | 一致 |
| 送转/回购类别集合 {2,3,5,7,8,9,10} | `corporate.rs:609-611` | `CAPITAL_SHARE_CATEGORIES` | 一致 |
| 尾部多余字节 | 容忍：`while offset < payload.len()`（`corporate.rs:250-260`） | `if pos != len(body): raise`（`:3248` 附近） | 服务器补零时报错（P2） |
| `record_hex` / 原始块 | `corporate.rs:176` | 无 | 不可追溯 |
| block_count 语义 | 用实际块数覆盖（`corporate.rs:288-296`） | 用头部 count 循环 | 头部 count 异常时行为不同 |

### 3.9 `0x0452` 特殊涨跌停

| 项 | eltdx | pythontdx |
|---|---|---|
| 13B 记录（market u8、code u32、upper f32、lower f32） | `limits.rs:13`、`:49-120` | 一致（`parse_special_limits`，`:2607`） |
| f32 原始位 | 保留 `upper_price_raw`/`lower_price_raw` | 无（只输出四舍五入值） |
| 未知市场 | 保留记录（`market=None`，`code` 仍给） | **跳过该记录**（`:2620` 附近） |
| 分页停止 | `scan_special` 空页停 | 空页停（`:6442`），一致 |

### 3.10 `0x051b` 分时副图

| 项 | eltdx | pythontdx |
|---|---|---|
| 两种 selector（0x00 买卖力道 / 0x0B 成交对比） | `minutes.rs:142-190` | 都有（`parse_minute_aux`，`:2730`） |
| 逐点 `record_hex` | `minutes.rs:304-323` | 无 |
| 时间标签 | `minute_index_label`（`unit.rs:642-649`） | `minute_label`（`:2670` 附近），公式一致（571/661） |
| 长度校验 | 买卖力道只查最小容量、成交对比精确长度 | 相同 |

### 3.11 `0x0537` / `0x0fb4` / `0x0feb` 分时

| 项 | eltdx | pythontdx | 影响 |
|---|---|---|---|
| 0x0537 头部 `reserved_zero` u16 | `minutes.rs:364` | 未读（直接 pos=4） | 丢失保留位 |
| 0x0537 price<=0 点 | 保留 | `continue` 丢弃（`:2700` 附近） | 点数与官方不一致 |
| 0x0fb4 第二 varint（均价增量） | 保留 `aux_delta_raw`（`minutes.rs:450-471`） | 读后丢弃（`_: pos = read_varint`） | 均价信息丢失 |
| 0x0fb4 `avg` | eltdx **不算**（`avg_price=None`，`minutes.rs:471`） | 用累计额/量自造（`:3128` 附近） | **自造字段，口径未验证（P1）** |
| 0x0fb4 `trade_datetime` | 有（日期+分钟） | 只有 time 标签 + date 字段 | 归档缺完整时间戳 |
| 0x0feb `date_selector_raw` | 回显 | 无 | 轻微 |
| 0x0feb `record_hex` | 有 | 无 | 不可追溯 |

### 3.12 `0x0fd1` 小走势

| 项 | eltdx | pythontdx |
|---|---|---|
| 42B 头 + f32 序列 | `minutes.rs:651-730` | 一致（`parse_sparkline`，`:2770`） |
| `base_price_raw` | 保留 4B | 无 |
| 响应市场回退 | `response_market` 用 `Market::from_id` 失败回退请求市场（`minutes.rs:666-670`） | 只给 `marketId` 数字 |
| raw payload | 有 | 无 |

### 3.13 `0x0fc5` / `0x0fc6` 逐笔

| 字段 | eltdx 证据 | pythontdx | 影响 |
|---|---|---|---|
| `price_base_raw_f32`（仅 0x0fc6） | `trades.rs:242-250` | 跳过不返回（`parse_trades`） | 价格基准不可审计 |
| `trade_datetime` | `trades.rs:174`、函数 `:392-400` | **无**（只有 time 标签；tick dict 无 date） | 归档只能靠分区目录；PIT/回放缺完整时间 |
| `price_milli` / `price_acc_raw` / `price_delta_raw` | `trades.rs:176-182` | 无 | 精度/异常检测缺 |
| `absolute_index` | `trades.rs:171` | `index = start+index`（等价） | 一致 |
| `unknown_tail_raw` / `reserved_zero` | `trades.rs:183-184`（0x0fc5/0x0fc6 语义不同） | 统一 `tailRaw` | 语义混淆 |
| `record_hex` | `trades.rs:185` | 无 | 不可追溯 |
| `event_kind` | `trades.rs:186` | 有 | 一致 |
| 竞价量字段 | eltdx 也置空（`trades.rs:376-377`） | 无 | 持平（都未确认语义） |

### 3.14 `0x056a` 集合竞价

| 项 | eltdx | pythontdx |
|---|---|---|
| 16B 记录：minute u16、price f32、matched u32、unmatched i32、reserved u8@14、second u8@15 | `auctions.rs:104-130` | 读 minute/price/matched/unmatched/second；**offset14 未读**（`:1619`） |
| `unmatched_direction_raw` i8 / `unmatched_volume` | `auctions.rs:119-121` | 有（方向 ±1、abs） |
| `price_milli` | `round(f32*1000)` | 有（`priceMilli`），一致 |
| `record_hex` | 有 | 无 |
| 默认 selector | **3**（`auctions.rs:16`） | **0**（`auctions`，`:5034` 附近），语义差异未验证（P2） |

### 3.15 `0x044d` 代码表

eltdx `SecurityCode`（`security.rs:125-143`）37B 记录：code 6B、`multiple` u16@6、name 16B@8、`volume_ratio_base` f32@24、
decimal u8@28、`previous_close_price` f32@29、`unknown3` 4B@33；并按前缀给 `category`/`board`（`security.rs:226-320`）。

pythontdx `parse_security_list`（`:3158`）只取：code、market、symbol、name、decimal、kind。
**丢失**：`multiple`、`previous_close_price`、`volume_ratio_base`、unknown raw、以及 ETF/A 股/B 股/北交所的可解释分类
（`classify_security` 只用前缀粗分 `ZS/ZQ/JJ/GP-B/GP-A`，`:560` 附近）。
影响：无法用代码表直接做「昨收/每手/量比基准」校验；`kind` 与 eltdx 的 `SecurityCategory/Board` 不等价
（例如 eltdx 把 588 归 ETF，我们归 JJ；把 920 归 A 股，我们前缀规则可能归 BJ 的 GP-A，需逐例核对）。

### 3.16 `0x02cf` / `0x02d0` / `0x02c5` / `0x06b9`

| 项 | eltdx | pythontdx | 差距 |
|---|---|---|---|
| 0x02cf 152B 记录（64 名称 + 80 文件 + 8 偏移/长度，GBK） | `corporate.rs:637-640`、`:764-810` | 一致（`:1763`） | 持平：两边都不给 raw |
| 0x02d0 12B 头 + GBK 正文（长度在 [10:12]） | `corporate.rs:818-840` | 一致（`:1795`） | 持平：两边都不给 raw |
| 0x02c5 38B（size u32 + 1 保留 + 32B MD5） | `resources.rs:160-240` | 一致（`:1653`） | 两边都只给字符串，无原始 MD5（持平） |
| 0x06b9 4B 长度 + 内容 | `resources.rs:80-140` | 一致（`:1661`） | 用 `contentHex`（2× 内存）；未保留 trailing payload 原始字节 |

### 3.17 `0x0004` / `0x000d` 会话

| 字段 | eltdx 证据 | pythontdx |
|---|---|---|
| 握手服务器时间 | `session.rs:54-79`（year/month/day/hour/minute/second @1-8） | 丢弃 |
| 两段交易时段（8 个 u16 分钟） | `session.rs:60-62`、`:110-120` | 丢弃 |
| 服务器名（GBK 68..152） | `session.rs:65` | 丢弃 |
| 产品标识（160..189）/ flags / tail control | `session.rs:66-69` | 丢弃 |
| 心跳回包服务器日期（u32 @6..10） | `session.rs:81-96` | 丢弃 |

影响：无法判断服务器交易日/盘后状态；`status=5`（盘后）与「服务器时间对齐」类需求缺基础数据（docs/14 也把 `status=5` 列为 P2）。

### 3.18 MAC `0x122B` FieldBit

- eltdx：`FieldBit` 枚举 **126 个成员 / 122 个唯一位值**（4 个双语义别名：0x5D/0x5E/0x88/0x8B），
  每个位自带 `fmt`（`<f`/`<I`/`<i`）和描述（`src/eltdx/mac/bitmap.py:20-196`）。
- pythontdx：`MAC_FIELD_NAMES` 有 **122 个键**（`python/tdx_mac.py:62-186`），位集合与 eltdx 的 122 个唯一位**完全一致**
  （缺的位相同：0x2F、0x32-0x36、0x3D、0x4C-0x56、0x5A、0x60-0x65、0x79、0x7C、0x7E、0x7F 两边都没有）；
  `INT_FIELDS`/`SIGNED_FIELDS` 与 eltdx 的 fmt 集合也一致（0x2E/0x58/0x5C/0x8C/0x8D 为有符号）。
- 因此 docs/15 的「99 个 FieldBit」是**低估**，docs/14 的「30 位」是**严重过时**。

剩余差异：

| 项 | eltdx | pythontdx |
|---|---|---|
| 字段子集选择 | `PresetField`/`FieldSelection`，默认 COMMON（`bitmap.py:229-300`） | 固定请求全部 122 位（`FIELD_BITS`），无子集 |
| 字段后处理 | `FIELD_POSTPROCESS`（0x4A AH 代码补零，`bitmap.py:212-214`） | 无（`fields["ah_code"]` 可能是无前导零整数） |
| 顶层便捷字段 | 全部字段在 `fields` dict；模型不另设顶层 | 24 个顶层字段 + `fields` 原始字典（`:340-370`） |
| 行数截断 | 行超长时 `break`（`commands.py:128-130`） | 相同 `break`（`:282`），一致 |
| 请求头控制区 | 0x122C 才用 4B 控制区（`bitmap.py:217-226`） | 无 0x122C |
| 响应位图 | 完整 20B，未知位也占槽（`commands.py:113-120`） | `row_size=68+len(slots)*4`，未知位占槽（`:280`），一致 |

### 3.19 7615 字段/结构

| 项 | eltdx | pythontdx | 影响 |
|---|---|---|---|
| 行结构 | dict 行（列名→值），重复列自动 `__2`（`client.py:2248`、`models`） | `rows` 为数组，只有 `columns` 列表（`tdx_f10.py:1150-1159`） | 下游必须按下标取值；重复列无法区分 |
| 列描述 ColDes | 有兜底（`client.py:2248-2255`） | 仅在个别 parser 兜底（`tdx_f10.py:188`） | 个别表列名为空 |
| `ErrorCode` | 保留在 F10Response，`ok` 判断 | 非 0 直接抛异常（`:226-248` 等） | 拿不到错误码/原始响应 |
| 超时/重试/地址族 | 8s 可配、IPv4 优先、多主机（`client.py:35-41`、`_http.py:12-62`） | 12s 硬编码、单主机、无重试（`tdx_f10.py:226-248`） | 弱网/代理环境不稳 |
| 84 频道 | 枚举（`news.py:173-210`） | 22 个（`tdx_f10.py:1216-1238`） | 频道资讯覆盖约 1/4 |
| 涨跌停列表 | 专用主机 + summary（`client.py:140-178`） | 无 | 缺一类数据 |

---

## 4. 本地文件能力

### 4.1 `.day` / `.lc1` / `.lc5` / `.5`

| 能力 | eltdx | pythontdx | 差距 |
|---|---|---|---|
| `.day` 读 | `offline/daily_bar.py:87-130` | `tdx_local.py:21-75` | 都能读 |
| `.day` 写 | `offline/daily_bar.py:132-155`、`write_daily.py` | `tdx_local.py:128-164` | 都能写（原子替换） |
| `.day` 追加 | `write_daily.py` + `alignment.py:36-77`（追加前对齐校验） | **无追加 API** | 缺追加/对齐保护 |
| 价格系数 | 按文件名判证券类型：沪 B 0.001、指数 0.01、沪基金/债券 0.001、深基金/债券 0.001（`daily_bar.py:20-33`、`:34-74`） | **一律 /100**（`tdx_local.py:53`） | **基金/债券/沪 B 价格 10× 偏大（P0）** |
| 成交量系数 | A 股 0.01、指数 1.0、沪基金/债券 1.0、深基金/债券 0.01（同上） | **一律 /100**（`tdx_local.py:53`） | **指数/沪基金量小 100 倍（P0）** |
| 残尾容忍 | 只遍历完整记录，残尾忽略（`daily_bar.py:90-91`、`:106`） | 文件长度非 32 倍数直接 `raise`（`tdx_local.py:28-29`） | **一个残尾字节让整份历史读不出来（P0）** |
| `adjust_flag`/`raw` | 保留（`models.py:24-28`） | 丢弃 | 不可追溯 |
| `close<=0` | 保留原始记录 | `continue` 丢弃（`:47-48`） | 行数不一致 |
| `.lc1/.lc5` 读 | `offline/min_bar.py:104-120` | `tdx_local.py:77-120` | 都能读 |
| `.lc1/.lc5` 量单位 | 保留 raw 浮点（`min_bar.py:63-76`） | `/100`（`:117`） | 口径不同（需确认「手」语义） |
| `.5` 价格 | 整数 /100（`min_bar.py:122-130`） | /100（`:94`） | 一致 |
| 分钟线追加 | `write_min_bar.py` + 对齐校验 | 无 | 缺 |
| 扩展市场 `ds/*.day` | `offline/ex_daily_bar.py`（含港股 amount 双解释） | 无 | 不做（EX 范围） |
| vipdoc 路径推断 | `offline/paths.py:1-90`（TDX_HOME/常见路径/市场→目录） | 无（本地文件必须显式传路径；`client_roots` 只找 T0002） | 缺「自动定位」 |

### 4.2 GBBQ（本地股本变迁，XOR 加密）

- eltdx：`offline/gbbq.py:280-364`，记录 `<B7sIBffff`（market、code、date、category、4 个 float），
  使用 1072B XOR 密钥三轮解密；密钥来源注释写明「从 pytdx 移植」。
- pythontdx：**无**。现有 `0x000f` 只能拿服务器端最近记录，无法离线复算历史 GBBQ，也无法与本地 `.day` 的除权缺口对账。
- 许可提示：若实现，必须从**许可兼容**的来源（如 pytdx 的 MIT 实现/公开协议文档）取密钥并登记 `docs/08`，
  **不得从 eltdx 源码复制**。未确认来源前不做（见 §8.4）。

### 4.3 历史财务文件 `tdxfin/gpcw*.zip`

- eltdx：`financial.py:54-160`（`0x06b9` 拉 `tdxfin/gpcw.txt` 列表 → 下载 zip → `offline/history_financial.py:109-260` 解析
  `.dat`：20B 头 `<1hI1H3L` + `max_count×11B` 索引 `<6s1c1L` + `report_size//4` 个 float32），并有 zip 炸弹限额。
- pythontdx：**无**。只有 `0x0010` 的最新快照（一份 136B/股），没有按报告期的历史财务序列。
  这是「财务 PIT 长期积累」最大的缺口（见 §8.2 P1-8）。

### 4.4 板块/行业文件

| 能力 | eltdx | pythontdx |
|---|---|---|
| `block_*.dat`（384B 头 + 2813B/条） | `offline/block.py:56-120` | `parse_block_dat`（`:2264`），一致 |
| `blocknew.cfg` + `*.blk` | `offline/block.py:120-164`，**校验文件名只含叶子名**（`:41-51`） | `parse_blocknew_cfg`（`:2378`）+ `block_file = base / f"{record['file']}.blk"`（`:5881`），**未防路径穿越（P2 安全）** |
| `tdxhy.cfg` / `incon.dat` 行业 | `offline/industry.py` | `parse_tdxhy`/`parse_incon_sections`/`parse_sector_indices`，基本一致 |
| 板块元数据 0x02c5 | 有 | 有，一致 |

---

## 5. 运行时技术

eltdx 的运行时是 Rust Engine/Supervisor/Slot（`crates/eltdx-runtime/src/`，16,762 行），
对外文档 `docs/ARCHITECTURE.md` 写明语义；pythontdx 是**单 socket + 一把隐式串行队列**（sidecar 逐条 dispatch）。

| 能力 | eltdx 证据 | pythontdx 现状 | 是否值得在 Python 独立重实现 |
|---|---|---|---|
| 连接池 | `PooledSocketTransport`（`src/eltdx/transport/pool.py:207-479`），Slot 独占 TcpStream | 单连接（`TdxConnection`，`:556`）；`cache_full_klines(workers>1)` 用**多个 Bridge 实例**（`:6705` 附近），每线程一条连接 | P2：可选 N 连接；注意 0x0547 推送与游标要按连接隔离，收益 < 复杂度时可只做「多进程分片」（offline_sync 已这么做） |
| 每请求 deadline | `deadline.rs:1-151`；一个单调绝对 deadline 覆盖排队/连接/握手/发送/响应/重试（`ARCHITECTURE.md:53`） | 只有 socket `REQUEST_TIMEOUT=8s`（`:336-337`），连接/发送/重试各算各的 | **P1：值得**。纯 Python 用 `time.monotonic()` 算剩余预算，`sock.settimeout(remaining)`，超时抛统一错误 |
| 重试 | `RetryPolicy`：普通 2 次、心跳 1 次，`retry_safe` 逐命令（`request.rs:751-782`、`ARCHITECTURE.md:55`） | 一次盲重试（`request`，`:655-674`），不区分「发送前/发送后」；partial send 也重发 | **P1：值得**。记录 `sendall` 是否完成 + 命令是否只读（我们 26 条全只读，可安全重试，但要避免 0x0547 游标请求重复消费） |
| TCP generation | 响应必须匹配 epoch/slot/generation/request/message 类型/发送边界（`ARCHITECTURE.md:47`）；`diagnostics.rs:125-176` | 无 generation；`close()` 不清 `push_frames`（`:563-569`），重连后旧帧可被 `_drain_quote_pushes` 当新帧 | **P1：值得**。`epoch += 1`，队列元素带 epoch，收割时丢弃旧 epoch |
| 限流 | **没有独立限流器**；admission 容量 = `pool_size + max_pending_requests`（`ARCHITECTURE.md:51`） | 无 | 不建议新增（两边都没有；批量的真正约束在服务端，靠 batch 上限即可） |
| 主机探活/排序 | `probe_host`/`probe_hosts` 并发 TCP 探测 + 持久化排名/最近成功时间（`src/eltdx/hosts.py:414-490`） | `speed_test_hosts` 并发探测（`:292-330`）+ 只持久化 `preferredHost`（`select_server`，`:3979` 附近）；有 connect.cfg 解析 | P2：值得补「最近成功/失败时间 + 延迟排序」，不必复刻排名文件格式 |
| 专用池 | 竞价/资金流独立节点（`ARCHITECTURE.md:39`；`hosts.py:269`） | 资金流有 `MONEY_FLOW_HOSTS` + 独立连接（`:334-343`、`:5292`）；竞价无独立池 | P2：竞价独立池（避免竞价高峰挤占 K 线） |
| 推送队列 | Slot 常驻读线程；decoded 队列上限 1024 帧/8MiB，满时丢最旧并抛 `PushOverflowError`（`ARCHITECTURE.md:63`） | 只在对其他请求等响应时被动入队（`_transact`），deque maxlen=1024 **静默丢最旧** | P1：`deque(maxlen)` 的静默丢弃要么改显式溢出标记，要么加后台读线程（P2） |
| 诊断 | `PoolDiagnostics`（`pool.py:74-104`）：active lease、epoch、generation、raw/decoded 峰值 | 无 | P2 |
| 关闭语义 | 1s 硬门、`FAILED_CLOSING` 状态（`ARCHITECTURE.md:67`） | `close()` 直接 close socket | 不需要复刻 |

**结论**：值得在 Python 里独立实现的只有 3 件——**deadline 预算、generation（含 push 队列清空/标记）、retry-safe 判定**；
连接池/限流/诊断按需（P2）。实现时只借鉴语义，不照抄 Rust 结构。

---

## 6. 数据落盘矩阵

### 6.1 逐数据集

「HEAD 基线」指提交 `8ea78ce`；「工作区增量」指 13:20 前未提交的 `code_archive.py`/`offline_sync.py`。

| 数据集 | eltdx 能力 | pythontdx 路径 | 粒度 | HEAD 可批量 | 备注 |
|---|---|---|---|---|---|
| K 线（日/周/月/季/年/分钟） | `bars.get` 全周期 + 定点复权 + 全历史 | `cache/klines/*.parquet` | 代码×周期×复权 | 是（`cache_klines`/`cache_full_klines`） | 定点复权只有单页；无 `bar_time` |
| 退市日线 | `delisted_bars.get` | `lake/delisted/<code>_day.parquet` | 代码 | 是（`delisted_archive_save`） | 短页可能截断 |
| 当日分时 | `minutes.today` | `lake/today_minute/trade_date=.../today_minute.jsonl.gz` | 日 | 否（HEAD：同日第二只被 skipped） | 工作区已改 `write_code_archive`（每代码一份） |
| 分时副图 | `minutes.aux` | `lake/minute_aux/...` | 日 | 否（同上） | 工作区已改 |
| 小走势 | `minutes.sparkline` | `lake/sparkline/...` | 日 | 否（同上） | 工作区已改 |
| 近期分时 | `minutes.recent` | `lake/recent_minute/...` | 日 | 否（同上） | 工作区已改 |
| 历史分时 | `minutes.history` | `lake/history_minute/...` | 日 | 否（同上） | 工作区已改；avg 自造 |
| 逐笔（当日/历史） | `trades.today/history` | `lake/ticks/trade_date=/<code>.parquet` | 日×代码 | 是（`tick_archive_batch`） | 缺 datetime/raw |
| 集合竞价 | `auctions.series` | `lake/auction/trade_date=/<code>.jsonl.gz` | 日×代码 | 是（`auction_archive_batch`） | 读取时自动归档（副作用） |
| 分类行情 | `quotes.list_by_category` | `lake/category_quotes/trade_date=.../category_quotes.jsonl.gz` | 日 | 否（HEAD：同日第二组 category/sort 被 skipped） | 工作区未改；需按 category+sort 分片 |
| 全市场快照 | `quotes.get_snapshots`/`legacy`/`refresh` | `lake/quotes/trade_date=.../quotes.jsonl.gz` | 日 | 是（`archive_snapshot`） | **数据源是 MAC 0x122B，不是 7709 0x054c**（`:4545` 附近） |
| 资金流日数据 | `money_flow.daily`（0x0ffc） | `lake/money_flow/trade_date=/<code>.parquet`（**MAC 0x1218**） | 日×代码 | 是（`mac_money_flow`） | 0x0ffc 自身不落盘；工作区 offline_sync 补写 |
| 财务 136B | `finance_batch` | `lake/finance/trade_date=.../finance.jsonl.gz` | 日 | 是（`finance_archive_save`） | 归档少 7 字段 |
| 股本变迁 | `capital_changes` | `lake/corporate/trade_date=.../capital_changes.jsonl.gz` | 日 | 是（`capital_archive_save`） | — |
| 特殊涨跌停 | `limits.special` | `lake/special_limits/trade_date=...` | 日 | 是（`scan_special_limits` 全表） | — |
| 板块元数据 | `resources.block_meta` | `lake/server_meta/trade_date=.../block_meta.jsonl.gz` | 日 | **否**（HEAD：同日第二个文件被 skipped） | 需按文件名分片 |
| 服务器文件 | `resources.download_file` | `lake/server_files/snapshot_date=.../catalog.json` + `raw/` | 日 | 部分（`file_download` 单文件；catalog 批量） | — |
| 板块/行业/龙虎榜/财务快照 | 无直接对应（eltdx 有 helpers） | `lake/datasets/snapshot_date=.../` | 快照日 | 是（`archive_datasets`） | 不在 `data_coverage`/`data_integrity` |
| F10 个股（7615） | `f10.*` | `lake/f10_pit/snapshot_date=.../<table>/<code>.parquet` | 快照日×表×代码 | 是（自动包装；offline_sync） | 少 12 个 Entry |
| F10 详情正文 | `f10.detail` | `lake/f10_detail/trade_date=...` | 日 | **否**（同日第二个 detail_type/id 被 skipped） | 需按 type+id 分片 |
| F10 板块/指数/大盘 | `f10.market_report` | `lake/f10_market/trade_date=...` | 日 | **否**（同日第二个 section 被 skipped） | 需按 section 分片 |
| 市场资讯 | `f10.market_news` | `lake/market_news/trade_date=...` | 日 | **否**（同日第二个 tab 被 skipped） | 需按 tab 分片 |
| 频道资讯 | `f10.channel_news`（84 频道） | `lake/channel_news/trade_date=...` | 日 | **否**（同日第二个 channel 被 skipped） | 需按 channel 分片 |
| K 线导出 | 无 | `exports/klines/<ts>/` CSV+JSONL | 批次 | 是（`export_klines`，最多 50 只） | — |
| 本地文件导入 | `offline` 读写 | `raw/local/<sha16>` + `normalized/local/*.jsonl.gz` + `local_bars.db` | 文件 | 单文件 | 系数/残尾问题见 §4 |
| 历史财务 gpcw | `financial.download_records` | **无** | — | — | P1 |
| GBBQ 本地文件 | `offline.read_gbbq` | **无** | — | — | P1（许可复核） |
| MAC 异动/板块 | `mac` 0x1237/0x1231 | 无归档（仅返回） | — | — | P2 |

### 6.2 归档分片问题（HEAD 基线，P0）

`write_dataset_archive()` 的幂等键是 **`trade_date` 目录 + 单一 `manifest.json`**：
目录已存在 manifest 就整体 `skipped`（`python/protocol_archive.py:26-47`）。
因此凡是「同一天多次调用、每次一个 key」的数据集，**第二次起静默丢弃**：

| 归档函数（快照行号） | key | 后果 |
|---|---|---|
| `minute_archive_save`（`:6924`） | 代码 | 同日只有第一只股票 |
| `minute_aux_archive_save`（`:6968`） | 代码+kind | 同上 |
| `sparkline_archive_save`（`:6991`） | 代码+selector | 同上 |
| `recent_minute_archive_save`（`:7025`） | 代码 | 同上 |
| `history_minute_archive_save`（`:7067`） | 代码（+日期） | 同上 |
| `block_meta_archive_save`（`:5275`） | 文件名 | 同日只有第一个 .dat 元数据 |
| `category_archive_save`（`:4460`） | category+sort | 同日只有第一组分类 |
| `f10_market_news_archive_save`（`:5426`） | tab | 同日只有第一个 tab |
| `f10_channel_news_archive_save`（`:5399`） | channel | 同日只有第一个频道 |
| `f10_market_report_archive_save`（`:5458`） | section | 同日只有第一个 section |
| `f10_detail_archive_save`（`:5520`） | type+record_id | 同日只有第一条详情 |

**工作区进展**：`code_archive.py`（未提交）新增 `write_code_archive(root, dataset, key, ...)`，
已把前 5 个分时类归档改为按 key 分片（`tdx_bridge.py:6943/6973/6996/7029/7071` 的 `write_code_archive` 调用），
并新增 `_merge_archive_lists` 兼容旧布局；但 **category/block_meta/news/f10_market/f10_detail 仍未迁移**。
在合入并验证前，本项按 P0 记录。

---

## 7. `docs/14`、`docs/15` 核实

### 7.1 docs/14（调研）逐条核实

| 位置 | 原文结论 | 代码事实 | 判定 |
|---|---|---|---|
| `docs/14:11`、`:30` | 「26 条 vs 我们 19 条」 | pythontdx 有 26 个 7709 命令常量且全部使用（`tdx_bridge.py:346-371`） | **过时**（19 是 Batch A 前的旧数） |
| `docs/14:33` | 「定点复权 无」 | `kline` 已支持 adjust=3/4 + anchor，缓存 key 含 anchor（`:6556-6638` 附近）；请求编码有单测（`test_protocol_extra.py:128-147`） | **过时**；但只覆盖单页、无实盘验证 → 「部分成立」 |
| `docs/14:34` | 「退市日线 0x052b 无」 | `delisted_kline`/`delisted_history`/归档/HTTP 路由都在（`:6477`、`:6486`、`:6537`） | **过时** |
| `docs/14:35` | 「0x0452 用本地规则」 | `special_limits` + `scan_special_limits` + 归档（`:6435`/`:6442`/`:6519`） | **过时** |
| `docs/14:36` | 「0x000f 部分 F10」 | `capital_changes` + `adjustment_factors` + `local_adjust_kline` + 归档（`:6334`、`:6386` 起） | **过时** |
| `docs/14:37` | 「0x0010 只取 4 字段」 | `parse_finance` 已解析 31 个 float 中的 26 个 + 4 个头字段（`:3272-3340`），仍缺 offset 20/24/28/32/36 五个股本结构字段 | **过时但方向对**（不是 4 字段，也不是全字段；归档再少 7 项，见 §3.7） |
| `docs/14:38` | 「MAC 字段 30 位」 | `MAC_FIELD_NAMES` 122 位（`tdx_mac.py:62-186`） | **严重过时** |
| `docs/14:39` | 「7615 F10 19 页签」 | 在线资料面板当前 **20 个页签按钮 / 16 个唯一 `setTab` 值**（`AnnouncementsPanel.tsx`），bridge 有 32 个 `fetch_*` | **口径不清**（19 既不是唯一面板数，也不是 fetch 数；可能数的是当时的按钮数） |
| `docs/14:40` | 「本地 .day/.lc1/.lc5 支持，基金系数缺」 | 前半句真；系数确实缺 | **正确** |
| `docs/14:49-53` | 「parse_bars 不再丢 amount/指数家数；旧 Parquet 缺列读 null」 | `parse_bars` 输出 amount/upCount/downCount；`parquet_store._read` 补齐缺列（`:119-148`） | **正确** |
| `docs/14:63` | 「测 T000038 前缀归一、空页停止、归档 SHA」 | 只有 `sz000038` 的解析/归档测试（`test_protocol_extra.py:60-90`）；**无 T000038、无空页翻页、无 HTTP 测试**；归档断言只看 rows/文件存在，**未校验 SHA 与内容一致** | **夸大**（验收标准 3 项基本未落地） |
| `docs/14:42` | 「运行时 单连接 + 锁」 | 连接层**无锁**，靠 sidecar 进程串行；批量线程用独立 `Bridge` + `bridges_lock` 保护列表（`cache_full_klines`，`:6705` 附近） | 描述偏差（不影响结论） |
| `docs/14:22-24` | 许可不兼容，不能复制 | 与 `D:\GitHub\eltdx\LICENSE` 一致 | **正确** |

### 7.2 docs/15（实现矩阵）逐条核实

| 位置 | 原文 | 代码事实 | 判定 |
|---|---|---|---|
| `:11-12` | 0x0004/0x000d ✅ | 都发，但**丢弃回包信息**（§3.17） | 边界不准（协议通，字段未用） |
| `:13` | 0x000f ✅ + `lake/corporate` | 真（`:6334` 起） | 正确 |
| `:14` | 0x0010 ✅「全部字段」+ `finance_cache` + `lake/finance` | **不成立**：31 个 float 只解析 26 个（缺 5 个股本结构字段），归档再少 7 项；`finance_cache` 只用于报价附加（TTL 6h） | **夸大** |
| `:15` | 0x02c5 ✅ | 真；但同日第二个文件被 skipped（§6.2） | 边界不准 |
| `:16-17` | 0x02cf/0x02d0 ✅ `lake/f10_pit`/原始 F10 | 真（`:5311`/`:5326`）；但写的是 parquet 单行 JSON，不是「原始 F10」字节 | 边界不准 |
| `:18` | 0x044d「启动时内存索引」 | 是**首次 `code_list()` 时**懒加载（`CodeIndex.ensure`），不是启动时 | 边界不准 |
| `:20` | 0x0452 ✅ | 真 | 正确 |
| `:21` | 0x051b ✅ `lake/minute_aux` | HEAD 下同日只有第一只（§6.2） | **部分不实** |
| `:22` | 0x052b ✅ `lake/delisted/*.parquet` | 真 | 正确 |
| `:23` | 0x052d ✅ fixed_qfq/hfq + anchor；`cache/klines` 含 amount/指数家数 | 单页真；`full_kline` 不支持 fixed/anchor（`:6639-6655` 附近）；无实盘验证 | **部分夸大** |
| `:24` | 0x0537 ✅ `lake/today_minute` | HEAD 下同日只有第一只 | **部分不实** |
| `:25` | 0x053e ✅「quote snapshot」 | 只有内存 `quote_cache`，无落盘 | **不实**（措辞像有归档） |
| `:26` | 0x0547 ✅「quote cache + 行情快照」 | 行情快照归档来自 MAC 0x122B；0x0547 只在内存 | **不实** |
| `:27` | 0x054b ✅ `lake/category_quotes` | 真，但同日第二组 category/sort 被 skipped | 边界不准 |
| `:28` | 0x054c ✅「行情快照归档」 | 归档是 MAC 0x122B；0x054c 不落盘；且单记录错标（P0） | **不实** |
| `:29` | 0x056a ✅ `lake/auction` | 真（读取时自动归档） | 正确 |
| `:30` | 0x06b9 ✅ `lake/server_files` + raw | 真 | 正确 |
| `:31` | 0x0fb4 ✅ | 真，但 avg 自造 | 边界不准 |
| `:32-33` | 0x0fc5/0x0fc6 ✅ `lake/ticks` | 真 | 正确 |
| `:34` | 0x0fd1 ✅ | HEAD 下同日只有第一只 | **部分不实** |
| `:35` | 0x0feb ✅ | HEAD 下同日只有第一只 | **部分不实** |
| `:36` | 0x0ffc ✅ `lake/money_flow` | 该路径由 MAC 0x1218 写入；0x0ffc 自身不写（工作区 offline_sync 补写） | **不实** |
| `:40` | MAC 覆盖「99 个 FieldBit」 | 122 位 | **低估/过时** |
| `:43` | 「126 枚举差异按规范名」 | 126 枚举 / 122 位，正确 | 正确 |
| `:44` | 「7615 已接 19 个个股页签」 | 当前 20 个页签按钮 / 16 个唯一面板、32 个 fetch；19 无精确对应 | 口径不清（近似按钮数） |
| `:45` | 「最新提示 8 分区」 | 7 + interaction = 8 | 正确 |
| `:45-46` | 「板块/指数/大盘 23 个 section」 | `MARKET_REPORT_SECTIONS` 23 | 正确（但 eltdx 26，缺 3） |
| `:46` | 「ETF/基金 30 个 section」 | 30 | 正确 |
| `:46-48` | 「个股与基金结果自动写 f10_pit；详情正文写 f10_detail；板块/指数/大盘写 f10_market；资讯写 market_news/channel_news」 | `f10_pit` 自动；其余是**显式** `*_archive_save`；且 keyed 数据集同日只留第一份 | **部分不实** |
| `:49` | 运行时「只参考设计」 | 描述偏保守；实际连 deadline/generation 都没有 | 边界不准（未说明差距） |
| `:53-56` | 本地 .day/.lc1/.lc5/.5 解析/写回 | 读写真；但系数固定 /100、残尾不支持 | 边界不准 |
| `:57-58` | 「尚未接管本地 GBBQ/财务」 | 正确 | 正确 |
| `:65` | 「按 trade_date 或 snapshot_date 分区」 | `cache/klines` 按代码/周期，不按日期；`lake/quotes` 按日期 | 部分不实 |
| `:68` | 「data_coverage 能扫描到」 | `lake/datasets` 不在 `data_coverage`（`data_coverage.py:37-60`） | **不实**（对新增数据集） |
| `:70-71` | 「data_integrity 校验每个通用 manifest；新增必须加入」 | `lake/quotes`、`lake/datasets` 未加入（`data_integrity.py:84-110`） | **不实** |
| `:72` | 通用归档可按 dataset+trade_date 读取 | 真，但仅 `protocol_archive` 布局；按代码分片的 f10_pit/ticks 不走它 | 边界不准 |
| `:83` | Batch A 含 0x000f/0x0010/0x02c5/0x0452/0x051b/0x052b/定点复权/0x0fd1/0x0feb/amount/家数 | 都做了；但 0x051b/0x0fd1/0x0feb 归档分片缺陷、定点复权只有单页 | 基本成立 |
| `:86` | Batch D：MAC 126 FieldBit、7615 缺失分区 | MAC 已 122 位；7615 仍缺 12 个入口 | **过时**（MAC 项已完成） |
| `:87` | Batch E：真实 fixture、运行时连接池 | 新增命令仍无真实 fixture（`fixtures/` 21 个文件均为旧命令）；连接池未做 | 未完成（应保留） |

---

## 8. 优先级清单

> 每条给：实现要点 → 需要新增/修改的函数 → 离线 fixture 断言方式。
> 「HEAD」= 已提交基线；「工作区」= 未提交并发改动，合入后勾销。

### 8.1 P0（数据错误/数据丢失，先修）

#### P0-1 `0x054c` 单记录/子集快照错标

- **现象**：`parse_snapshots` 在 `count <= len(items)` 时按请求顺序 `zip`，记录头里的真实代码从不校验；
  `_split_quote_records` 在 `len(items)==1` 时直接返回整段。服务器对不可用代码返回「另一只证券的合法记录」时，
  会把 A 的数据标成 B（eltdx 专门为此加防御：`quotes.rs:383-402`）。
- **实现要点**：解析记录头 `[0]=market`、`[1:7]=code`；与请求逐条比对；不匹配时按记录头回填真实代码并标记
  `missingRequested`，或抛 `TdxError`；`count < len(items)` 时也必须校验每条。
- **改哪里**：`_parse_snapshot_record`（加返回 `recordCode`）、`parse_snapshots`（改用记录头配对）；
  参考已有 `_split_refresh_records` 的 marker 校验思路（`:1392` 附近）。
- **fixture**：现有 `snapshot2.hex`（2 条正常）；新增 `snapshot-foreign1.hex`（单条、头是另一只代码）。
  断言：返回的 `code` 等于记录头代码，或抛错，**不得**等于请求代码。

#### P0-2 分时类归档同日后 2..N 只被静默 skipped（HEAD）

- **现象**：`write_dataset_archive` 以 `trade_date` 目录 + 单一 manifest 为幂等键，同日第二只直接 `skipped`
  （`protocol_archive.py:34-47`）。受影响：today_minute、minute_aux、sparkline、recent_minute、history_minute。
- **实现要点**：按 `dataset + key` 分片（每代码/每 kind 一份 jsonl.gz + manifest）；列表接口合并新旧布局。
- **改哪里**：工作区 `code_archive.write_code_archive` 已实现，需**合入并补测试**；5 个 `*_archive_save` 已改（HEAD→工作区）；
  另 6 个 keyed 数据集见 P0-2b。
- **fixture/测试**：`test_protocol_extra.py` 增加「同 trade_date 写两个 code」用例，断言目录下有 2 个 manifest、
  `list_*` 返回 2 条；再断言旧整包布局仍可列出。

#### P0-2b 其余 keyed 归档仍会同日覆盖

- **范围**：`block_meta`（文件名）、`category_quotes`（category+sort）、`market_news`（tab）、`channel_news`（channel）、
  `f10_market`（section）、`f10_detail`（type+id）。HEAD 与工作区都未修。
- **实现要点**：同 P0-2，把 key 拼进文件名/manifest；同步改 `*_archive_list` 与 `data_integrity` 的 glob。
- **fixture**：对 `write_code_archive` 直接单测 6 个 key；再对 `f10_market_report_archive_save` 连续两次不同 section 断言 2 份。

#### P0-3 全量翻页以「短页」终止（可能截断历史）

- **现象**：`full_kline`（`:6639` 附近）与 `delisted_history`（`:6344` 附近）在 `len(page) < page_size` 时停止；
  eltdx 文档明确「短页不代表结束，只有空页才停止」（`docs/methods/7709-K线周期线.md`；实现 `api/bars.py:120-138`）。
- **实现要点**：只在 `count==0` 停；`max_pages` 用完时返回 `complete=false` 或抛错；翻页偏移按**请求页大小**而非返回条数推进
  （服务端偏移语义是「第 N 根」，不是「已拿 N 根」）。
- **改哪里**：`full_kline`、`delisted_history`、`cache_full_klines` 的循环；`full_kline` 同时放开 fixed_qfq/hfq。
- **fixture/测试**：构造假连接依次返回 800/300/0 三页，断言合并 1100 根且 `pages=3`；
  再构造 800/800 后 max_pages=2，断言 `complete=false`（不是静默 complete）。

#### P0-4 本地 `.day`/`.lc` 系数与残尾

- **现象**：价格/量固定 `/100`（`tdx_local.py:53`、`:117`），基金/债券 0.001、指数量系数 1.0 全错；
  文件长度非 32 倍数直接 raise（`:28-29`），残尾文件整份读不出。
- **实现要点**：
  1. `detect_security_type(filename)` + `security_coefficients()`（A 股 0.01/0.01；沪 B 0.001/0.01；沪指数 0.01/1.0；
     沪基金/债券 0.001/1.0；深基金/债券 0.001/0.01；未知按 A 股但标记）；
  2. 只遍历完整记录，残尾忽略；文件不足一条返回空；
  3. 保留 `raw`/`adjust_flag`；`close<=0` 不再丢弃（或显式标记）。
- **改哪里**：`tdx_local.read_day_file`/`read_min_file`；新增 `security_coefficients`；`write_day_file`/`write_min_file` 反向使用同一系数。
- **fixture**：构造 `sh510300.day`（ETF，价格 3.500 元存 3500）断言 3.5；`sh000001.day` 量 12345 断言 12345（不除 100）；
  `sz000001.day` 尾部加 1 字节断言仍读出完整记录数。

#### P0-5 `0x0ffc` 资金流没有按 0x0ffc 落盘（文档宣称有）

- **现象**：`Bridge.money_flow`（`:5292`）只请求+解析；`lake/money_flow` 实际由 `mac_money_flow` 写 MAC 0x1218 的 payload
  （`:4079`）；两者 schema 不同。工作区 `offline_sync.run_task` 已把 0x0ffc 的 records 写进 flow_archive（未提交）。
- **实现要点**：二选一——(a) `money_flow()` 成功后写 `lake/money_flow`（新 schema `money_flow_daily.v1`，含 5 日 records）；
  (b) 明确文档：该路径只收 MAC 0x1218。推荐 (a)，因为 0x0ffc 是唯一有「5 日分档」的权威源。
- **改哪里**：`Bridge.money_flow`；`flow_archive` 增加 `read/write_money_flow_daily`（或复用 payload dict）。
- **fixture**：`money-flow-5.hex` 已有解析测试（`test_tdx.py:775`）；新增「写入后 `flow_archive_list` 可见、payload 含 5 条 records」断言。

### 8.2 P1（能力/字段补齐，按收益排序）

| # | 项 | 实现要点 | 改哪里 | fixture 断言 |
|---|---|---|---|---|
| P1-1 | 行情字段补齐（0x053e/0x054c/0x0547/0x054b） | 按 §3.3-3.6 表补：active1、serverTime、currentHand、openAmount、tradingStatus、tailMetrics[4]、riseSpeed、active2、inner/outer（快照与分类）、recordHex；0x053e 增加请求/返回数量校验；统一 `_build_quote` 输出 | `parse_quotes`/`parse_snapshots`/`_parse_refresh_record`/`_parse_category_record`/`_build_quote` | `quote1/quote5/quote-index/snapshot2/refresh2/category5` 逐字段断言（新字段非空、量价一致）；少返回 1 条时断言报错/回补 |
| P1-2 | K 线字段补齐 | price milli/差分原始值/lastClose/recordHex；可转债 `volume_lots` 不再 /100；`bar_time=end`；尾字节校验 | `parse_bars`、`parquet_store` schema、`kline`/`full_kline` | `bars-day5/bars-index3` 断言 milli×1000=价格、可转债 fixture、bar_time 偏移 |
| P1-3 | 0x0010 缺的 5 字段 + 归档字段与命名 | `parse_finance` 补 offset 20/24/28/32/36（国家股/发起人法人股/法人股/B 股/H 股，万股）；归档 fields 补这 5 项 + province/industry/raw/reserved2；`floatSharesYuan`→`floatSharesShares`（或加注释）；`on_missing` 批量二分回退 | `parse_finance`、`finance_archive_save`、新增 `recover_batch` | `finance2.hex` 断言 31 个 float + province/industry 全对齐；构造少 1 条响应断言二分补齐 |
| P1-4 | 0x000f 尾部容忍 + raw | 允许尾部多余字节；返回 recordHex；block_count 用实际块数 | `parse_capital_changes` | 在 `finance2` 同级构造尾随 4B 断言不抛错 |
| P1-5 | 分时/逐笔特殊字段 | 0x0537 reserved；0x0fb4 去掉自造 avg（或标 `avgSource="derived"`）并保留 aux delta；0x0fc6 返回 priceBase；0x056a reserved；tick 增 `tradeDateTime`/`priceRaw` | `parse_today_minute`/`parse_history_minute`/`parse_trades`/`parse_auctions` | `minute.hex`/`minute-history.hex`/`trades-history.hex` 断言新字段；`auction-today.hex` 断言 reserved |
| P1-6 | 0x044d 代码表字段/分类 | 补 multiple、prevClose、volumeRatioBase；输出 `category`/`board`（ETF/A/B/北交所） | `parse_security_list`、`classify_security` | `list3.hex` 断言 37B 各偏移与分类 |
| P1-7 | 会话信息 | 解析 0x000d 189B（服务器时间/两段时段/服务器名）与 0x0004 日期；`code_list` 前记录并用于交易日判断 | ✅ `parse_handshake` + `_connect` 已接；实测 189B/「上海双线主站3」；0x0004 日期未做 | 合成 189B 单测 + 实盘 |
| P1-8 | 历史财务 gpcw（大项） | 0x06b9 拉 `tdxfin/gpcw.txt` → 下载 zip → 解析 20B 头/11B 索引/float32；写 `lake/finance_history/<report_date>`；zip 限额 | 新模块 `finance_history.py`；`Bridge.finance_history_*` | 用自造 zip+dat（20B 头 + 1 索引 + N float）断言 code/market/report_date/字段；真实文件已下载验证（5,572×658） |
| P1-9 | 本地 GBBQ | XOR 解密 + `<B7sIBffff>` 记录；写 `lake/gbbq`；与 0x000f 对账 | 新模块 `gbbq.py` | ✅ 已用本机 202,313 条 + 29B 密文 fixture 验证；字段改 c1..c4/categoryName |
| P1-10 | MAC 命令补齐 | 优先 0x122C/0x122D/0x122E/0x123D/0x120F/0x254D；统一 68B 头/字段位图/行宽 | `tdx_mac.py` 新 `request_*`/`parse_*` | ✅ 15 条已落地；0x122E 与 7709 交叉 6,035 根；1217 空分片 |
| P1-11 | 7615 缺 12 类入口 + 84 频道 + 行业 13 页 | 按 §2.4 表补 Entry；新 7615 主机 `hot.icfqs.com`；结果集字典化（重复列 `__2`） | `tdx_f10.py` 新增 fetch_*；`_parse_all_tables` 改返回 dict 行 | ✅ 9 HQServ/20 行业/84 频道/涨跌停 131 行；ColDes 与重复列已处理 |
| P1-12 | 运行时 generation/deadline/retry-safe | epoch+1、队列带 epoch、重连清空/标记旧帧；monotonic 预算；记录 send 完成 | `TdxConnection`（`:556-674`）、`_drain_quote_pushes` | 单测模拟「重连后旧 push 帧」断言被丢弃；模拟慢响应断言 deadline 生效 |
| P1-13 | quotes/datasets 纳入覆盖率与校验 | `data_coverage.py` 加 `lake/datasets`；`data_integrity` 加 `lake/quotes`、`lake/datasets` | 两个模块 | 造 1 个 quotes manifest + 1 个 datasets manifest，断言 checked=2 |

### 8.3 P2（低风险/性能/文档）

| 项 | 实现要点 | 改哪里 | fixture / 断言 |
|---|---|---|---|
| 0x054b `sort_reverse` 默认值 | sort_type==0 时用 0；否则 ascending?2:1（eltdx `quotes.rs:115-130`） | `category_data` | 构造 sort_type=0/非 0 两组，断言第 5 个 u16 为 0/1/2 |
| 0x056a 默认 selector | 对齐 eltdx 的 3 前先实盘验证 0 与 3 的差异（`auctions.rs:16`） | `Bridge.auctions` 默认值 | 同代码同日两种 selector，断言点数/时间范围差异（需联网，未验证） |
| 0x06b9 内容表示 | 返回值从 `contentHex` 改为 bytes/内存视图，避免 2× 内存 | `parse_file_chunk`、`_download_bytes` | `file-zhb-head.hex` 断言 bytes 与 hex 解码一致 |
| 0x02cf/0x02c5 raw（可选增强） | 保留 GBK 原始目录项/32B MD5；eltdx 也不保留，属我们自己的可追溯性增强 | `parse_f10_catalog`、`parse_block_meta` | `f10-cat2.hex`/`block-gn-head.hex` 断言 raw bytes 长度 152/32 |
| 批量上限 | 0x053e/0x054c 80→200/500；财务 80→200；股本 75→200（eltdx `limits.rs:22-23`） | `QUOTE_BATCH`、`FINANCE_BATCH`、`CAPITAL_BATCH` | 构造 N=200 请求断言长度与 count；实测服务端截断行为（未验证） |
| `data_coverage` 遗漏 | 补 `lake/datasets`（`data_coverage.py:37-60`） | `collect_data_coverage` | 造 1 个 datasets 目录，断言 datasets 列表含该名字 |
| blocknew 路径穿越 | 校验 `record['file']` 只含叶子名（eltdx `offline/block.py:41-51`） | `parse_blocknew_cfg`/`client_blocks`（`:5881`） | 构造 `file="../../evil"` 的 120B 记录，断言拒绝 |
| MAC 字段后处理 | 0x4A AH 代码补零；`fields` 值类型标注（eltdx `bitmap.py:212-214`） | `parse_quotes` | `test_mac.py` 现有报文断言 `ah_code` 为 6 位字符串 |
| 自造字段标注 | `lockedAmount`、0x0fb4 `avg`、`tradeAmount` 在返回/文档标 `derived` | `_parse_category_record`、`parse_history_minute`、`parse_trades` | 断言新字段 `derived=true`；旧字段兼容 |
| 文档修订 | 按 §7 修正 docs/14、docs/15；Batch D 勾销 MAC | docs/14、docs/15 | 文档 diff 核对（无需 fixture） |
| 派生 helpers | 连板天梯/题材强度/短线指标/每日股本（eltdx `helpers/core.py:415-760`） | 新模块（非协议层） | 按需求单独设计；不在本轮 |

### 8.4 不可做项（明确排除）

| 项 | 原因 |
|---|---|
| 复制 eltdx 源码/夹具/文档/wheel | 非商业许可，与 GPL-3.0-or-later 不兼容（`LICENSE`；docs/14:22-24 已记录） |
| EX 7727 / MAC-EX / 港股美股期货期权 | 项目边界（AGENTS.md 第 8 条；docs/00 范围） |
| 7615 的 `mg_*`/`hk_*`/`sb_*`/`bond_*`/`gz_*`/`qyz_*`/`gzhg_*`/`zczq_*`/`kjhz_*`/`qh_*` 家族 | 非 A 股；即使 eltdx 有也不接 |
| 引入 PyO3 / Rust native wheel | sidecar 必须 stdlib-only + Nuitka 单文件跨平台 |
| MCP / HTTP 网关 | 已有 Python HTTP/SSE/WS 服务 |
| 0x2562 商品列表、0x1215/0x1217 MAC 文件 | 扩展市场/非必要（0x06b9 已覆盖 A 股文件） |
| GBBQ 密钥来源未核实前 | 不能从 eltdx 复制；需从许可兼容来源取得并登记 docs/08 |

---

## 9. 附录

### 9.1 未验证清单

| 项 | 为什么未验证 | 建议验证方式 |
|---|---|---|
| fixed_qfq/hfq 服务端返回语义 | 未联网；只有请求编码单测 | 抓 1 次 `adjust=3/4 + anchor` 响应，与 qfq 对比首根价格 |
| 0x054c 服务器「返回他人记录」概率 | 未实盘构造 | 用一个退市/停牌代码 + 一个正常代码同批请求，观察 count 与记录头 |
| 0x054b `sort_reverse` 0/1/2 差异 | 未实盘 | 同参数分别发 1/2，比较排序方向 |
| 0x056a selector 0 vs 3 | 未实盘 | 同代码同日两次请求比对点数/时间范围 |
| 0x0fb4 第二 varint 语义 | 文档未给 | 用已知均价的分时页对比「累计额/量」与官方均价 |
| 指数 K 线 20B 记录 | 未抓包 | 抓 `sh000001` 日 K 原始 payload 数长度 |
| MAC 122 位全请求的返回 | 未实盘 | 对比只请求 COMMON 与全位的行宽/字段 |
| 7615 缺口的 Entry 参数 | 只读文档，未调用 | 各 Entry 发一次最小 Params，记录 ErrorCode |
| 财务 136B 的省份/行业枚举 | 未核对官方字典 | 抽 10 只股票与 F10 公司概况比对 |
| 本地 `.day` 各品种系数 | 未拿真实基金/指数文件 | 用通达信安装目录的 `sh510300.day`/`sh000001.day` 对账 |

### 9.2 证据索引（eltdx 侧，行号稳定）

| 主题 | 文件:行 |
|---|---|
| 7709 命令常量 | `crates/eltdx-protocol/src/commands/*.rs`（各文件头部 `pub const TYPE_*`） |
| K 线字段/解析 | `klines.rs:98-121`、`:131-246`、`:223-228` |
| 快照/旧版/分类/刷新 | `quotes.rs:206-345`（结构）、`:346-409`、`:546-622`、`:623-772`、`:773-897`、`:898-1000` |
| 分时族 | `minutes.rs:273-345`（结构）、`:352-427`、`:428-492`、`:493-573`、`:574-650`、`:651-730` |
| 逐笔 | `trades.rs:155-198`、`:200-231`、`:232-274`、`:275-380` |
| 财务/股本 | `corporate.rs:145-236`、`:238-303`、`:304-390`、`:449-560` |
| 代码表 | `security.rs:125-143`、`:173-240`、`:242-300` |
| 特殊涨跌停/退市 | `limits.rs:20-120`、`delisted_bars.rs:60-180` |
| 竞价 | `auctions.rs:104-200` |
| 会话 | `session.rs:54-96` |
| MAC FieldBit | `src/eltdx/mac/bitmap.py:20-196`、`:212-226` |
| MAC 命令 | `src/eltdx/mac/commands.py`（17 个 `MSG_ID`） |
| 本地文件 | `src/eltdx/offline/daily_bar.py:20-155`、`min_bar.py:56-185`、`gbbq.py:280-364`、`history_financial.py:109-260`、`block.py:41-164`、`paths.py:1-90` |
| 运行时 | `docs/ARCHITECTURE.md:39-67`、`crates/eltdx-runtime/src/deadline.rs:1-151`、`request.rs:751-782`、`src/eltdx/transport/pool.py:74-479`、`src/eltdx/hosts.py:414-490` |
| 7615 | `src/eltdx/f10/client.py:35-41`、`:88-145`、`:140-178`、`:1486-1594`、`:1700-1790`、`:1882-1930`、`news.py:173-210` |

### 9.3 证据索引（pythontdx 侧，快照行号）

| 主题 | 文件:行（写作最后核对，仍可能漂移） |
|---|---|
| 命令常量 | `python/tdx_bridge.py:346-375`（26 条 eltdx 命令 + 3 条 gotdx 新命令） |
| 请求构造 | `quote_data:691`、`refresh_data:704`、`category_data:722`、`trades_data:752`、`auction_data:778`、`file_content_data:811`、`bars_data:876`、`special_limits_data:903`、`delisted_bars_data:908`、`minute_data:948`、`history_minute_data:952`、`minute_aux_data:956`、`sparkline_data:967`、`recent_minute_data:985`、`finance_data:1005`、`capital_changes_data:1017` |
| 解析 | `parse_quotes:1049`、`parse_snapshots:1318`、`parse_refresh:1426`、`parse_category_quotes:1525`、`parse_trades:1551`、`parse_auctions:1619`、`parse_money_flow:1684`、`parse_bars:2539`、`parse_special_limits:2607`、`parse_delisted_bars:2634`、`parse_today_minute:2684`、`parse_minute_aux:2730`、`parse_sparkline:2770`、`parse_recent_minute:3065`、`parse_history_minute:3109`、`parse_security_list:3158`、`parse_capital_changes:3208`、`parse_finance:3272` |
| 连接 | `TdxConnection`（`:556`）、`close:567`、`_connect:575`、`_read_frame:617`、`_transact:636`、`request:659` |
| 归档 | `write_dataset_archive`（`python/protocol_archive.py:26`）、`write_code_archive`（`python/code_archive.py:89`）、`delisted_archive.py:19`、`tick_archive.py:59`、`auction_archive.py:63`、`flow_archive.py:49`、`f10_pit.py:94` |
| 本地 | `python/tdx_local.py:21/77/128/166`、`python/local_import.py:28` |
| MAC | `python/tdx_mac.py:62-186`（字段）、`:260`（请求）、`:272`（解析） |
| 7615 | `python/tdx_f10.py:13`（单主机）、`:226-248`（请求）、`:1216-1238`（频道）、`:1457-1481`（23 section） |
| 归档分片相关方法 | `minute_archive_save:6924`、`minute_aux_archive_save:6968`、`sparkline_archive_save:6991`、`recent_minute_archive_save:7025`、`history_minute_archive_save:7067`、`block_meta_archive_save:5275`、`category_archive_save:4460`、`f10_channel_news_archive_save:5399`、`f10_market_news_archive_save:5426`、`f10_market_report_archive_save:5458`、`f10_detail_archive_save:5520` |
| 关键业务方法 | `select_server:3979`、`code_list:4003`、`mac_money_flow:4075`（写 flow 在 `:4079`）、`_drain_quote_pushes:4303`、`archive_snapshot:4545`、`money_flow:5292`、`finance_archive_save:6284`、`capital_changes:6334`、`special_limits:6435`、`scan_special_limits:6442`、`delisted_kline:6477`、`delisted_history:6486`、`kline:6556`、`full_kline:6639`、`cache_full_klines:6705`、`five_day:7090`、`dispatch:7119` |

### 9.4 复现命令

```bash
# 1) 命令字清点（eltdx）
grep -rn "pub const TYPE_" D:/GitHub/eltdx/crates/eltdx-protocol/src/commands/*.rs
# 2) 命令字清点（pythontdx）
grep -n "^CMD_" D:/GitHub/pythontdx/python/tdx_bridge.py
# 3) dispatch 入口数
grep -c 'if cmd == ' D:/GitHub/pythontdx/python/tdx_bridge.py
# 4) 离线单测（本次跑过）
cd D:/GitHub/pythontdx && python -m pytest python/test_protocol_extra.py python/test_local.py -q
# 5) 归档幂等键证据
grep -n "manifest.json" D:/GitHub/pythontdx/python/protocol_archive.py
```

---

## 10. 给下一轮的执行顺序（建议）

1. 合入并验证工作区的 `code_archive`（P0-2/P0-2b），补齐 6 个未迁移数据集 + `data_integrity` glob。
2. 修 P0-1（0x054c 记录头校验）与 P0-3（空页翻页），两者都能用现有 fake-connection 测试离线复现。
3. 修 P0-4（本地系数/残尾），用真实 `vipdoc` 文件对账后再改 `local_import`。
4. 补 P0-5（0x0ffc 落盘）或改文档，二选一，不要继续让文档与代码不一致。
5. P1 按「字段 → 本地 GBBQ/财务 → MAC → 7615 → 运行时」推进；每项先补 fixture 再改解析。
6. 最后统一修订 docs/14、docs/15（§7 表可直接作为修订清单）。
