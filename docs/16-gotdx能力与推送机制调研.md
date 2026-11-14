# 16 · gotdx 能力与推送机制调研

> 调研对象：本地 Go 项目 `D:\GitHub\gotdx`（模块 `github.com/bensema/gotdx`，`go 1.27.0`，
> 185 个 `.go` 文件、约 3.6 万行）。调研方式：**只读源码 + 结构提取 + 与 pythontdx 的
> `docs/15-协议实现矩阵.md`、`python/tdx_bridge.py` 逐条对照**，未运行 gotdx、未联调服务器。
>
> 目的：为 pythontdx（只做 A 股、只接通达信 7709/MAC/7615）筛选「可借鉴 / 可落地 / 不适用」
> 的技术点，重点评估其**数据推送模式**。
>
> **引用约定**：`文件:行` 均指 gotdx 仓库内路径；`tdx_bridge.py:行` 指 pythontdx。凡未实测、
> 仅由源码静态推断的结论一律标 **【未验证】**。凡与本文件结论冲突的历史认知，以实测为准并在
> 第 10 节登记。

>
> **行号时效**：gotdx 源码未变动，行号可直接用；`python/tdx_bridge.py` 在调研期间仍在增长
> （快照 7 205 行），文中 `tdx_bridge.py:行` 均取自该快照，**定位时请以函数名/符号名为准**，
> 行号仅作辅助。2026-11-14 起协议层已拆到 `python/tdxproto/`（常量/编解码/连接/请求/解析/板块），
> 这些行号不再对应任何文件，模块归属见 `docs/24` §3.6。

## 落地状态（pythontdx，2026-11-04 主代理追加）

| 建议 | 状态 | 落点 |
| --- | --- | --- |
| L1 订阅 Hub（轮询 diff + 合并 + 基线 + 隔离） | ✅ 已落地 | `python/subscription_hub.py`；`tdx_server` SSE/WS 共用 |
| L2 `0x0563` 主力监控 | ✅ 已落地并实测 | `CMD_UNUSUAL` / `parse_unusual` / `Bridge.unusual` |
| L3 `0x053f` 九榜排行 | ✅ 已落地并实测 | `CMD_TOP_BOARD` / `parse_top_board` / `Bridge.top_board` |
| L4 帧长/解压上限 | ✅ 已落地 | `TdxConnection._read_frame`（64KB + max_length） |
| M1 连接池 + 空数据换节点 | ⏳ 部分 | 离线同步用「多进程 × 每线程一连接」替代；主链路仍是单连接 |
| M5 `0x051a` 成交分布 | ⚠️ 解析/归档已落地，**主站全部超时** | `CMD_VOLUME_PROFILE` / `parse_volume_profile` |
| M6 MAC 位图差集 | ⏳ 待办 | 见 docs/17 §2.3 |
| M8 资金流节点扩容 | ⏳ 待办（现有 8 个实测可用） | `MONEY_FLOW_HOSTS` |
| MAC 命令（gotdx 3.5） | ⚠️ 14 ✅ + 1 ⚠️（新增 10 条，1217 空分片） | `tdx_mac_ext.py` / docs/19 |
| M9 `0x0452` u32 分页 | ⏳ 未改（现有 u16 足够 65k 行） | `special_limits_data` |
| 0x0547「推送帧」 | ❌ 事实修正 | gotdx 没有主动推送；我们的游标增量保留 |



---

## 目录

- [0. 结论摘要（先行）](#0-结论摘要先行)
- [1. 调研范围与方法](#1-调研范围与方法)
- [2. 模块清单与职责](#2-模块清单与职责)
- [3. 协议命令全集](#3-协议命令全集)
  - [3.1 帧格式、压缩与加密](#31-帧格式压缩与加密)
  - [3.2 连接与基础命令](#32-连接与基础命令)
  - [3.3 主站行情命令（0x04xx / 0x05xx）](#33-主站行情命令0x04xx--0x05xx)
  - [3.4 历史数据命令（0x0fxx）](#34-历史数据命令0x0fxx)
  - [3.5 MAC 命令（0x12xx）](#35-mac-命令0x12xx)
  - [3.6 扩展市场命令（0x23xx / 0x24xx，边界外）](#36-扩展市场命令0x23xx--0x24xx边界外)
  - [3.7 试验与客户端上报命令（0x00xx / 0x26xx）](#37-试验与客户端上报命令0x00xx--0x26xx)
  - [3.8 pythontdx 可能缺口的专项分析](#38-pythontdx-可能缺口的专项分析)
  - [3.9 分页语义汇总](#39-分页语义汇总)
- [4. 连接与运行时机制](#4-连接与运行时机制)
  - [4.1 连接池数据结构](#41-连接池数据结构)
  - [4.2 建池快路径与 500ms 自适应探测](#42-建池快路径与-500ms-自适应探测)
  - [4.3 后台补建](#43-后台补建)
  - [4.4 应用层心跳与慢连接识别](#44-应用层心跳与慢连接识别)
  - [4.5 重平衡与节点切换阈值](#45-重平衡与节点切换阈值)
  - [4.6 deadline 与帧读写](#46-deadline-与帧读写)
  - [4.7 空数据换节点与节点健康度](#47-空数据换节点与节点健康度)
  - [4.8 代际（generation）与并发锁模型](#48-代际generation与并发锁模型)
  - [4.9 Python 等价实现建议](#49-python-等价实现建议)
- [5. 数据推送模式（重点）](#5-数据推送模式重点)
  - [5.1 事实核查：gotdx 的「推送」到底是什么](#51-事实核查gotdx-的推送到底是什么)
  - [5.2 SubscribeSource / Fetch / Changed / Key 合并](#52-subscribesource--fetch--changed--key-合并)
  - [5.3 基线推送](#53-基线推送)
  - [5.4 间隔实时生效与循环重建](#54-间隔实时生效与循环重建)
  - [5.5 panic 隔离](#55-panic-隔离)
  - [5.6 取消语义](#56-取消语义)
  - [5.7 0x0547 的两种实现对照](#57-0x0547-的两种实现对照)
  - [5.8 把该模式用于 K 线 / 分时 / 逐笔 / 竞价](#58-把该模式用于-k-线--分时--逐笔--竞价)
  - [5.9 与 SSE / WebSocket 的关系](#59-与-sse--websocket-的关系)
- [6. 字段处理技巧](#6-字段处理技巧)
- [7. 测试与文档方法](#7-测试与文档方法)
- [8. 地址池](#8-地址池)
- [9. 结论与增强清单](#9-结论与增强清单)
- [10. 未验证清单与待登记来源](#10-未验证清单与待登记来源)

---

## 0. 结论摘要（先行）

| 判断 | 结论 |
| --- | --- |
| gotdx 的核心长处 | 不是协议数量，而是**运行时工程**：动态连接池 + 自适应建连 + 心跳/重平衡/空数据换节点 + 一套通用「轮询 diff」订阅工厂 |
| 协议层面 | 与 pythontdx 高度重叠；**真正新增**的是 `0x051a` 成交分布、`0x051d` 指数概况、`0x051c` 指数动量、`0x053f` 排行榜、`0x0563` 主力监控、`0x0547` 加密批量行情（pythontdx 已有，且实现更稳健）、以及一批 `0x26xx` 客户端上报（价值低） |
| 「推送模式」 | gotdx **没有任何服务端主动推送协议**；`Subscriber` 是**定时轮询 + 快照 diff**。任务书中「0x0547 推送帧 / 游标」的描述与 gotdx 源码不符：gotdx 的 `0x0547` 是一次性加密批量报价请求（`proto/get_quotes_encrypt.go`），无游标、无推送帧；pythontdx 的 `0x0547` 才是「代码+游标」增量刷新。详见 [5.7](#57-0x0547-的两种实现对照) |
| 最该吸收的 3 件事 | ① 轮询 diff + 同 Key 合并 + 基线推送 + panic 隔离的订阅语义；② 连接池的空数据换节点 + 节点健康度降权；③ MAC 20 字节字段位图（160 位）驱动动态字段查询 |
| 最该拒绝的 | 港股/美股/期货/期权（EX 7727 全系）、ICFQS HTTP 资讯、客户端登录/交易类上报、Redis 缓存层、gotdx 的 `0x0547` 与 `0x0fb4` 解析实现 |
| 立刻可落地（5 条） | 见 [9.1](#91-立刻可落地)：L1 订阅 Hub（轮询 diff）、L2 `0x0563` 主力监控、L3 `0x053f` 排行榜、L4 帧长/解压上限、L5 GBK 清洗 + 换手率 |
| 项目边界外 | EX 7727、港股美股期货、登录交易、7727 扩展行情、ICFQS 资讯、Redis 缓存 |

---

## 1. 调研范围与方法

**做了什么**

1. `rg`/`grep` 提取全部 `KMSG_*` 命令常量与各 `proto/*.go` 的 `Method` 绑定，得到命令→文件映射。
2. 通读 `client.go`（1817 行）、`client_helpers.go`、`client_subscribe_factory.go`、
   `client_quote.go`、`client_unified.go` 关键段，以及 `hosts.go`、`options.go`、`mac_bitmap.go`、
   `proto/proto.go`、`proto/util.go`、`proto/mac_board_members_dynamic.go` 全文。
3. 精读 pythontdx 可能缺失的命令：`get_index_info.go`、`get_index_momentum.go`、
   `get_volume_profile.go`、`get_top_board.go`、`get_unusual.go`、`get_history_orders.go`、
   `get_quotes_encrypt.go`、`get_auction.go`、`experimental.go`。
4. 对照 pythontdx 现状：`python/tdx_bridge.py`（调研时 7 205 行；若后续改动，
   以函数名而非行号为准）、`python/tdx_server.py`、`python/connect.cfg`、`docs/15`。

**没做什么**

- 未运行 gotdx 的 `go test`、未抓包、未连服务器验证任何命令字——因此凡涉及「服务端行为」的
  结论都是**静态推断**，标【未验证】。
- 未阅读 `cache/`（Redis 缓存层，约 9 万字节）与 `examples/`（80+ 示例）全文，只在需要时抽查。

**规模统计**（`wc -l`）

| 分组 | 行数 | 说明 |
| --- | --- | --- |
| 根目录 `client*.go`（非测试） | 6 121 | API + 连接池 + 订阅工厂 |
| `proto/*.go`（非测试） | 12 812 | 协议编解码 |
| `proto/*_test.go` | 4 814 | 字节级协议测试 |
| `cmd/webviewer/query.go` | 6 281 | 方法注册表 + HTTP 分发 |
| `types/constants.go` | 455 | 市场/周期/排序/过滤/字段位常量 |

---

## 2. 模块清单与职责

| 文件 | 行数 | 职责 | 关键位置 | 对 pythontdx 的价值 |
| --- | --- | --- | --- | --- |
| `client.go` | 1 817 | 客户端构造、连接池、握手、补建/心跳/重平衡、帧收发、Connect/Disconnect | `Client` 结构 `client.go:90-115`；`acquire` `:343`；`exchangeBytes` `:1253`；`rebalancePool` `:937`；`buildPoolLocked` `:1386` | ★★★ 连接池与自愈机制 |
| `client_helpers.go` | 398 | 唯一执行入口 `execute`、空数据换节点、节点健康度、`makeStocks` 等构造助手 | `execute` `:32`；`parallelEmptyRetry` `:83`；`isEmptyReply` `:166`；`healthDowngradeThreshold` `:217` | ★★★ 空数据换节点 + 反射判空 |
| `client_subscribe_factory.go` | 324 | 通用「轮询 diff」订阅工厂 | `Subscribe` `:93`；`runTask` `:213`；`pumpTask` `:252` | ★★★ 推送语义 |
| `client_quote.go` | 456 | 主站底层接口（逐个协议一层封装） | `GetQuotesEncrypt` `:299`；`GetTopBoard` `:382`；`GetUnusual` `:391`；`GetVolumeProfile` `:257`；`GetIndexInfo` `:248` | ★★ 命令清单入口 |
| `client_unified.go` | 1 419 | `Stock*` 高阶统一入口 + 小数位/流通股本/换手率补齐 + 全量翻页 | `StockAll` `:123`；`StockFullKLine` `:262`；`StockKLine930` `:206`；`loadDecimalPointMap` `:1135`；`applyTurnoverToBars` `:1397`；`decimalPriceFactor` `:1321` | ★★★ 字段补齐范式 |
| `client_mac.go` | 990 | MAC 协议接口（板块/成分/报价/逐笔/竞价/多日分时/资金流/文件） | — | ★ 已由 `python/tdx_mac.py` 覆盖 |
| `client_exquote.go` | 354 | 扩展市场（7727）接口 | — | ✗ 边界外 |
| `client_extras.go` | 162 | 公司资料打包、文件下载、板块/表格文件读取 | `DownloadFullFile` `:72`；`GetBlockFile` `:106` | ★ 文件下载分块范式 |
| `client_company.go` | 84 | F10/财务/除权/文件元信息 | — | 参考 |
| `client_goods.go` | 117 | 商品语义（期货/港股）包装 | — | ✗ 边界外 |
| `proto/proto.go` | 598 | **协议基础**：命令常量表、请求/响应头、变长价格 `getprice`、时间/日期解码、压缩成交量 `getvolume`、价格单位 `baseUnit` | 常量 `:27-111`；`getprice` `:242`；`decodeDateNum` `:327`；`getvolume` `:523`；`baseUnit` `:585` | ★★★ 字段解码基础 |
| `proto/util.go` | 250 | GBK 解码 `Utf8ToGbk`、日期解码 `GetTime`、变长整数 `getData/GetPrice` | `Utf8ToGbk` `:23`；`GetTime` `:44` | ★★★ GBK 清洗 |
| `proto/get_*.go` | — | 主站协议（列表/行情/K 线/分时/逐笔/竞价/异动/排行/指数/成交分布/财务/F10/文件） | 见第 3 节 | ★★★ |
| `proto/mac_*.go` | — | MAC 协议族（含 20 字节字段位图动态字段） | `mac_board_members_dynamic.go:62-203` 字段表 | ★★ 位图字段 |
| `proto/ex_*.go` | — | 扩展市场（7727）协议 | — | ✗ 边界外 |
| `proto/experimental.go` | 913 | 试验协议：`0x000b` TODOB、`0x0fde`、`0x264b`、`0x26ac`、`0x26ad`、`0x26ae`、`0x26b1`、`0x0452`、`0x23f6`、`0x248x`、`0x2562` | `RawMainProtocol` `:21`；`NewTodoB` `:97`；`NewClient26AD` `:183` | ★ 抓包调试范式；命令本身低价值 |
| `hosts.go` | 447 | 六组内置地址池 + 并发测速 + 排序 | 列表 `:46-185`；`ProbeHosts` `:265`；`probeConcurrencyWindow` `:340` | ★★ 地址池扩充 |
| `icfqs.go` | 507 | ICFQS 7615 HTTP 资讯客户端（TQLEX/JSON） | `NewICFQS` `:51`；`PostTQL` `:119`；`parseICFQSTQLResponse` `:421` | △ 数据源边界外（pythontdx 已直连 7615 自研 F10） |
| `mac_bitmap.go` | 328 | MAC 动态字段位图：160 个 `MACFieldBit` + 12 个预设 + 位图构造函数 | 常量 `:28-162`；`MACFieldBitmap` `:265`；默认位图 `:281` | ★★★ 位图驱动字段 |
| `options.go` | 204 | 函数式选项：地址/池大小/超时/单连接模式/关闭换节点 | 默认值 `:8-20`；`WithSingleConnectionMode` `:187` | ★★ |
| `futures_calendar.go` | 147 | 期货交易日历 SQLite，修正 MAC 期货夜盘自然时间 | `:25`、`:67`、`:89` | ✗ 期货业务，但「日历表做时间归属」思路可借 |
| `cmd/webviewer/` | 140 + 6 281 + 462 测试 | 内嵌网页调试器：`embed index.html` + `/api/methods` + `/api/query` | `main.go:25/64/76`；`query.go` 方法注册表 | ★★ 与 `tdx_server.py` 可互相借鉴 |
| `cache/` | 约 9 万字节 | Redis 缓存层（ZSet 闭合历史 + String 实时、singleflight、熔断） | `cache/client.go`、`cache/ts.go` | ✗ pythontdx 用 SQLite/Parquet，不引入 Redis |
| `block.go` | 167 | 板块文件二进制解析（flat/grouped） | `ParseBlockFlat` `:38` | 参考，pythontdx 已有 |

**一句话概括 gotdx 的分层**：

```
proto（字节级编解码，一个命令一个文件）
  → client_quote / client_mac / client_exquote（一层薄封装，返回协议结构体）
    → client_unified（Stock*/MAC*/Ex*：补齐字段、自动翻页、幂等建连）
      → execute()（唯一入口：借连接 → 收发 → 解析 → 归还/销毁 → 判空换节点）
```

这个「**唯一执行入口**」的设计是 gotdx 最值得抄的结构：`client_helpers.go:32` 的 `execute`
承担了全部连接治理，任何新协议只要落到 `client.execute(obj)` 就自动获得池化、重试、换节点。

---

## 3. 协议命令全集

### 3.1 帧格式、压缩与加密

**请求头（16 字节）** `proto/proto.go:139-146`：

```go
type ReqHeader struct {
	Zip        uint8  // 压缩标志位；零表示不压缩，0x0c 为客户端常用取值。
	SeqID      uint32 // 请求编号，四字节；全局自增
	PacketType uint8  // 报文类型；一为普通请求类报文。
	PkgLen1    uint16 // 报文体长度冗余字段一
	PkgLen2    uint16 // 报文体长度冗余字段二，取值与 PkgLen1 相同
	Method     uint16 // 协议命令码
}
```

- `PkgLen1/2` **双写同一值且等于「命令码 2 字节 + 负载长度」**（见各 `BuildRequest`，如
  `proto/get_security_bars.go:102` 的 `0x1c = 2 + 26`）。pythontdx 的 `encode_frame` 用
  `length = len(data) + 2`（`tdx_bridge.py:432`），语义一致。
- `Zip = 0x0c` 是**全部**协议的固定值（`grep "reqHeader.Zip = "` 命中 78 处，全部 `0x0c`，
  无一处用 `0x00`）。它不是压缩开关（压缩由响应头 `ZipSize/UnZipSize` 决定），更像客户端标识。
- 少数「通用格式」请求走另一套头 `genericReqHeader`（`proto/proto.go:148-154`，`head/customize/packetType`），
  由 `buildGenericRequest` 拼装（`:182`）。使用它的有：`0x0547` 加密行情、`0x0fd1` 抽样图、
  `0x264b/0x26ac/0x26ad/0x26ae/0x26b1`。

**响应头（16 字节）** `proto/proto.go:160-168`：

```go
type RespHeader struct {
	I1        uint32 // 响应保留标识
	I2        uint8
	SeqID     uint32 // 回显的请求编号
	I3        uint8
	Method    uint16 // 回显的协议命令码
	ZipSize   uint16 // 压缩后负载长度
	UnZipSize uint16 // 解压后负载长度
}
```

**解压规则**：`ZipSize != UnZipSize` 即 zlib 压缩帧（`client.go:1314`），否则明文。
上限三道：

| 防护 | 位置 | 值 |
| --- | --- | --- |
| 单帧负载上限 | `client.go:1302`、`proto/proto.go:19` | `MessageMaxBytes = 1<<15 = 32768` |
| 解压放大倍数上限 | `client.go:34` `maxUnzipRatio` | 8 倍 → 最大 256 KB |
| 解压流截断 | `client.go:1331` `io.LimitReader(r, limit)` | 超限返回 `ErrBadData` |

pythontdx 的 `_read_frame` 只做 `zlib.decompress(raw)`（`tdx_bridge.py:620-623`），**没有**
长度上限与放大倍数上限——畸形帧可被构造成内存放大。这是可以直接抄的一条（见 9.1 的 L4）。

**加密**：全仓库仅一处业务级加密——`0x0547` 响应整体与 `0x93` 逐字节异或
（`proto/get_quotes_encrypt.go:116-120`）：

```go
// 整段报文与 0x93 逐字节异或解密。
xor := make([]byte, len(data))
for i := range data {
	xor[i] = data[i] ^ 0x93
}
```

与 pythontdx `parse_refresh` 的 `bytes(byte ^ 0x93 for byte in body)`（`tdx_bridge.py:1396`）一致。

### 3.2 连接与基础命令

| 命令 | 常量 | 文件 | 请求 | 响应要点 | pythontdx |
| --- | --- | --- | --- | --- | --- |
| `0x000d` | `KMSG_CMD1` | `proto/hello1.go:49` | 固定握手负载 | 服务端名/网址/类别/时间（GBK 定长段） | ✅ 唯一握手 |
| `0x0fdb` | `KMSG_CMD2` | `proto/hello2.go:51` | 固定登录负载 | 提示文案/下载链接/附加消息 | ❌ 未发（`tdx_bridge.py:17` 注释：三连包会让服务端进旧会话） |
| `0x0004` | `KMSG_HEARTBEAT` | `proto/server.go` `HeartBeat` | 空 | 打包日期整数 | ✅ |
| `0x0015` | `KMSG_PING` | `proto/server.go` `Info` | 空 | 时延/服务端时间/文案/签名 | ❌ |
| `0x000a` | `KMSG_ANNOUNCEMENT` | `proto/server.go` | 空 | 服务商公告正文 | ❌ |
| `0x0002` | `KMSG_EXCHANGEANNOUNCE` | `proto/server.go:38` | 空 | 交易所公告版本号+正文 | ❌ |
| `0x0010` | `KMSG_FINANCEINFO` | `proto/get_company_info.go` | 市场+代码列表 | 财务 136B 记录 | ✅ |
| `0x000f` | `KMSG_XDXRINFO` | `proto/get_company_info.go` | 市场+代码列表 | 除权除息 | ✅ |
| `0x02c5` | `KMSG_BLOCKINFOMETA` | `proto/get_file.go:45` | 40B ASCII 文件名 | 文件大小/哈希 | ✅ |
| `0x06b9` | `KMSG_BLOCKINFO` | `proto/get_file.go` | 偏移+长度+300B 路径 | 文件分块 | ✅ |
| `0x02cf` | `KMSG_COMPANYCATEGORY` | `proto/get_company_info.go:60` | 市场+代码 | F10 目录 | ✅ |
| `0x02d0` | `KMSG_COMPANYCONTENT` | `proto/get_company_info.go` | +80B 文件名+偏移+长度 | F10 正文分块 | ✅ |
| `0x044e` | `KMSG_SECURITYCOUNT` | `proto/get_security_count.go:43` | 市场+日期 | 证券总数 | ✅ |
| `0x044d` | `KMSG_SECURITYLIST` | `proto/get_security_list.go:66` | 市场+start u32+count u32+zero u32 | 每只：代码 6B+vol u16+名称 16B+unknown f32+**小数位 1B**+昨收 f32+2×u16 | ✅ |
| `0x0450` | `KMSG_SECURITYLIST_OLD` | `proto/get_security_list_old.go:48` | 市场+start u16 | 旧版列表 | ❌ |
| `0x0452` | `KMSG_SECURITYFEATURE452` | `proto/experimental.go:258` | start u32+count u32+one u32+zero u16 | count u16 + 13B/条（市场 1B + 代码 u32 + f32 + f32） | ✅（pythontdx 解读为涨停/跌停价，见 3.8） |

### 3.3 主站行情命令（0x04xx / 0x05xx）

| 命令 | 常量 | 文件 | 请求要点 | 响应要点 | 分页 | pythontdx |
| --- | --- | --- | --- | --- | --- | --- |
| `0x053e` | `SECURITYQUOTES` | `proto/get_security_quotes.go:105` | 模式字 5 + 6B 零 + 数量 + 每只 7B | 每只：市场+代码+活跃度+基准价+5 差值+时间+现量+额 f32+内外盘+**五档**+涨速/100 | ≤80 只（实测） | ✅ 旧版五档 |
| `0x054c` | `QUOTES` | `proto/get_quotes.go`（`GetQuotes`） | 同上（模式字 5） | 与 `0x054b` 同构，`QuoteListItem` | ≤80 | ✅ 批量快照 |
| `0x054b` | `QUOTESLIST` | `proto/get_quotes_list.go:89` | 9×u16：分类/排序/start/count/方向/5/过滤/1/0 | `Block u16 + Count u16 +` 条目（含 `RiseSpeed/ShortTurnover/OpeningRush/Min2Amount/VolRiseSpeed/Depth`） | start u16，页 ≤80 | ✅ 分类行情 |
| `0x0547` | `QUOTESENCRYPT` | `proto/get_quotes_encrypt.go:68` | 数量 u16 + 每只（市场 1B+代码 6B+**u16 22234+u16 2**） | XOR 0x93；每条含五档 + 10B 尾 + 6×4 变长价格 | 未声明 | ✅ 但语义不同（见 5.7） |
| `0x0523` | `SECURITYBARS` / `INDEXBARS` | `proto/get_security_bars.go:82`、`get_index_bars.go:79` | 市场+代码+周期+倍数+start u16+count u16+复权 u16+8B 保留 | 2B 条数 + 每条（日期 4B + 4 个变长价 + vol f32 + amount f32）；指数多 4B 家数 | start/count 均 u16；pythontdx 实测同族 `0x052d` 单页 ≤800 | ✅ `0x052d` 偏移版 |
| `0x052d` | `SECURITYBARS_OFFSET` | `proto/get_security_bars_offset.go:24` | 同 `0x0523` | 价格改为**相对昨收的增量**累加 | 同上 | ✅ 主用 |
| `0x0537` | `MINUTETIMEDATA` | `proto/get_minute_time_data.go:52` | 市场+代码+start u16+count u16 | 分时点序列 | start u16 | ✅ |
| `0x056a` | `AUCTION` | `proto/get_auction.go:66` | 市场+代码+zero u32+**mode u32(默认3)**+zero u32+start u32+count u32 | 2B 条数 + 16B/条（时分 u16+价 f32+已匹配 u32+**未匹配 int32**+秒 1B） | start/count 均 u32 | ✅ |
| `0x053f` | `TOPBOARD` | `proto/get_top_board.go:67` | category u8+mode u8(默认5)+7B 保留+size u8(默认20) | 1B size 后 **9 个榜单 × size × 15B**（市场+代码+f32 价+f32 指标） | 每榜 ≤255 | ❌ **新增** |
| `0x0563` | `UNUSUAL` | `proto/get_unusual.go:61` | 市场 u16+start u32+count u32（默认 600） | 2B 条数 + **32B/条**，含 13B 类型负载 | start/count u32 | ❌ **新增（7709 侧）** |
| `0x051d` | `INDEXINFO` | `proto/get_index_info.go:69` | 市场 u16+代码 6B+zero u32 | 条数 u32+市场+代码+活跃度+变长快照+**档位分布** | 档位条数由首字段给出 | ❌ **新增** |
| `0x051c` | `INDEXMOMENTUM` | `proto/get_index_momentum.go:43` | 市场 u16+代码 6B | 2B 条数 + 变长累计动量 | 无 | ❌ **新增** |
| `0x051a` | `VOLUMEPROFILE` | `proto/get_volume_profile.go:77` | 市场 u16+代码 6B | 盘口快照 + **价位分布**（价/量/主买/主卖） | 档数由首字段给出 | ❌ **新增** |
| `0x0fd1` | `CHARTSAMPLING` | `proto/get_chart_sampling.go:51` | 市场+代码+28B 固定模板 | 42B 头 + 每点 f32 | 无 | ✅ |
| `0x0ffc` | —（非 gotdx） | — | — | — | — | ✅ pythontdx 自研资金流 |

> `0x054b` 的 9 个 u16 顺序在 gotdx 为 `Category, SortType, Start, Count, SortReverse, Mode=5, Filter, One=1, Zero`
> （`proto/get_quotes_list.go:22-31`），与 pythontdx `category_data`（`tdx_bridge.py:711-738`）逐字段一致。

### 3.4 历史数据命令（0x0fxx）

| 命令 | 常量 | 文件 | 请求 | 响应 | 分页 | pythontdx |
| --- | --- | --- | --- | --- | --- | --- |
| `0x0fc5` | `TRANSACTIONDATA` | `proto/get_transaction_data.go:66` | 市场 u16+代码+start u16+count u16 | 2B 条数 + 每条（时分 u16+价差+量+笔数+方向+未知） | start/count u16 | ✅ 当日逐笔 |
| `0x0fc6` | `TRANSACTIONDATA_TRANS` | `proto/get_history_transaction_data_trans.go:53` | 同 `0x0fc5` | 2B 条数+**昨收 f32** +（时分+价差+量+笔数+**方向 u16**） | 同上 | ✅ 历史逐笔 |
| `0x0fb5` | `HISTORYTRANSACTIONDATA` | `proto/get_history_transaction_data.go:64` | 日期 u32+市场 u16+代码+start u16+count u16 | 2B 条数+4B 保留 +（时分+价差+量+方向+未知） | 同上 | ✅ |
| `0x0fb4` | `HISTORYORDERS` | `proto/get_history_orders.go:53` | 日期 u32+市场 u8+代码 6B | 2B 条数+**昨收 f32** +（价差+未知+量） | 无 | ⚠️ 与 pythontdx `0x0fb4` 语义冲突，见 3.8 |
| `0x0feb` | `HISTORYMINUTETIMEDATE` | `proto/get_history_minute_time_data.go:51` | **日期 int32（取负）**+市场 u8+代码 | 2B 条数 +（价+均价+量） | 无 | ✅ 近期分时 |
| `0x0fd1` | `CHARTSAMPLING` | 见上 | — | — | — | ✅ |
| `0x0fb4`(?) | — | — | — | — | — | ✅ pythontdx 用作历史分时 |

### 3.5 MAC 命令（0x12xx）

| 命令 | 常量 | 文件 | 说明 | pythontdx |
| --- | --- | --- | --- | --- |
| `0x120f` | `MACSERVERINFO` | `proto/mac_server_info.go:67` | 服务端交易日时段 | △ |
| `0x1215/0x1217` | `MACFILELIST/DOWNLOAD` | `proto/mac_file.go:49` | 文件查询/下载 | △ |
| `0x1218` | `MACCAPITALFLOW` / `MACSYMBOLBELONGBOARD` | `proto/mac_capital_flow.go:65`、`mac_symbol_belong_board.go:82` | **同一命令两个字面量**（常量表 `proto/proto.go:93,98` 重复定义 0x1218），靠头部标识区分 | ✅ 资金流 |
| `0x122a` | `MACSYMBOLINFO` | `proto/mac_symbol_info.go:71` | 股票摘要 | ❌ |
| `0x122b` | `MACSYMBOLQUOTES` | `proto/mac_symbol_quotes.go:63` | 批量报价（**20B 字段位图**） | ✅ 122 位 |
| `0x122c` | `MACBOARDMEMBERS` | `proto/mac_board_members.go:63`、`mac_board_members_dynamic.go:228` | 板块成员 / **动态字段版** | ✅ |
| `0x122d` | `MACQUOTES` | `proto/mac_quotes.go:86` | 单只快照 + 分时采样 | ✅ |
| `0x122e` | `MACSYMBOLBARS` | `proto/mac_symbol_bars.go:100` | 统一 K 线（含期货日历修正） | △ |
| `0x122f` | `MACTRANSACTIONS` | `proto/mac_transactions.go:67` | 分时成交 | ✅ |
| `0x1231` | `EXBOARDLIST` | `proto/mac_board.go:54` | 板块榜单 | ✅ |
| `0x1237` | `MACMARKETMONITOR` | `proto/mac_market_monitor.go:78` | 市场监控 | ✅ |
| `0x123d` | `MACAUCTION` | `proto/mac_auction.go:65` | 竞价 | ✅ |
| `0x123e` | `MACTICKCHARTS` | `proto/mac_tick_charts.go:92` | 多日分时 | ✅ |
| `0x124a` | `MACKLINEOFFSET` | `proto/mac_kline_offset.go:47` | K 线偏移信息（`Returned` 字段判空） | △ |

MAC 侧**唯一强烈建议吸收**的是 20 字节字段位图（`mac_bitmap.go` + `proto/mac_board_members_dynamic.go`），
详见 [6.6](#66-bitmap-字段mac_bitmapgo)。

### 3.6 扩展市场命令（0x23xx / 0x24xx，边界外）

`0x23f0/0x23f4/0x23f5/0x23f6/0x23fa/0x23fb/0x23ff/0x2412/0x2422/0x2423/0x2454/0x2455/0x2458/0x2459/0x2484/0x2487/0x2488/0x2489/0x248a/0x248b/0x248c/0x254d/0x2562`
——全部服务港股/美股/期货/期权/外汇，**pythontdx 明确不做**（`AGENTS.md` 硬规则 8）。
其中 `0x2422/0x2423`（EX 表格 `ExGetTable`/`ExGetTableDetail`，`proto/ex_file.go:213/227`）
是「分块拉表格文本」，思路可借但数据源不可用。

### 3.7 试验与客户端上报命令（0x00xx / 0x26xx）

| 命令 | 构造 | 载荷 | 判读 | 价值 |
| --- | --- | --- | --- | --- |
| `0x000b` | `NewTodoB()` `proto/experimental.go:97` | 固定 280B 十六进制（大量重复串 `749933ae27700357`） | 原始字节 + hex | 极低（固定密文，语义未知） |
| `0x0fde` | `NewTodoFDE()` `:139` | 空 | 原始字节 | 极低 |
| `0x264b` | `NewClient264B()` `:143` | `{0x00,0x64}` | 原始字节 | 低（客户端特征上报） |
| `0x26ac` | `NewClient26AC()` `:161` | 0/100 + u16 1234 + 24B 零 + IP 192.168.0.1 + MAC "macadd" + 40/1864/0 | 原始字节 | 低（客户端环境上报，含**硬编码内网 IP/MAC**） |
| `0x26ad` | `NewClient26AD()` `:183` | 同上 + 16B "TDXW" + 17B 固定令牌 `OPr2IHZ5r3luK9Ka` | 原始字节 | 低（含硬编码令牌） |
| `0x26ae` | `NewClient26AE()` `:149` | `{0x00,0x64}` | 原始字节 | 低 |
| `0x26b1` | `NewClient26B1()` `:155` | `{0x00,0x64,0x00}` | 原始字节 | 低 |

**结论**：`0x264b/0x26ac/0x26ad/0x26ae/0x26b1` 在 gotdx 里**没有被解析**，只把响应原样转 hex
（`RawDataReply`，`:13-17`），说明作者自己也没搞清楚语义。若把这些包发给生产节点，可能改变
服务端会话状态（gotdx 已记录「三连包会让服务端进旧版会话」的教训，见 `tdx_bridge.py:17`）。
**建议一律不接**：收益为 0，风险非 0。

### 3.8 pythontdx 可能缺口的专项分析

#### （1）`0x0563` 主力监控（异动）—— **高价值，立刻可落地**

- 请求：`Market u16 + Start u32 + Count u32`（默认 600），`proto/get_unusual.go:23-27`。
- 响应：`Count u16` + **每条定长 32 字节**（`:103-133`）：

```go
base := int(i)*32 + 2
market  := binary.LittleEndian.Uint16(data[base : base+2])      // 0
code    := Utf8ToGbk(data[base+2 : base+8])                     // 2
eventType := data[base+9]                                       // 9
index   := binary.LittleEndian.Uint16(data[base+11 : base+13])  // 11
desc, value := unpackUnusualByType(eventType, data[base+15:base+28]) // 15..27
hour    := int(data[base+29])                                   // 29
minuteSec := int(binary.LittleEndian.Uint16(data[base+30 : base+32]))
```

- 事件类型解析共 **19 个 case**（`:161-250`）：`0x03` 主力买/卖、`0x04` 加速拉升、`0x05` 加速下跌、
  `0x06` 低位反弹、`0x07` 高位回落、`0x08` 撑杆跳高、`0x09` 平台跳水、`0x0a` 单笔冲涨/冲跌、
  `0x0b` 区间放量涨/跌/平、`0x0c` 区间缩量、`0x10` 大单托盘、`0x11` 大单压盘、`0x12` 大单锁盘、
  `0x13` 竞价试买、`0x14` 逼近/封/打开涨跌停 + 封单大减（含子类型 `0x01/0x02/0x04/0x05`）、
  `0x15` 尾盘打压/对倒/拉升、`0x16` 盘中强势/弱势、`0x1d` 急速拉升、`0x1e` 急速下跌。
- **A 股适用性**：极高。这是通达信「主力监控」面板的原生数据，A 股散户最常看的功能之一。
- **pythontdx 现状**：`fetch_unusual` 走 MAC（`python/tdx_mac.py`，`tdx_bridge.py:64` 导入），
  依赖 7615 MAC 通道。改走 7709 `0x0563` 可去掉一次跨通道依赖，且 `0x0563` 是主站原生。
- **风险**：`Count=600` 时响应 19 KB，已接近 `MessageMaxBytes=32768`；分页（`Start`）需实测是否生效【未验证】。
- **落点**：`python/tdx_bridge.py` 新增 `CMD_UNUSUAL = 0x0563` + `parse_unusual()`；
  `Bridge.unusual()` 取代 `mac_unusual`（`tdx_bridge.py:3756`）的默认实现。

#### （2）`0x053f` 排行榜 —— **高价值，立刻可落地**

- 请求：`Category u8 + Mode u8(默认 5) + 7B 保留(00 00 00 00 01 00 00) + Size u8(默认 20)`（`proto/get_top_board.go:23-28,69`）。
- 响应：1 字节 size，随后 **9 个榜单按固定顺序**（`:120-130`）：
  涨幅、跌幅、振幅、涨速、跌速、量比、正委比、负委比、换手。每条 15 字节：

```go
item := TopBoardItem{
	Market: data[pos],
	Code:   Utf8ToGbk(data[pos+1 : pos+7]),
	Price:  float64(math.Float32frombits(binary.LittleEndian.Uint32(data[pos+7 : pos+11]))),
	Value:  float64(math.Float32frombits(binary.LittleEndian.Uint32(data[pos+11 : pos+15]))),
}
```

- **A 股适用性**：极高。pythontdx 现在要拿「涨幅榜」得用 `0x054b` 逐页翻（`category_snapshot`，
  `tdx_bridge.py:3961`），一次只能拿一个榜单；`0x053f` 一次请求 9 个榜单共 `9×size` 条，
  请求/响应往返从 9 次降到 1 次。
- **风险**：`Category` 取值域未在源码中枚举（只给了「板块或市场分类」），需要用 `0x054b` 的
  category 值试【未验证】；`Value` 的口径随榜单变化（源码也标「语义待确认」）。
- **落点**：`Bridge.top_board(category, size)`；HTTP `/api/top_board`。

#### （3）`0x051a` 成交分布（Volume Profile）—— **高价值，中期**

- 请求：`Market u16 + Code 6B`（`proto/get_volume_profile.go:23-26`）。
- 响应 = **一份盘口快照 + 一组价位分布**（`:106-183`）：
  - 头部 11 字节：`Count u16 + Market u8 + Code 6B + Active u16`；
  - 快照：基准价 + 昨收/开/高/低差值 + 时间 + 特殊价 + 量 + 现量 + 额 f32 + 内外盘 + 2 统计 + **3 档买卖** + `Unknown u16`；
  - 分布：`Count` 条 × `(价差, 量, 主买, 主卖)`，**价为累计差值**。
- 关键修正（`:197-203`）：

```go
func decodeVolumeProfilePriceDelta(value int) int {
	if value >= 1<<31 {
		return int(int32(uint32(value)))
	}
	return value
}
```

> 分布档位的负价差会以 32 位补码返回，变长解码后变成大正数，必须回填为 int32——
> pythontdx 若要实现此协议，必须带上这段归一化，否则价位会跳到天上。

- **A 股适用性**：高。「筹码分布 / 成交密集区」是通达信 PC 端的核心分析功能，A 股用户强需求；
  同时它顺带给出 3 档盘口 + 内外盘，可用于分时副图。
- **风险**：`Count` 与档位密度未知，若一次给几百档，`MessageMaxBytes` 可能不够【未验证】。
- **落点**：`Bridge.volume_profile(code)`；`lake/volume_profile` 归档（按 `trade_date` 分区）。

#### （4）`0x051d` 指数概况 / `0x051c` 指数动量 —— **中价值**

- `0x051d`（`proto/get_index_info.go:19-46`）：给指数点位、涨跌、成交量额、**上涨/下跌家数**、
  以及 `Orders []IndexInfoOrder`（档位价格+挂单量）。价格全部是**相对最新点位的差值**：

```go
obj.reply.Close = float64(closeRaw) / 100.0
obj.reply.PreClose = float64(closeRaw+preCloseDiff) / 100.0
obj.reply.Diff = float64(-preCloseDiff) / 100.0   // 昨收差值取反编码
obj.reply.Open = float64(closeRaw+openDiff) / 100.0
```

- `0x051c`（`get_index_momentum.go:70-91`）：`Count u16` + `Count` 个变长增量，本地累加得累计动量。
- **A 股适用性**：中。pythontdx 的「涨跌家数」目前靠 `market_breadth` 翻 `0x054b` 全表
  （`tdx_bridge.py:4195`、`:4203`，`docs/releases/编年史.md` 第三十六节记录过一次 14.97s→2.9s 的优化），
  若 `0x051d` 的 `UpCount/DownCount` 对沪深指数有效，可直接省掉全表翻页。
  **但该结论依赖服务端行为，属【未验证】——必须先探测再改架构。**
- **落点**：先写探针脚本（`scripts/`），验证 `sh000001`/`sz399001` 的 `UpCount/DownCount`
  是否非零；有效再接入 `Bridge.market_breadth`。

#### （5）`0x0547` 加密批量行情 —— **已有，且不要照搬 gotdx**

见 [5.7](#57-0x0547-的两种实现对照)。

#### （6）`0x0fb4` 历史委托 vs 历史分时 —— **两家语义冲突，须实测**

- gotdx：命令名 `KMSG_HISTORYORDERS = 0x0fb4`，注释「历史委托」，响应 `Count u16 + PreClose f32
  + (价差, 未知, 量)`，字段名 `HistoryOrderData{Price, Unknown, Vol}`（`proto/get_history_orders.go:33-37`）。
- pythontdx：`CMD_HISTORY_MINUTE = 0x0FB4`，注释「历史分时」，响应 `Count u16 + prevClose f32
  + (价差, 均价增量, 量)`，并**用累计额/累计量自己算均价**（`tdx_bridge.py:2804-2856`）。
- **判断**：两者解析结构逐字段一致，只差命名；从「0x0fb4 紧邻 0x0fb5（历史分笔）」的编号规律
  和 pythontdx 的实际可用性看，**pythontdx 的语义更可能正确，gotdx 这里命名有误**。
  【未验证】——需要一次 0x0fb4 实测对照（把 `Unknown` 列与服务端分时均价比对）。
- **行动**：不采纳 gotdx 的命名；可在 `docs/03` 记一条「同名命令两家语义冲突，以实测为准」。

#### （7）`0x0452` 请求布局差异 —— **小改进**

- gotdx 请求 16 字节：`Start u32 + Count u32 + One u32(=1) + Zero u16`（`proto/experimental.go:223-228,280`），
  **有 start/count 分页**；响应 13 字节记录与 pythontdx `parse_special_limits` 完全一致。
- pythontdx 请求 14 字节：`start u16 + 12B 零`（`tdx_bridge.py:893-894`），`scan_special_limits(max_rows=10000)`
  靠循环翻。
- **改进**：把请求改成 `u32 start + u32 count`，一次 `count=2000` 拿完，避免多次往返；
  记录解析保持不变。风险：请求变长后服务端是否仍接受【未验证】，所以建议先双写探测。

#### （8）EX 表格（`0x2422/0x2423`）—— **不适用**

`proto/ex_file.go:157-271` 是「分块拉表格文本」：`Start u32 + Token + Mode u8`，
响应 `Size u32 + Content`。它服务扩展市场（港股美股期货板块表），**pythontdx 边界外**。
可借的只有「分块 + 空块终止」的范式，已被 `Bridge._download_bytes`（`tdx_bridge.py:5151`）覆盖。

### 3.9 分页语义汇总

| 语义 | 协议/位置 | 说明 |
| --- | --- | --- |
| **短页终止** | `StockAll` `client_unified.go:139`、`loadDecimalPointMarket` `:1214` | `if resp.Count < uint16(size) { break }`——本页不足即最后一页 |
| **空页终止** | `loadDecimalPointMarket` `:1214` | `len(reply.List) == 0` 也视为结束 |
| **多取一条基准** | `NewGetSecurityBars` `proto/get_security_bars.go:72` `req.Count = req.Count + 1` | 多要一根算昨收，解析后 `Count-1`（`:201`） |
| **首根丢弃** | 同上 `:195` | `if index == 0 { continue }` |
| **回扫命中即停** | `StockFullKLine` `client_unified.go:275` | 从最新向历史回扫，回调命中即保留并返回 |
| **u16 上限** | `0x054b` start/count 均 u16 | 全市场 5000+ 只需多页 |
| **u32 分页** | `0x0563`、`0x056a`、`0x0452`、`0x044d` | 大表用 u32 |
| **隐式单页** | `0x051a`、`0x051d`、`0x051c`、`0x053f` | 无 start，一次给完（`0x053f` 用 `Size` 控制） |

**给 pythontdx 的规则**：新增协议一律先确定「分页是 u16 还是 u32」「终止条件是空页还是短页」
「是否需要多取一条基准」，三者写进 `docs/15` 的状态表，不要靠试。

---

## 4. 连接与运行时机制

### 4.1 连接池数据结构

`client.go:90-115`：

```go
type Client struct {
	opt                 *Options
	pool                []*pooledConn // 连接池：仅存放空闲连接，借出的连接移出池
	mu                  sync.Mutex    // 池管理锁
	inUse               int           // 借出中的连接计数
	lastAddr            string        // 最近一条连接的实际地址
	lastDataAddr        string        // 最近一次命中数据的服务器地址
	next                int           // 轮询游标
	done                chan struct{}
	refill              sync.Once
	lastReachable       []string                 // 探活确认可达，按耗时升序
	addrLatency         map[string]time.Duration // 各地址建连耗时
	dialSamples         []time.Duration          // 建连耗时环形样本窗口
	health              map[string]*nodeHealth   // 空数据健康度
	heartbeatLatency    map[string]time.Duration // 心跳往返耗时
	slow                map[string]bool          // 慢连接标记
	lastActivityAt      time.Time
	rebalanceMu         sync.Mutex
	rebalanceTick       int
}
```

关键设计：**连接只在池里代表「空闲」**。借出即 `pool` 移除、`inUse++`，这样心跳巡检与重平衡
永远不会误关正在执行请求的连接（`acquire` 注释 `:329-342`、`release` `:569-578`）。

### 4.2 建池快路径与 500ms 自适应探测

| 机制 | 位置 | 参数/行为 |
| --- | --- | --- |
| 随机抽 3 候选并发拨号 | `client.go:1399-1417` | `limit := 3`；`rand.Perm(len(addresses))[:limit]` |
| 首个成功即返回 | `:1419-1436` | 只同步建 1 条，余量后台补 |
| 快路径拨号超时 | `client.go:694` `fastDialTimeout = 500 * time.Millisecond` | 样本不足时用 |
| 自适应 | `client.go:454-474` | 取最近 ≤16 样本中位数 × 1.5，钳制在 200ms~2s |
| 异步收尾 + 预比较 | `collectFastPathResults` `:1472-1579` | 收完余量、按耗时排序、`fastestLat < curLat*7/10` 则**提前切换** |
| 慢路径兜底 | `probeFirstReachable` `:1594-1652` | 流水线拨号，首个握手成功即复用，超时 `slowProbeTimeout=300ms` |
| 并发窗口 | `hosts.go:340` `probeConcurrencyWindow = 32` | 大池不全量并发，避免占满网络栈 |

自适应算法原文（`client.go:454-474`）：

```go
func (client *Client) adaptiveFastDialTimeoutLocked() time.Duration {
	if len(client.dialSamples) < dialSampleMinCount {   // 3
		return fastDialTimeout                            // 500ms
	}
	... median := samples[mid] ...
	candidate := time.Duration(dialTimeoutHeadroom * float64(median)) // ×1.5
	if candidate < fastDialMinTimeout { candidate = fastDialMinTimeout } // 200ms
	if candidate > fastDialMaxTimeout { candidate = fastDialMaxTimeout } // 2s
	return candidate
}
```

**为什么值得抄**：行情节点正常拨号几十毫秒，偶发秒级慢响应是服务器波动；固定 5~8 秒超时会让
一次建连把用户首屏拖到数秒。pythontdx 现在 `CONNECT_TIMEOUT = 5.0`（`tdx_bridge.py:329`）
且是**串行**按序试连（`:567-590`），最坏要 `5s × 候选数`。

### 4.3 后台补建

`refillLoop`（`client.go:602-652`）+ `refillPool`（`:1175-1229`）+ `refillPoolBulk`（`:874-924`）：

- 1 秒 ticker；启动时先 `refillPoolBulk()` 并发补满，再 `refillPool()`。
- 补建**优先复用池内首条连接的地址**（`known = client.pool[0].addr`，`:1182-1185`），
  保持节点亲和，避免每秒重新测速造成抖动。
- 首选地址失败才回退候选（`buildRefillConnection` `:836-869`）：先 `lastReachable`，再配置池，剔除首选。
- 容量判定：`len(pool)+inUse >= PoolSize` 即不再补（`:1177`）。

### 4.4 应用层心跳与慢连接识别

`heartbeatPool` `client.go:715-770`：

| 项 | 值 | 位置 |
| --- | --- | --- |
| 心跳周期（活跃） | 30 s | `:662` `heartbeatIntervalActive` |
| 心跳周期（空闲） | 60 s | `:663` `heartbeatIntervalIdle` |
| 空闲判定 | 最近借出 > 2 min | `:664` `idleActivityThreshold` |
| 近期活跃跳过窗口 | 2 min | `:665` `heartbeatFreshWindow` |
| 单次心跳超时 | 2 s | `:656` `heartbeatTimeout` |
| 慢连接倍数 | 中位数 × 2.0，且 ≥100 ms | `:686-688` |
| TCP keepalive | 15 s | `:271-272` |

心跳**复用握手协议**（`Hello1` / `ExLogin`），只验证「能完整收发一帧」，不校验内容
（`heartbeatConn` `:775-826`）：

```go
// 心跳只验证连接能完整收发，不关心应答语义。
if header.ZipSize != header.UnZipSize { ... io.Copy(io.Discard, r) ... }
```

`TryLock` 抢占失败即跳过（`:733`），避免与在途业务请求抢锁。
慢连接**不丢弃**，只打标记并后台触发一次 `rebalancePool(false)`（`:759,768`）——
「抖动不杀连接，迁出交给重平衡」这个取舍值得抄。

### 4.5 重平衡与节点切换阈值

`rebalancePool` `client.go:937-1170`：

| 机制 | 值 | 位置 |
| --- | --- | --- |
| 健康周期 | 60 s | `:672` `defaultRebalanceInterval` |
| 慢节点周期 | 15 s | `:674` `slowRebalanceInterval` |
| 默认切换阈值 | 新节点须低于当前 70% | `:677` `rebalanceSwitchRatio = 0.7` |
| 慢节点切换阈值 | 低于 90% 即迁出 | `:680` `slowNodeSwitchRatio = 0.9` |
| 慢节点判定 | 当前建连耗时 ≥ 池内中位数 × 1.5 | `:683` `slowNodeRatio` |
| 全量探活频率 | 每 5 轮一次 | `:949` `rebalanceTick%5 == 0` |
| 切换方式 | **先建后删**，保留已指向 fastest 的连接 | `:1149-1169` |

```go
// 池内已指向最快地址的连接保持可用（P2 优化），只补建缺失数量，避免切换时全池重连引发无谓的建连风暴
existingFastest := 0
for _, pc := range client.pool { if pc.addr == fastest { existingFastest++ } }
need := client.opt.PoolSize - existingFastest
```

**权衡**：`0.7` 档位 + 1 分钟周期 = 每分钟最多切换一次，且必须显著更优；`0.9` + 15 s 只在
「已经确认这个节点慢」时启用。这套「双阈值」是防「建连风暴」的关键，直接把 gotdx 自己的
`docs/benchmark_vs_gotdx_online.md:157-175` 里的教训写进了代码。

### 4.6 deadline 与帧读写

`exchangeBytes`（`client.go:1253-1343`）：

1. `conn.SetDeadline(now + timeout)`，`defer` 清零（`:1255-1258`）——**每次请求独立 deadline**，
   不复用连接级超时。
2. 发送带偏移续写，部分写不整包重发（`:1263-1283`）。
3. 帧头从 `sync.Pool` 复用 16 字节缓冲（`:45-51`、`:1287-1288`）。
4. `header.ZipSize > proto.MessageMaxBytes` 直接拒绝（`:1302`）。
5. `ZipSize != UnZipSize` 才解压，且 `LimitReader` 截断（`:1314-1338`）。

**pythontdx 对照**：`sock.settimeout(REQUEST_TIMEOUT)` 在连接级设置一次（`tdx_bridge.py:573`），
没有 per-request deadline；`_recv_exact` 靠 `recv` 累积（`:592-604`）本身是安全的，
但「一次慢请求会污染后续超时」的问题不存在（因为 socket 超时不是滑动窗口），
风险点主要在**没有帧长上限**。

### 4.7 空数据换节点与节点健康度

这是 gotdx 相对其他通达信库最实用的一条。`execute`（`client_helpers.go:32-69`）：

```go
reply, addr, err := client.executeOnce(protocol)
...
if isEmptyReply(reply) {
	if client.opt.DisableEmptyNodeSwitch { return reply, nil }
	client.clearDataAddr(addr)          // 解除定向
	client.recordNodeHealthEmpty(addr)  // 健康度 +1
	sendData, buildErr := protocol.BuildRequest()
	if nonEmpty, nonEmptyAddr, found := client.parallelEmptyRetry(protocol, sendData); found {
		client.recordNodeHealthOK(nonEmptyAddr)
		client.setDataAddr(nonEmptyAddr)
		return nonEmpty, nil
	}
	if client.hasDegradedNode() { go client.rebalancePool(true) }
	return reply, nil
}
```

- 判空：反射只读一个字段（`isEmptyReply` `:166-181`）——有 `Count uint16` 看是否为 0，
  否则看 `Returned uint32`。**不判空**的类型（原始字节、非结构体）自动免疫。
- 并发重试：最多 2 条连接并行（`:85` `maxEmptyRetry`），**协议对象不跨 goroutine**：
  主线程只构建一次 `sendData` 字节，探测 goroutine 只收发，`ParseResponse` 与记账回主线程
  （`:71-82` 注释、`:129-158` 实现）。
- 健康度：`emptyStreak ≥ 3` 降权（`:217` `healthDowngradeThreshold`），定向与轮询都跳过它
  （`acquireOnce` `client.go:369,383-390`）。

**为什么重要**：pythontdx 已实测到「部分主站历史数据不全」的现象（`docs/06` 有类似记录），
但当前是单连接（`TdxConnection`），只能靠 `_mac_fallback` 兜底（`tdx_bridge.py:3773`），
而 MAC 通道本身是另一个数据源。gotdx 的做法是**同协议多点重试**，数据源不变，更适合
「只接通达信」的定位。

### 4.8 代际（generation）与并发锁模型

**generation 只存在于订阅工厂**，不在连接池（`grep -n "gen"` 全仓库仅 4 处）：
`client_subscribe_factory.go:76`（字段）、`:160`（重建时 `t.gen++`）、`:214`（循环启动时快照）、
`:217`（退出清理前比对）。

```go
defer func() {
	f.mu.Lock()
	if f.tasks[t.key] == t && t.gen == gen {   // 只有当前代际才回收任务表条目
		delete(f.tasks, t.key)
	}
	f.mu.Unlock()
}()
```

作用：订阅间隔被下调时，会「关旧循环 → 重建新循环」；旧循环退出时若无条件 `delete`，会把
新循环刚注册的条目一起删掉。`gen` 是**廉价且正确的代际校验**。

> 注：pythontdx `docs/15` 把「pool/deadline/generation」归为 Rust 参考设计；本次核查确认
> gotdx 里确实有 generation，但**只在订阅工厂**，连接池没有。两处说法不冲突，但引用时要写清。

**锁模型**（四个层级，互不嵌套）：

| 锁 | 保护对象 | 位置 |
| --- | --- | --- |
| `Client.mu` | 池增删、`inUse`、`lastDataAddr`、`health`、`slow`、`addrLatency`、`dialSamples` | `client.go:93` |
| `pooledConn.mu` | 单连接先写后读的帧边界 | `client.go:121` |
| `Client.rebalanceMu` | 重平衡串行（`TryLock`，重入直接放弃） | `client.go:113`、`:938` |
| `Subscriber.mu` / `subTask.mu` | 任务表增删 / 快照与推送串行 | `client_subscribe_factory.go:34,65` |

关键纪律：**网络操作永远在锁外**（`rebalancePool` 注释 `:943`、`refillPool` 注释 `:1190`），
锁内只做内存状态变更。

### 4.9 Python 等价实现建议

pythontdx 是 stdlib-only + 单进程 sidecar（`tdx_bridge.py` 顶部注释），不要引入 Go 式
goroutine 模型，用**线程 + 队列**即可：

| gotdx 机制 | Python 等价物 | 复杂度 | 建议 |
| --- | --- | --- | --- |
| `PoolSize=3` 连接池 | `queue.Queue` 存 3 个 `TdxConnection`，`get(timeout=0.1)` / `put()` | 低 | **可落地**（首屏并发） |
| 借出即出池 | `Queue` 天然语义一致 | — | 直接对应 |
| 建池快路径（3 候选并发） | `ThreadPoolExecutor(max_workers=3)` + `as_completed`，首个成功即 `cancel` 其余 | 中 | 可落地（注意 `_connect` 目前串行） |
| 自适应拨号超时 | `statistics.median(recent_dial_samples[-16:]) * 1.5`，`clamp(0.2, 2.0)` | 低 | 可落地 |
| 心跳 30s/60s | 后台 `threading.Thread` + `Event.wait(interval)` | 低 | 可落地 |
| 重平衡（双阈值） | 同上，用 `time.monotonic()` 计时 | 中 | 中期 |
| 空数据换节点 | 池内 `for` 最多 2 条并发 `submit`，`as_completed` 取首个非空 | 中 | **优先** |
| 节点健康度 | `dict[addr, int]` + `threading.Lock` | 低 | 优先 |
| per-request deadline | 每次 `request()` 前 `sock.settimeout(remaining)`，结束后还原 | 低 | 可落地 |
| 帧长/解压上限 | `if zip_len > 32768: raise`；`zlib.decompressobj().decompress(raw, 262144)` | 低 | **立刻** |
| generation | `self._generation += 1`；线程退出前比对 | 低 | 订阅实现时用 |

**注意**：

- CPython 的 GIL 让「多连接并行」只对 IO 等待有效——这恰好是行情场景（网络 RTT 主导），
  所以线程池方案收益真实；纯 CPU 解析不会再加速。
- 不要用 `multiprocessing`：连接池需要共享 socket 状态，跨进程代价远大于收益。
- `socket` 的超时语义是「阻塞操作超时」而非「总耗时」，per-request deadline 必须自己算
  `remaining = deadline - monotonic()` 并在每次 `send/recv` 前重设。

---

## 5. 数据推送模式（重点）

### 5.1 事实核查：gotdx 的「推送」到底是什么

任务书假设 gotdx 有「0x0547 推送帧 + 游标」。**核查结论：不成立。**

| 检证 | 证据 |
| --- | --- |
| `0x0547` 在 gotdx 是请求/响应协议 | `proto/get_quotes_encrypt.go` 完整实现 `BuildRequest`/`ParseResponse`，一次请求一次响应 |
| 无游标字段 | 请求体每只证券固定 11 字节：`市场 1 + 代码 6 + u16 22234 + u16 2`（`:89-106`），4 字节是**常量**不是游标 |
| 无「未配对帧」处理 | `exchangeBytes` 只读一帧就返回（`client.go:1289-1311`），没有「msg_id 不匹配则入队」的逻辑；全仓库无 `push`/`pushFrames` 字样 |
| 全仓库只有一种「推送」 | `client_subscribe_factory.go` 的 `Subscriber`，实现是 `time.NewTimer` 轮询（`:231`、`:239-245`） |
| `client_quote.go` 无推送代码 | 其 `GetQuotesEncrypt`（`:299`）只是一层薄封装：`return client.execute(obj)`，没有「读多帧」或「按游标续读」的分支 |
| `client_unified.go` 无推送代码 | `StockQuotesEncrypt`（`:461`）同样只是 `quotationClient()` + `execute`，未涉及游标状态 |

**gotdx 没有服务端主动推送协议。** 它的「推送」= 定时拉取 + 快照对比 + 变化回调。

而 pythontdx 反而**已经**实现了「未配对帧入队」：`TdxConnection._transact` 在 `msg_id` 不匹配时
`self.push_frames.append(...)`（`tdx_bridge.py:641-646`），并在 `_drain_quote_pushes` 里消化
（`:3826-3852`）。这是 pythontdx 更接近「推送」的地方，且注释写明「主站不推送时这里是空操作」——
即**该路径尚未被证实有真实推送帧**。

> 小结：**不要因为「gotdx 有推送模式」就去改 pythontdx 的 0x0547**。gotdx 值得抄的是
> **订阅工厂的语义设计**，不是某个推送协议。

#### README「行情订阅」章节的说法与实现对照

`README.md:344-391` 是 gotdx 唯一的「行情订阅」文档，原文关键句：

```text
`Client.Subscriber()` 返回的 `Subscriber` 通用订阅工厂，对任意数据源建立"轮询 diff 推送"订阅：
内部按间隔轮询拉取快照（复用各查询方法请求协议，无需新增推送协议），快照变化时回调处理函数。
```

文档正文是**诚实的**（「按间隔轮询」「无需新增推送协议」），但同一份 README 的「空数据处理覆盖范围」
表格（`README.md:197`）里又写：

```text
| 订阅（`Subscriber`） | 不适用 | 长连接流式模型，不走 `execute` |
```

**「长连接流式模型」这个措辞与实现不符**——`Subscriber` 走的就是普通的 `execute`（每次
`Fetch` 调一次查询方法），只是循环在订阅层，不是「流式」。这类文档措辞在多轮转述后极易
被误读成「gotdx 有推送协议」，本节开头的事实核查就是为此而写。

README 里值得直接照搬的两处**用法**：

1. 订阅报价（`README.md:348-368`）与订阅 K 线（`:372-388`）的示例，展示了「`Fetch` 随便填哪个查询方法」
   的解耦程度；
2. K 线示例里自定义 `Changed` 的写法——`return len(new.List) > len(old.List)`「仅新 K 线出现时推送」，
   正是 [5.8](#58-把该模式用于-k-线--分时--逐笔--竞价) 里「日 K 必须自定义 Changed」的原型。

**结论**：README 是「用法文档」，可以照抄示例结构；但**不要把它当协议说明**，
「流式」二字没有任何代码支撑。

### 5.2 SubscribeSource / Fetch / Changed / Key 合并

类型定义（`client_subscribe_factory.go:45-49`）：

```go
type SubscribeSource[T any] struct {
	Key     string                // 可选数据源标识，相同标识合并轮询
	Fetch   func() (T, error)     // 拉取最新快照，返回错误时跳过本轮轮询
	Changed func(old, new T) bool // 两次快照是否不同；`nil` 时使用深比较
}
```

订阅入口（`Subscribe` `:93-164`）的完整语义：

1. `Fetch`/`handler` 为 nil 直接报错（`:94-99`）。
2. `interval <= 0` → 默认 3 s（`:28`、`:100-102`）。
3. `Changed == nil` → `reflect.DeepEqual` 深比较（`:103-105`）。
4. `Key == ""` → 生成 `__sub_<seq>` 独立任务（`:116-119`）。
5. 同 `Key` 已存在 → **校验类型一致**（`:143-145`，不一致返回错误），追加 handler 并
   `sh.pending.Store(true)`（`:146-147`）。
6. 同 Key 合并的好处：一次 `Fetch` 服务 N 个回调——「避免对服务器重复轮询」（文件头注释 `:9-11`）。

**合并粒度**：`Subscriber` 实例内（`f.tasks map[string]*subTask`，`:35`）。跨 `Subscriber`
不合并——pythontdx 若实现，应做成**进程级单例 Hub**，否则每个 HTTP 请求建一个 Subscriber
就退化成 N 倍轮询。

### 5.3 基线推送

两条路径：

- **首次订阅**：`runTask` 进来先 `f.pumpTask(t, true)`（`:223`），`force=true` 且
  `hasLast=false` → 无条件推送（`:256-258`、`:263`）。
- **追加订阅**：`sh.pending = true`，下一轮 `pumpTask` 里 `if h.pending.Swap(false)`
  无条件推送当前快照（`:283-288`），**不参与 diff 判定**。

```go
if force { force = !t.hasLast }        // 已有快照时不再强制推送
v, err := t.safeFetch()
changed := force || !t.hasLast || t.safeChanged(t.last, v)
```

**意义**：新加的订阅者立刻拿到一份完整数据，不必等「数据发生变化」。
这是 UI 首屏体验的关键——否则新开的图表面板会空白到下一次心跳。

### 5.4 间隔实时生效与循环重建

- 每轮结束都 `timer.Reset(time.Duration(t.interval.Load()))`（`:244`）——**间隔是原子量，
  每轮重读**，所以「缩小间隔即时生效，无需重建循环」（`:243` 注释）。
- 但**如果新订阅要求更小的间隔**，`Subscribe` 会主动重建循环（`:151-162`）：

```go
needRestart := isSubTaskStopped(t)
if int64(interval) < t.interval.Load() {
	t.interval.Store(int64(interval))
	needRestart = true
}
if needRestart {
	t.stopOnce.Do(func() { close(t.stopCh) })
	t.stopCh = make(chan struct{})
	t.stopOnce = sync.Once{}
	t.gen++
	go f.runTask(t)
}
```

注意三个细节：`stopOnce` 必须重置（否则新循环无法再停）；`stopCh` 换新（旧循环从旧通道退出）；
`gen++`（旧循环退出时不会误删新条目）。**「复用既有快照状态，不重复推送基线」**（`:149-150`）——
重建循环不会让订阅者收到重复基线。

### 5.5 panic 隔离

三个包装（`:300-324`）：

| 包装 | 行为 | 语义 |
| --- | --- | --- |
| `safeFetch` | `recover` → `(nil, errors.New("subscribe fetch panic"))` | 拉取 panic 当本轮失败，下轮重试 |
| `safeChanged` | `recover` → `_ = recover()`，返回 false | 判定 panic 当「无变化」，跳过本轮 |
| `safeHandler` | `recover` → `keep = true` | 回调 panic **不取消订阅**，继续推 |

```go
func (t *subTask) safeHandler(h *subHandler, v any) (keep bool) {
	defer func() { if recover() != nil { keep = true } }()
	return h.handler(v)
}
```

**取舍评价**：`safeHandler` panic 后保持订阅是「可用性优先」。在 Go 里合理（崩溃整个进程更糟）；
在 Python 里对应 `try/except Exception: log + continue`，但**应额外记录一次计数**，
避免坏回调无限刷日志。

### 5.6 取消语义

四条退出路径（`runTask` `:213-247`）：

| 路径 | 触发 | 行为 |
| --- | --- | --- |
| 取消函数 | `cancel()` → `cancelTask`（`:178-187`） | 置 `cancelled`；无活跃 handler 时关 `stopCh` |
| 回调返回 false | `pumpTask` `:292-294` | `h.cancelled.Store(true)`；`return len(hs) > 0` 为 false 时循环退出（`:296`） |
| 工厂 `Close()` | `:167-174` | 关全部 `stopCh`，清空任务表 |
| 客户端 `Disconnect()` | `runTask` 监听 `client.done`（`:228-230`、`:237`） | 循环退出 |

`cancelTask` 只在**没有活跃 handler** 时停循环（`:184-186`），所以「10 个订阅者取消 9 个」
不会中断第 10 个。`hasAliveHandler`（`:190-197`）线性扫描，订阅数少时可接受。

另外 `pumpTask` 每轮会**压缩 handler 切片**（`:271-279`），剔除已取消项，
避免「高频订阅-取消」把切片撑爆。

### 5.7 0x0547 的两种实现对照

| 维度 | gotdx | pythontdx |
| --- | --- | --- |
| 用途 | 一次性批量加密报价 | 增量刷新（游标） |
| 请求体 | `数量 u16` + 每只「市场 1+代码 6+u16 22234+u16 2」 | `数量 u16` + 每只「市场 1+代码 6+**u32 游标**」 |
| 单批上限 | 未声明 | 100（`REFRESH_BATCH`，`tdx_bridge.py:368`） |
| 解密 | 全报文 XOR 0x93 | 同左 |
| 记录切分 | 按 `Count` **顺序**解析，9 字节定长头 + 变长字段 | 按「市场+代码」标记 `find` 切分（`_split_refresh_records`，`:1356-1388`），**允许乱序/缺失** |
| 空响应 | 无特殊处理（`Count=0` → 空列表） | `count == 0` → 返回空，调用方用上一帧补齐（`:3861`、`:3922`） |
| 尾部字段 | 读 10B 尾 + 6×4 个变长价格丢弃（`:169-180`） | 不读尾部，靠标记切分 |
| 游标回写 | 无 | `quote["updateTime"]` 回写（`:3851`、`:3891-3892`） |

**结论**：

1. 两边请求体的 4 字节尾部长度一致（11 字节/只），说明**它就是同一个字段**；
   gotdx 硬编码 `22234/2`（小端 u32 = `0x000256DA` = 153306），pythontdx 用自增游标，
   起始 0 拿基线。哪个语义正确【未验证】——但 pythontdx 的实测可用，gotdx 只是「能跑」。
2. gotdx 的解析**假设响应有序且完整**；pythontdx 的实测注释明确写了「增量刷新只返回有变化的代码，
   条数可能少于请求数；若按 `items[:count]` 顺序解析，会把只更新了 sz000001 的帧误标成 sh600519」。
   **这是 pythontdx 优于 gotdx 的地方，绝不能反向移植。**
3. 唯一可借的是 gotdx 的**防御式写法**：`if pos+9 > len(xor) { return fmt.Errorf(...) }`
   这类逐字段边界检查。pythontdx 用 `_u16/_u32/_f32`（`tdx_bridge.py:483-499`）+ `read_varint`
   （`:440-460`）已等价覆盖，无需改。

### 5.8 把该模式用于 K 线 / 分时 / 逐笔 / 竞价

gotdx 的工厂本身与数据源完全解耦（文件头注释 `:3-6`：「K 线、分时、逐笔、指数、扩展市场等
所有查询能力都可以用同一套订阅语义接入」）。映射到 pythontdx：

| 数据源 | `Fetch` 等价物 | 建议 `Changed` | 建议间隔 | 风险 |
| --- | --- | --- | --- | --- |
| 五档报价 | `Bridge.refresh_quotes(codes)`（`0x0547` 游标） | 比较 `updateTime`/`price`/五档量 | 1 s（盘中）/ 10 s（盘后） | 已有游标，天然增量，**最适合** |
| 分时 | `Bridge.minute(code)`（`0x0537`） | `len(points)` 变多，或最后一点价变 | 3 s | 每次都全量拉 240 点，浪费；建议按「点数增量」拉 |
| 逐笔 | `Bridge.trades(code)`（`0x0fc5`） | `len(list)` 变多 | 3 s | 单页 1800 条，全量重拉代价高；应做「最后一笔时间」游标 |
| 历史逐笔 | `Bridge.history_trades()`（`0x0fc6`） | `len(list)` 变多 | 盘中不需要 | 历史数据不会变，**不建议订阅**，用一次性拉取 |
| 竞价 | `Bridge.auctions(code)`（`0x056a`） | `len(points)` 变多或最后价变 | 1 s（9:15–9:25） | `AUCTION_LIMIT=500`，需按 `count` 判断是否翻页 |
| 日 K | `Bridge.kline(code, ...)`（`0x052d`） | 只比「最后一根的日期+收盘」 | 30 s | 盘中最后一根会变，`len` 不变；**必须自定义 Changed**，否则深比较会误报/漏报 |
| 分类行情/排行榜 | `Bridge.category_quotes(...)` | 整表哈希或前 N 名代码序列 | 5 s | 全表 5000+ 只，代价高，建议只订阅「前 50」 |

**三条实现铁律**：

1. **同一 Key 只拉一次**：`Key = "quotes:" + ",".join(sorted(codes))` 这种粗粒度 Key 会造成
   「自选 3 只」和「自选 300 只」两个任务重复拉重叠代码。建议**按「数据源类型 + 单只代码」做 Key**，
   在 Hub 内做批量合并（见 5.9）。
2. **Changed 必须便宜**：`reflect.DeepEqual` 在 Go 里是深比较；Python 的 `==` 对 10 万元素的
   list 也很贵。一律自定义为「比较长度 + 最后一个元素 + 关键字段」。
3. **间隔要分层**：盘中 1 s、盘后 30 s、非交易时段停推（`9:15–15:05` 之外只保留低频心跳）。

### 5.9 与 SSE / WebSocket 的关系

pythontdx 现有的推送链：`tdx_server.py` 的 `_stream`（SSE，`:202-255`）与 `_websocket`
（`:105-186`）——**两者都是「每个连接自己 sleep(interval) 再调 `bridge.quotes(codes)`」**：

```python
# tdx_server.py:227-253
while True:
	with self.server.lock:
		quotes = self.server.bridge.quotes(codes)
	payload = {"ok": True, "result": {"quotes": quotes, "at": ...}}
	self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode())
	time.sleep(interval)
```

问题：

- **N 个前端连接 = N 倍上游请求**（都拿 `server.lock` 串行，但请求量线性增长）；
- 前端各自 `interval`，无法复用；
- 没有变化检测，价格没变也推；
- SSE 与 WS 是两套重复逻辑。

**目标架构（三层）**：

```
① 上游采集层（1 个线程/数据源）
   QuoteHub：维护「代码集合 → 游标/上帧」，按最小间隔 1s 调 0x0547，
   一次拉全部被订阅代码（≤100/批），把结果并入 cache

② 变更检测层（1 个线程）
   DiffHub：每个数据源一个 Changed 判定（等价于 gotdx 的 SubscribeSource.Changed），
   只把变化的 code 及其快照投递到「订阅者队列」

③ 前端传输层（N 个连接）
   SSE / WS 只负责「按连接过滤 + 序列化」，不再触发上游请求
```

对应关系：

| gotdx | pythontdx 目标 |
| --- | --- |
| `Subscriber`（1 个客户端 1 个） | 进程级单例 `SubscriptionHub` |
| `subTask`（Key 合并） | Hub 内 `tasks[key]`，Key 建议 `f"quote:{code}"` |
| `pumpTask` 的 diff | `DiffHub` 每轮比 `quote_cache[code]` |
| `handler` 回调 | 把 payload 塞进每个 WS/SSE 连接的 `queue.Queue` |
| `pending` 基线推送 | 新连上前端先收一份 `snapshot` 事件 |
| `safeHandler` | 发送线程 `try/except` + 丢连接 |

**SSE 与 WS 怎么选**：

- Web 前端（`npm run dev:web`）用 SSE：浏览器原生 `EventSource`、自动重连、走 HTTP 不过代理；
- 桌面 Electron 用 WS：双向（前端可随时 `subscribe` 换代码集），且已有实现；
- **两者共用同一个 DiffHub 输出**，不要各写一套轮询。

**不要做的事**：不要把 diff 放到前端（前端拿不到全量状态，也无法跨连接共享）；
不要因为「gotdx 有 Subscriber」就给 Python 引入 asyncio/anyio——stdlib 线程 + 队列足够。

---

## 6. 字段处理技巧

### 6.1 变长整数 `getprice`

`proto/proto.go:242-282`：首字节低 6 位为数据、`0x40` 为符号位、`0x80` 为续位，后续字节低 7 位
按 7 位步长拼接。

```go
data := int(bData & 0x3f)
if (bData & 0x40) > 0 { bSign = true }
if (bData & 0x80) > 0 {
	for {
		*pos += 1
		if *pos >= len(b) { return 0 }   // 截断防护：返回 0 且不再推进
		bData = b[*pos]
		data += (int(bData&0x7f) << posByte)
		posByte += 7
		if (bData & 0x80) <= 0 { break }
	}
}
```

pythontdx 的 `read_varint`（`tdx_bridge.py:440-460`）语义一致，且多了 `shift > 49` 的溢出保护——
**这一条 pythontdx 更好**，gotdx 没有溢出上限（理论上可无限续位）。

### 6.2 压缩浮点成交量 `getvolume`

`proto/proto.go:523-579`（`proto/util.go:141-199` 有一份重复实现）：

```go
logpoint := ivol >> (8 * 3)
hleax := (ivol >> (8 * 2)) & 0xff
lheax := (ivol >> 8) & 0xff
lleax := ivol & 0xff
dwEcx := logpoint*2 - 0x7f
dwEdx := logpoint*2 - 0x86
dwEsi := logpoint*2 - 0x8e
dwEax := logpoint*2 - 0x96
...
volume = dbl_xmm6 + dbl_xmm4 + dbl_xmm3 + dbl_xmm1
```

注释直白说明来源（`:522`）：「该算法由历史 C 实现平移移植，指数偏移常量沿用原实现，
不便于直接按常规浮点编码理解」。pythontdx `decode_volume`（`:463-480`）是同一算法的化简版
（`base * (64 + (hleax & 0x7F)) / 64` 等），**两者是否逐位等价【未验证】**——
建议用同一组原始 4 字节样本做一次对拍（`python/fixtures/` 放样本）。

### 6.3 价格缩放：三种单位并存

| 数据 | 除数 | 位置 | 备注 |
| --- | --- | --- | --- |
| 盘口/快照/成交分布 | 100 | `get_security_quotes.go:193-198`、`get_volume_profile.go:175-181` | 统一 `/100` |
| K 线 | **1000** | `get_security_bars.go:166-170` | 「线上整数按千分比压缩（×1000）」 |
| 逐笔/历史逐笔 | `baseUnit(code)` | `get_history_transaction_data.go:146`、`get_transaction_data.go:133` | 见下 |
| MAC 快照 | 不缩放 | `proto/mac_quotes.go` | 直接 `float32` |

`baseUnit`（`proto/proto.go:585-597`）：

```go
switch code[:2] {
case "60", "30", "68", "00", "39": return 100.0
case "51", "56", "58":             return 1000.0  // 上交所 ETF 三位小数
case "15":                          return 1000.0  // 深交所 ETF
default:                            return 100.0
}
```

pythontdx 的 `price_divisor(decimal)`（`:501-506`）+ `is_index_code`（`:509-514`）用
**代码表里的小数位**动态决定，比 gotdx 的前缀硬编码更正确（ETF/可转债/指数都能覆盖）。
**结论：缩放规则保留 pythontdx 的实现，不要换。**

### 6.4 decimal point / 小数位

- 来源：`0x044d` 证券列表每条的 `DecimalPoint int8`（`proto/get_security_list.go:42,145`）。
- 整市场缓存：`loadDecimalPointMarket`（`client_unified.go:1201-1225`）——**整市场分页拉一次**，
  存 `map[uint8]map[string]int8`，避免逐只请求。
- 换算（`:1321-1330`）：

```go
func decimalPriceFactor(decimal int8, currentDivisor float64) float64 {
	if decimal < 0 || decimal > 8 { return 1 }
	divisor := math.Pow10(int(decimal))
	if divisor == 0 { return 1 }
	return currentDivisor / divisor
}
```

即：协议值按 100 解析，若实际小数位是 3，则 `× (100/1000) = ×0.1`。
pythontdx 的 `price_divisor` 直接算除数，效果等价。

**可补的字段**：pythontdx 的 `CodeIndex`（`:3042`）已存 `decimal`，但没有把「小数位」
传给前端；建议 `quote` 里带上 `decimal` 与 `priceScale`，供图表判断价位精度（如可转债 3 位）。

### 6.5 float shares → turnover（换手率）

换手率协议不下发，gotdx 用「财务里的流通股本」在本地下算，共两套公式：

| 数据 | 公式 | 位置 |
| --- | --- | --- |
| 盘口快照 | `Round(Vol*10000/FloatShares, 2)` | `client_unified.go:1374-1380` |
| 排序列表 | 同上 | `:1386-1392` |
| K 线 | `Round(Vol*100/FloatShares, 2)` | `:1397-1404` |
| 成交分布 | `Round(Vol*10000/FloatShares, 2)` | `:1409-1414` |

两者相差 **100 倍**，说明「快照/列表的 `Vol`」与「K 线的 `Vol`」单位不同（一方按手、另一方按股）。
`FloatShares` 的来源字段注释写「流通股本（万股）」（`proto/get_company_info.go:240`），
但把它直接代进公式后量纲并不自洽（见 U13）——**所以本文件只确认「两处 Vol 差 100 倍」，
不断言哪一方是手、哪一方是股**，落库前必须用一只已知股本的股票实测校验。

**pythontdx 现状**：`_attach_finance` 已拿 `floatShares`，`Bridge` 里在
`turnoverRate`/`floatCap` 处按 `floatShares * 10000` 换算（见 `floatSharesYuan` 与
`turnoverRate` 两处），同样存在量纲假设。**建议**：新增字段前先做一次「同一只票、
同一天、通达信客户端显示的换手率」三方对拍，把结论写进 `docs/03`。

### 6.6 bitmap 字段（mac_bitmap.go）

MAC 动态字段查询的核心：**20 字节 = 160 位**，每一位声明一个字段，服务端只返回置位的字段。

置位逻辑（`mac_bitmap.go:168-175`）：

```go
if int(bit) >= len(bitmap)*8 { return }        // 越界静默忽略
bitmap[int(bit)/8] |= 1 << uint(int(bit)%8)    // bit/8 定位字节，bit%8 定位位
```

请求侧的**两个协议约定**（`proto/mac_board_members_dynamic.go:284-291`）：

```go
fieldBitmap := obj.request.FieldBitmap
// 协议固定约定：过滤条件覆盖位图第 17 字节，第 19 字节最低位置 1。
fieldBitmap[17] = obj.request.Filter
fieldBitmap[19] |= 1
```

响应侧（`:297-342`）：

```go
copy(obj.reply.FieldBitmap[:], data[:20])          // 回显位图
obj.reply.Total = binary.LittleEndian.Uint32(data[20:24])
obj.reply.Count = binary.LittleEndian.Uint16(data[24:26])
obj.reply.ActiveFields = activeMACDynamicFields(obj.reply.FieldBitmap)
rowLength := 68 + len(obj.reply.ActiveFields)*4   // 68B 身份区 + 每字段 4B
// 身份区：市场 0:2、GBK 代码 2:24、GBK 名称 24:68
```

**记录是变长的**：激活几个字段，每行就长 `68 + 4n`。这是位图协议最容易写错的地方——
pythontdx 若实现，必须**先按回显位图算 rowLength，再切记录**，不能按固定行长。

字段表 `proto/mac_board_members_dynamic.go:62-203` 共 **140 条**（位号 → 名称/格式/说明/别名），
每条 4 字节，格式只有 `uint32 / int32 / float32` 三种（`decodeMACDynamicValue` `:354-363`）。
别名机制（`:331-334`）把同一值写进多个键，避免上层按旧名取值失败。

**默认位图**（`mac_bitmap.go:281-286`）：

```go
return [20]byte{
	0xff, 0xfc, 0xe1, 0xcc, 0x3f, 0x08, 0x03, 0x01, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
}
```

按位展开只有 **32 位**置位：`0x00-0x07`、`0x0a-0x10`、`0x15-0x17`、`0x1a-0x1b`、`0x1e-0x1f`、
`0x20-0x25`、`0x2b`、`0x30`、`0x31`、`0x38`。也就是说默认**不含** `0x08/0x09`（内外盘）、
`0x11-0x14`（买一/卖一价、更新时间）、`0x18/0x19`（买一/卖一量）、`0x1c/0x1d`（行业）、
`0x26/0x27`（均价/IOPV）、`0x2a`（营收）。**默认不是全 1**（全 1 是 `MACPresetDebug`，
`:248-252`）——全开可能触发服务端截断或超长。

**pythontdx 可补**：`python/tdx_mac.py` 的 `MAC_FIELD_NAMES` 当前有 **122** 位
（`docs/15:40` 记「99 个 FieldBit」、`:86` 记目标是 126，两处口径略有滞后）。
与 gotdx 的 140 条做差集，对 A 股有实际价值的候选有：`0x2a 营业收入(万)`、`0x59 活跃度`、
`0x5c 连涨天`、`0x66/0x67 连续竞价买卖上限`、`0x6a 2 分钟金额`、`0x7b 昨成交额`、
`0x8d 封板状态`、`0x90-0x96 日内节点涨幅`。
**但要先确认服务端是否真的回这些位**（`ActiveFields` 由回显位图决定，置位不等于有值）。

### 6.7 GBK 解码

`proto/util.go:23-37`：

```go
decoder := transform.NewReader(r, simplifiedchinese.GBK.NewDecoder())
content, _ := io.ReadAll(decoder)
result := strings.ReplaceAll(string(content), string([]byte{0x00}), "")
// 定长字段按字节截断时末字节可能是半个 GBK 字符，替换符只会出现在字段尾部。
result = strings.TrimRight(result, "\uFFFD")
return strings.TrimFunc(result, func(r rune) bool { return unicode.IsControl(r) })
```

三步清洗：去 NUL 填充 → 去尾部替换符（半个汉字）→ 去控制字符。
pythontdx 用 `decode("gb18030", "replace")` + `normalize_name`（`:517-527`），
但**没有处理「尾部半个汉字」**——定长 16 字节名称被截断时会出现 `\ufffd`，
建议加 `text.rstrip("\ufffd")`。这是可直接落地的小修。

### 6.8 日期编码

| 场景 | 编码 | 位置 |
| --- | --- | --- |
| 分钟 K 线 | 低 16 位 `zipday`（`year=(zip>>11)+2004`、`month=(zip&0x7FF)/100`），高 16 位为当日累计分钟 | `proto/proto.go:334-343` |
| 日线及以上 | `YYYYMMDD` 整数 | `:345-349` |
| 秒级周期（category=13） | 自 `2004-01-01` 起的秒数 | `:316-319` `DecodeSecond` |
| 逐笔时间 | 2 字节「当日累计分钟」 | `:288-298` `gettime` |
| 历史分时请求日期 | **取负**的 `YYYYMMDD`（int32） | `get_history_minute_time_data.go:70` |
| 竞价时间 | 2 字节时+分（`hour*60+minute`）+ 第 15 字节秒 | `get_auction.go:122,129,143` |
| 异动时间 | 第 29 字节小时 + u16（分*100+秒） | `get_unusual.go:121-128` |

**负数日期**要特别注意：`if req.Date > 0 { req.Date = -req.Date }`（`get_history_minute_time_data.go:70`）
——服务端用负值表示「历史某日」，正值会被当成「最近交易日」。pythontdx 的 `0x0feb` 用
`0xFED62304 - date.toordinal()`（`:955`）是另一种选择子编码，两者不同【未验证谁对】；
pythontdx 已在生产使用，**以实测为准，不要换成 gotdx 的写法**。

### 6.9 复权参数

`proto/get_security_bars.go:30`：`Adjust uint16`，`types.AdjustNone=0 / AdjustQFQ=1 / AdjustHFQ=2`
（`types/constants.go:274-276`）。`NewGetSecurityBars` 不改 `Adjust`，只把 `Count+1`。
偏移协议 `0x052d` 同样带 `Adjust`，但价格是**增量**（`get_security_bars.go:149-154`）：

```go
if isOffsetReq {
	openRaw = preCloseRaw + openRaw
	closeRaw = getprice(data, &pos) + openRaw
	highRaw  = getprice(data, &pos) + openRaw
	lowRaw   = getprice(data, &pos) + openRaw
}
```

pythontdx 的 `0x052d` 已实现 `fixed_qfq/hfq + anchor`（`docs/15`），更完整；
gotdx 的 `adjust` 语义只有「0/1/2」三值，没有本地复权因子（`adjust_factors.py` 在 pythontdx 侧）。
**结论：不复权参数保持 pythontdx 现状。**

### 6.10 分笔方向判定

| 协议 | 方向字段 | 取值 | 位置 |
| --- | --- | --- | --- |
| `0x0fc5` 当日逐笔 | 变长整数 | 0 买 / 1 卖 / 2 中性 | `get_transaction_data.go:129-130,150-160` |
| `0x0fc6` 历史逐笔（带方向） | **独立 2 字节 u16** | 同上 | `get_history_transaction_data_trans.go:112-138` |
| `0x0fb5` 历史逐笔 | 变长整数 | 同上 | `get_history_transaction_data.go:138-140` |
| `0x056a` 竞价 | **未匹配量的符号** | 负=卖、正=买 | `get_auction.go:131-141` |

```go
// 负值归为卖侧并取绝对值；正值归为买侧。
if unmatchedRaw < 0 { flag = -1; unmatched = uint32(-unmatchedRaw) } else { flag = 1; ... }
```

pythontdx 的 `_trade_side`（`:1511-1514`）已有映射；竞价的 `Flag` 语义（未匹配量符号定方向）
若尚未落地，**这是可补字段**。

### 6.11 其他值得记的技巧

| 技巧 | 位置 | 说明 |
| --- | --- | --- |
| `formatServerTime` 处理「分钟位非法」 | `proto/proto.go:386-410` | 服务端时间整数里分位 >59 说明已进位，需整段换算 |
| 档位价格为累计差值 | `get_index_info.go:178-189`、`get_history_orders.go:102-117`、`get_volume_profile.go:158-172` | `lastPrice += priceRaw` |
| 负价差 32 位补码归一 | `get_volume_profile.go:197-203` | 见 3.8(3) |
| 指数 K 线尾部 4 字节探测 | `get_security_bars.go:185-193` | 「若无法按日期解码，则视为上涨/下跌家数」——启发式，脆弱但实用 |
| 1 分钟 09:30 首根补齐 | `client_unified.go:206-254` | 服务器从 09:31 开始给，用首笔逐笔重建 09:30 |
| 逐笔页大小 | `types` 无；pythontdx `TRADE_PAGE=1800` | gotdx 未限制，靠 `count` u16 |
| 金额 f32 直读 | 多处 | 成交额一律 `float32`，不是变长整数 |

### 6.12 pythontdx 可补齐的字段清单

| 字段 | 来源 | 现状 | 建议 |
| --- | --- | --- | --- |
| 换手率 `turnover` | 财务流通股本 + 量 | 仅 MAC/部分 | 补进 `0x0547`/`0x053e` 快照 |
| 主动买/卖量（内盘/外盘） | `0x053e` 的 `BVol/SVol`、`0x0547` 的 `inside/outside` | 已有 `innerVolume/outerVolume` | 已在，保持 |
| 竞价未匹配方向 | `0x056a` 第 10–14 字节符号 | 未确认 | 补 `unmatchedFlag` |
| 价格小数位 | `0x044d` `DecimalPoint` | `CodeIndex` 有但未出口 | `quote.decimal` + `priceScale` |
| 涨速/短换手/开盘抢筹/2 分钟额/量涨速/委比 | `0x054b` 尾部 6 个特殊字段 | 未解析 | 补进 `parse_category_quotes` |
| 封板状态/连涨天/年涨停天数 | MAC 位图 `0x8d/0x5c/0x58` | 未覆盖 | MAC 位图补齐后可用 |
| 日内节点涨幅（10:00/10:30/…/14:30） | MAC 位图 `0x90-0x96` | 未覆盖 | 可用于「分时强度」图 |
| 档位分布 | `0x051a`/`0x051d` | 未实现 | 见 9.1/9.2 |
| 上涨/下跌家数（指数级） | `0x051d` 或 `0x0523` 尾部 | 靠全表翻页 | 先探测 |

---

## 7. 测试与文档方法

### 7.1 `protocol_test.go` 的手法

**核心思路：不存「真实抓包 hex」，而是在测试里用编码器现场构造字节流。** 好处是
「构造 → 解析 → 断言」闭环，字节布局变化立刻暴露；坏处是「构造器和解析器可能一起错」。

三个基础设施（`proto/protocol_test.go`）：

| 设施 | 位置 | 作用 |
| --- | --- | --- |
| `encodePrice(value int) []byte` | `:45-73` | 按变长规则编码整数价格（含负数 `0x40` 符号位） |
| `encodeVolumeProfilePriceDelta(value int32) []byte` | `:76-98` | 编码**无符号**变长价差（负数按位模式转 u32） |
| `readReqHeader` | `:117-125` | 只解析前 12 字节请求头做断言 |

典型用例（`TestGetSecurityBarsBuildRequestAndParseResponse` `:415-490`）：

```go
raw := mustBuildRequest(t, msg)
header := readReqHeader(t, raw)
if header.Method != KMSG_SECURITYBARS { t.Fatalf("unexpected method: %#x", header.Method) }
// 1) 断言请求侧：Count 被 +1
if req.Times != 2 || req.Adjust != 1 || req.Start != 3 || req.Count != 5 { ... }
// 2) 现场构造响应：2 条 K 线 + 指数家数
writeBar(20240530, 12000, 12100, 12200, 11900, 2000.5, 5000.25)
writeBar(20240531, 12345, 12355, 12400, 12200, 3456.5, 7890.25)
binary.Write(buf, binary.LittleEndian, uint16(7))   // UpCount
binary.Write(buf, binary.LittleEndian, uint16(9))   // DownCount
// 3) 断言解析侧：首根被丢弃、价格 /1000、家数正确
if reply.Count != 1 { ... }
if math.Abs(bar.Open-12.345) > 0.0001 { ... }
```

**值得抄的三个习惯**：

1. **断言「请求侧副作用」**：`Count+1`、`Times` 默认 1、`Mode` 默认 5 这些构造函数里的魔法，
   都有对应断言（`:436`、`:170-178`）。
2. **专门写畸形报文用例**：`TestGetHistoryMinuteTimeDataParseResponseShortData/TruncatedData/TruncatedVarint`
   （`:345-414`）——验证「截断时不 panic、返回错误」。
3. **写「语义冲突」用例**：`TestGetVolumeProfileParseWrappedNegativeProfilePriceDelta`（`:1218`）
   专门构造 32 位补码价差。

**gotdx 的测试缺口**（也是 pythontdx 要注意的）：

- 没有用**真实抓包**做 golden 文件——一旦构造器与解析器同错，测试全绿；
- 少数**解析器**直接对索引取值（`data[:1]`、`data[:2]`），短报文会 panic（如 `get_top_board.go:114`、
  `get_unusual.go:99`、`get_auction.go:109`）——安全文档里的「解析越界 panic」即指此类，
  修复状态见 `docs/security_performance_report.md:149-166`。

### 7.2 客户端与订阅测试

| 测试 | 位置 | 手法 |
| --- | --- | --- |
| `TestPoolBuildsExpectedConns` | `client_pool_test.go:11` | 起本地假 TCP server 验证池容量 |
| `TestPoolRoundRobin` | `:41` | 断言轮询顺序 |
| `TestPoolDiscardAndRefill` | `:111` | 断连后自动补建 |
| `TestRebalanceSwitchesToFastest` | `:221` | 假 server 注入不同延迟，验证切换 |
| `TestHeartbeatDiscardsStaleConn` | `:325` | 假 server 不回包，验证 2s 判死 |
| `TestSingleConnectionModeConfig` | `:413` | 选项组合断言 |
| 订阅工厂 12 个用例 | `client_subscribe_factory_test.go:13-568` | 每次变化都推、未变不推、自定义 Changed、同 Key 合并、类型冲突、panic 隔离、Close 全停、**追加订阅拿基线**、回调 false 取消、Disconnect 停止、取消后切片压缩 |

订阅测试里最值得借的是 `TestSubscriberJoiningHandlerGetsBaseline`（`:359`）和
`TestSubscriberCancelledHandlersCompacted`（`:500`）——前者证明「基线推送」，后者证明
「高频订阅/取消不泄漏」。pythontdx 若实现 Hub，这两个必须是第一批测试。

### 7.3 `cmd/webviewer` 的设计

- **单二进制 + 内嵌前端**：`//go:embed index.html`（`main.go:18`），不依赖静态目录。
- **三段路由**：`/`（页面）、`/api/methods`（方法元信息）、`/api/query`（执行）。
- **方法注册表驱动**：`query.go`（6 281 行）维护 `methodDefs`（分组/参数/说明），
  前端据此**动态生成表单**，无需为每个方法写页面。
- **统一返回**：`queryResponse` 表格化，前端只渲染 `columns + rows`。
- **中间件**：`withLogging`（`main.go:100`）+ `withCORS`（`:111`，含 OPTIONS 204）。

**与 pythontdx `tdx_server.py` 对照**：

| 维度 | gotdx webviewer | pythontdx `tdx_server.py` |
| --- | --- | --- |
| 形态 | `go run` 调试器 | sidecar 生产 HTTP 服务 |
| 方法注册 | `methodDefs` 元数据表 | 手写 `if path == ...` 路由 |
| 前端 | 内嵌单页 | 独立 Vite 前端 + SSE/WS |
| 鉴权 | 无（仅 127.0.0.1） | 无（仅本机） |
| 价值 | **「参数元数据 → 自动表单」值得借**，可减少调试页维护 | 已是生产形态 |

**建议（低优先级）**：给 `tdx_server.py` 加一个 `/api/methods` 返回「命令 → 参数 schema」，
前端调试面板据此生成表单；不影响现有路由。

### 7.4 benchmark / security 文档结论

**`docs/benchmark_vs_gotdx_online.md`**：

- 结论（`:12-26`）：3 轮实测（每函数 n=30）中，新库 19 个数据函数里 16 个 avg 持平或更快；
  「**函数耗时差距几乎全部来自连接模型与节点选择，协议实现本身两库等价**」（`:155`）；
  47/48 个共享协议的**请求字节流完全一致**（`:26` 附近）。
- 归因（`:157-175`）：老库固定单节点被 RTT 绑架；新库随机 3 候选 + 定向持久化。
- 代价：新库有「抽中慢节点（最慢 173 ms）或撞空数据节点」的尾部风险（`:191` 附近）。

**对 pythontdx 的意义**：pythontdx 当前就是「老库模型」（单连接 + 首选地址 + 串行重连），
所以 gotdx 的池化收益对它成立；但也别期待「换了池就快 10 倍」——差距是 RTT 数量级，
不是解析数量级。

**`docs/security_performance_report.md`**：

- `govulncheck` 无漏洞、`go vet` 0 告警（`:10-21`）。
- 4 项缺陷并已修：① 协议解析越界 panic；② `quotationClient` 无锁读池（数据竞争）；
  ③ zlib 解压无上限；④ TCP 部分写重试未偏移（`:24-33`、`:145-180`）。
- 性能结论：网络 RTT 主导（avg 48–62 ms），**代码路径开销占比 ≈0.0003%**（`:19`）——
  锁/反射/分配都不是瓶颈。

**对 pythontdx 的三条直接启示**：

1. 解析必须「长度先校验、再切片」，Python 会直接 `struct.error`/`IndexError`，虽不崩进程，
   但会让整条请求失败；pythontdx 的 `_u16/_u32/_f32` 已做，**新增解析器必须复用**。
2. 解压要有上限（当前没有）。
3. 不要在解析层做微优化，收益是 0.0003% 量级；要优化就优化节点选择与并发。

### 7.5 给 pythontdx 的测试建议

| 建议 | 理由 | 落点 |
| --- | --- | --- |
| 为每个新协议补「构造→解析→断言」单测 | 与 gotdx 同法，成本低 | `python/tests/test_tdx.py` |
| 补「截断/畸形报文」用例（每种新协议 2 条） | gotdx 的越界 panic 就是缺这个 | 同上 |
| 引入 `python/fixtures/` 真实抓包 golden | gotdx 缺，别一起缺 | `python/fixtures/*.bin` + sha256 |
| 订阅 Hub 的 12 条语义测试照抄 gotdx 用例清单 | 语义完备 | 新 `test_subscription.py` |
| 池/心跳/重平衡用「本地假 server」测 | gotdx 同法，可注入延迟/不回包 | 同上 |

---

## 8. 地址池

### 8.1 gotdx 的六组列表

| 列表 | 条数 | 端口 | 函数 | 用途 |
| --- | --- | --- | --- | --- |
| `mainHostList` | **51** | 7709 | `MainHosts` `hosts.go:189` | 通达信云主站（深圳/上海/广州/北京/杭州/武汉/腾讯云） |
| `brokerHostList` | **23** | 7709（2 条 80） | `BrokerHosts` `:195` | 券商/上证云节点（含 `180.153.18.172:80`、`202.108.253.139:80`） |
| `exHostList` | **16** | 7727 | `ExHosts` `:201` | 扩展行情（边界外） |
| `macHostList` | **3** | 7709 | `MACHosts` `:207` | MAC 主站 |
| `macExHostList` | **18** | 7727 | `MACExHosts` `:213` | MAC 扩展（边界外） |
| `icfqsHostList` | **12** | 7615 | `ICFQSHosts` `:219` | ICFQS 资讯 |

**去重情况**：`hosts.go` **没有任何去重代码**（全文件无 `seen`/`map` 去重逻辑）。
跨列表有重叠：`112.74.214.43:7727`、`120.25.218.6:7727`、`43.139.173.246:7727`、
`159.75.90.107:7727`、`106.52.170.195:7727`、`175.24.47.69:7727`、`139.9.191.175:7727`、
`150.158.9.199:7727`、`150.158.20.127:7727`、`49.235.119.116:7727`、`49.234.13.160:7727`、
`116.205.143.214:7727`、`124.71.223.19:7727`、`123.60.173.210:7727`、`113.45.175.47:7727`、
`118.89.69.202:7727` 同时出现在 `exHostList` 与 `macExHostList`——即
**`exHostList` 的 16 条全部被 `macExHostList` 的 18 条包含**（后者多 2 条专属节点）。
列表内的重复：`brokerHostList` 里「广发」3 条、「国泰君安」8 条、「华林」4 条，IP 各不相同，
所以**不是重复项，是同一券商的多节点**。

### 8.2 测速与排序

- `ProbeHosts` / `ProbeAddresses`（`:265-288`）：纯 TCP 拨号，拿到连接立即关闭。
- 并发窗口 `probeConcurrencyWindow = 32`（`:340`），避免 130+ 候选同时超时占满网络栈。
- 排序（`:393-404`）：可达优先 → 延迟升序 → 名称 → 地址。
- `FastestHost` / `FastestAddress`（`:294-304`）：取第一个可达，全灭返回 `ErrNoReachableHosts`。
- **超时**：`probeAddressesWithDial` 默认 2 s（`:355`）；池内慢路径兜底用 300 ms（`:345`）。

**注意**：`ProbeHosts` 只测 TCP 可达，**不验证握手**；而 `probeReachable`（`client.go:1659`）
是「拨号 + 握手」两阶段，建池用的后者。pythontdx 的 `speed_test_hosts`（`tdx_bridge.py:285`）
只调 `socket.create_connection`，属于前者；一旦某节点 TCP 通但握手失败，pythontdx 会误判可用。

### 8.3 与 pythontdx 的差集

| 项 | pythontdx | gotdx | 结论 |
| --- | --- | --- | --- |
| 主站来源 | `connect.cfg [HQHOST]` **48** 条（7709） | `mainHostList` **51** 条 | connect.cfg 的 48 条是 gotdx 51 条的**子集** |
| 差集 | — | `110.41.174.169`、`121.37.183.82`、`60.12.136.250` | 3 条可补 |
| 内置回退 | `SERVER_HOSTS` **27** 条（`tdx_bridge.py:144-173`） | — | 与 connect.cfg 有较大差异（含 58.34.106.207 等资金流节点） |
| 资金流专用 | `MONEY_FLOW_HOSTS` **8** 条（`:318-327`） | `brokerHostList` **23** 条 | 8 条里有 **4 条**（180.153.18.170 / 60.191.117.167 / 115.238.56.198 / 218.75.126.9）来自券商列表；其余 4 条是 pythontdx 自采 |
| 7727 | 不接 | 16 + 18 条 | **不做** |
| 7615 | 自研 F10（19 页签） | ICFQS HTTP 12 条 | 不走 ICFQS |

### 8.4 是否应扩充 connect.cfg 地址池

**结论：主站池建议补 2~3 条（只补内置回退列表，不覆盖 connect.cfg），资金流节点池建议 8 → 约 27 条。**

理由：

1. connect.cfg 是**通达信客户端自己的配置**，pythontdx 只读不写（`parse_connect_cfg` `:210`）。
   直接改它等于篡改用户客户端配置，且下次升级会被覆盖。
2. 正确落点是 `tdx_bridge.py` 的 `SERVER_HOSTS`（内置回退列表）：
   - 相对 connect.cfg 缺 3 条：`110.41.174.169`、`121.37.183.82`、`60.12.136.250`；
   - 相对 `SERVER_HOSTS` 只缺 2 条（`60.12.136.250` 已在 `tdx_bridge.py:161`）；
   - 建议在 `active_endpoints()` 里做「connect.cfg 优先 + 内置列表去重合并」，
     这样即使用户没有 connect.cfg 也能拿到更大池。
3. **不要补 7727**：项目边界外（`AGENTS.md` 硬规则 8）。
4. **资金流节点**：把 `MONEY_FLOW_HOSTS` 与 gotdx `brokerHostList` 求并集（8 → 约 27 条），
   去重后按「实测能返回完整 0x0ffc 分档」筛选。这是**收益最直接**的一条——
   资金流失败率会显著下降。

**另外一条**：pythontdx 的测速只测 TCP，建议改成 gotdx 的「拨号 + 握手」两阶段
（`client.go:1659-1743`），否则会出现「测速第一但握手失败」的节点。

---

## 9. 结论与增强清单

### 9.1 立刻可落地

| # | 增强 | 理由 | 风险 | 落点 |
| --- | --- | --- | --- | --- |
| **L1** | 引入「订阅 Hub」：轮询 + diff + 基线 + 同 Key 合并 + panic 隔离 | 现在 N 个 SSE/WS 连接 = N 倍上游请求；gotdx 已验证这套语义（12 个测试） | 需重构 `tdx_server.py` 推送链；并发 bug 风险 | 新增 `python/subscription_hub.py`；`tdx_server.py:_stream` / `_websocket` 改为从 Hub 取 |
| **L2** | 接 `0x0563` 主力监控（异动） | 7709 原生，可去 MAC 依赖；19 个 case 的事件文案已完整（`get_unusual.go:161-250`） | 600 条响应约 19 KB，接近帧上限；分页行为未验证 | `tdx_bridge.py` 加 `CMD_UNUSUAL=0x0563` + `parse_unusual()`；`Bridge.unusual()` |
| **L3** | 接 `0x053f` 排行榜（9 榜一次拿） | 把「9 次 0x054b 翻页」变成 1 次请求；A 股 UI 刚需 | `Category` 取值域未知【未验证】 | `CMD_TOP_BOARD=0x053f` + `parse_top_board()`；HTTP `/api/top_board` |
| **L4** | 帧长 + 解压放大上限 | 对标 `client.go:1302-1338`；畸形帧可放大内存 | 需确认现有报文最大长度，避免误杀 | `TdxConnection._read_frame` |
| **L5** | 补 `\ufffd` 清洗；换手率字段先按 U13 校验量纲再上 | GBK 定长截断会产生半个汉字（`proto/util.go:33`）；换手率量纲目前两家都靠假设 | 极低（清洗）/ 中（量纲） | `normalize_name` + `Bridge._attach_finance` |

### 9.2 中期

| # | 增强 | 理由 | 风险 | 落点 |
| --- | --- | --- | --- | --- |
| **M1** | 连接池 3 条 + 空数据换节点 + 节点健康度 | 对标 `client.go:90-115`、`client_helpers.go:32-302`；解决「某节点历史数据不全」 | 单连接语义被打破，`CodeIndex`/游标需按连接隔离 | `TdxConnection` → `ConnectionPool`；`Bridge._refresh_quotes_7709` |
| **M2** | 建连快路径 + 自适应 500ms 拨号超时 | 对标 `client.go:1399-1474`；首屏建连从「5s×N」降到「≤500ms」 | 弱网下可能全灭转慢路径 | `TdxConnection._connect` |
| **M3** | 应用层心跳 30s/60s + 2s 判死 | 对标 `client.go:715-826`；当前只在请求前顺带心跳（`TdxConnection.request` 里的 `HEARTBEAT_INTERVAL` 分支），空闲连接可能被 NAT 静默回收 | 多线程操作同一 socket 需锁 | 新增 `HeartbeatWorker`；`TdxConnection` 加锁 |
| **M4** | 重平衡（双阈值 0.7/0.9 + 1min/15s） | 对标 `client.go:937-1170`；跟随网络变化 | 建连风暴风险（gotdx 用阈值压住了） | 同 M1 |
| **M5** | `0x051a` 成交分布（筹码分布） | A 股核心分析功能，附带 3 档盘口 + 内外盘 | 档数未知，可能超帧；负价差需 32 位归一 | `CMD_VOLUME_PROFILE=0x051a` + `parse_volume_profile()`；`lake/volume_profile` |
| **M6** | MAC 字段位图补齐 + 变长行长解析 | gotdx 140 条字段表 vs pythontdx 122，差集含营收/封板/连涨/日内节点涨幅 | 位图置位≠有值，需以回显位图为准 | `python/tdx_mac.py` + `proto/mac_board_members_dynamic.go` 的 rowLength 逻辑 |
| **M7** | 测速改「拨号 + 握手」两阶段 | 对标 `client.go:1659-1743`；避免「TCP 通但握手失败」误判 | 慢一倍 | `speed_test_hosts` |
| **M8** | 资金流节点池扩容（8 → 约 27） | gotdx `brokerHostList` 是资金流节点的来源之一 | 部分节点分档不全，需实测筛选 | `MONEY_FLOW_HOSTS` |
| **M9** | `0x0452` 请求改 u32 start/count | 一次拿 2000 条，省掉多轮 | 请求布局变化需实测 | `special_limits_data` + `Bridge.special_limits` |

### 9.3 不适用 / 边界外

| 项 | 原因 |
| --- | --- |
| 全部 EX 7727 命令（`0x23xx/0x24xx`，含 `0x2422/0x2423` 表格、`0x248x` 报价、`0x23ff` K 线） | 服务港股/美股/期货/期权；`AGENTS.md` 硬规则 8 明确不做 |
| `0x2454/0x2455` 扩展市场登录/服务信息 | 同上 |
| 港股/美股/期货/商品语义（`client_goods.go`、`futures_calendar.go`） | 项目边界外；但「交易日历表修正时间归属」思路可留作日后 A 股夜盘/盘后固定价参考 |
| `0x264b/0x26ac/0x26ad/0x26ae/0x26b1` 客户端上报 | 未解析、含硬编码内网 IP/MAC/令牌，收益 0 风险非 0 |
| `0x000b` TODOB / `0x0fde` | 固定密文、语义未知，仅抓包调试用 |
| `0x0fdb` 第二次握手 | pythontdx 实测「三连包会进旧会话」，明确不发 |
| ICFQS 7615 HTTP（`icfqs.go` 全文件） | 数据源边界外（运行时只允许通达信 7709/MAC/7615；pythontdx 已自研 7615 F10，不走 ICFQS） |
| `cache/`（Redis 缓存层） | pythontdx 用 SQLite/Parquet/DuckDB，不引入 Redis 依赖 |
| 登录/交易/委托类能力 | gotdx 本身也没有（它只是行情 SDK）；项目边界外 |
| gotdx 的 `0x0547` 解析实现 | 假设响应有序完整；pythontdx 的标记切分更稳健（见 5.7） |
| gotdx 的 `0x0fb4` 命名（历史委托） | 与 pythontdx 的「历史分时」冲突，结构更像分时；不采纳（见 3.8(6)） |
| gotdx 的 `baseUnit` 前缀硬编码 | pythontdx 用 `DecimalPoint` 动态算，更正确（见 6.3） |
| `0x051d`/`0x051c` | **暂列不适用（待验证）**：仅当探针证明 `UpCount/DownCount` 对沪深指数有效时才升级为可落地 |

### 9.4 与项目边界的确认

- **只做 A 股**：本文件所有「可落地」项都只涉及沪深京 A 股（含指数/ETF/可转债）；
  港股/美股/期货/期权一律不做。
- **只接通达信**：不引入 ICFQS、不引入第三方行情源；新增命令全部是 7709 主站或 MAC 原生。
- **7727 不做**：`exHostList` / `macExHostList` 只作为「gotdx 有但我们不做」的资料记录。
- **登录/交易不做**：gotdx 无此能力，pythontdx 也不做。
- **数据可追溯**：L2/L3/M5 新增的原始报文都要落 `python/fixtures/` 或 `lake/`，
  并写 manifest（`docs/15` 的 7 条落盘约定）。

---

## 10. 未验证清单与待登记来源

| # | 事项 | 当前判断 | 验证方法 |
| --- | --- | --- | --- |
| U1 | `0x0563` 的 `Start` 分页是否生效；`Count=600` 是否触顶 | 未知 | 探针：`start=0/600/1200` 各发一次，比对 `Index` 是否连续 |
| U2 | `0x053f` 的 `Category` 合法取值域 | 未知 | 用 `0x054b` 的 category 值（0/6/…）逐个试，看 `Size` 与条目是否合理 |
| U3 | `0x051a` 单只返回的档数与总长度 | 未知 | 探针打印 `Count` 与 `len(data)`，确认 < 32768 |
| U4 | `0x051d` 对 `sh000001/sz399001` 是否给非零 `UpCount/DownCount` | 未知 | 与 `market_breadth` 结果比对 |
| U5 | `0x0547` 第 9–12 字节是「游标」还是「常量 22234/2」 | 两者不同实现都能跑 | 对同一只代码用递增游标连发 3 次，看是否只回增量 |
| U6 | `0x0fb4` 是「历史分时」还是「历史委托」 | 倾向历史分时 | 把 `Unknown` 列与分时均价比对 |
| U7 | `0x0452` 请求改 u32 start/count 是否被接受 | 未知 | 双写探测（u16 版 + u32 版）比对记录 |
| U8 | `getvolume` 与 pythontdx `decode_volume` 是否逐位等价 | 未对拍 | 用同一组 4 字节样本跑两边函数 |
| U9 | 主站列表 3 条差集地址（110.41.174.169 / 121.37.183.82 / 60.12.136.250）当前是否可达 | 未知 | `ProbeHosts` 等价探针 |
| U10 | 资金流节点并集里哪些返回完整 `0x0ffc` | 未知 | 对每个节点拉同一只代码，检查日期/金额非零 |
| U11 | `0x0ffc` 之外是否还有资金流分档协议（gotdx 无，pythontdx 自研） | 未知 | 抓包比对 |
| U12 | gotdx `0x053e` 的 `Rate`（涨速/100）语义 | 源码标「语义待确认」 | 与 `0x054b` 的 `RiseSpeed` 比对 |
| U13 | 换手率量纲：`FloatShares` 是万股还是股？快照 `Vol` 是手还是股？ | 两套公式差 100 倍，注释与公式不自洽 | 取一只已知股本的票，用「通达信客户端换手率 / 自算值」对拍；同时校验 K 线与快照同分钟的量比值 |
| U14 | `0x051a` 的 `Count` 与 `MessageMaxBytes` 的关系（是否会被服务端截断） | 未知 | 同 U3 |

**待登记到 `docs/08-通达信资料索引.md`**（本次不改该文件，由后续任务补录）：

1. gotdx 仓库：`https://github.com/bensema/gotdx`（本地 `D:\GitHub\gotdx`），
   模块 `github.com/bensema/gotdx`，`go 1.27.0`。
2. 命令常量表：`proto/proto.go:27-111`。
3. MAC 140 条字段位映射：`proto/mac_board_members_dynamic.go:62-203`。
4. 六组地址池：`hosts.go:46-185`。
5. 安全/性能结论：`docs/security_performance_report.md:10-33`、`docs/benchmark_vs_gotdx_online.md:12-26`。

---

### 附：本文件与既有文档的关系

| 文档 | 关系 |
| --- | --- |
| `docs/03-通达信行情手册.md` | 本文件的字段结论可回写；特别是 6.5 的换手率量纲（U13）与 6.6 的位图字段表 |
| `docs/08-通达信资料索引.md` | 第 10 节的 5 条来源待登记 |
| `docs/14-eltdx数据能力调研.md` | 同为「外部项目调研」，本文件补上 Go 生态视角与推送机制 |
| `docs/15-协议实现矩阵.md` | 本文件第 3 节可视为其「候选批次」；建议后续把 L2/L3/M5 合入矩阵状态表 |
| `PLAN.md` | 第 9.1/9.2 的清单可作为候选任务来源 |
