# 14 · eltdx 数据能力调研（2026-11-04）

> **2026-11-04 追加更正**：本文是最初的快速调研，部分结论已被源码级审计推翻，
> 以 [docs/17](17-eltdx协议差距与补齐清单.md) 为准。主要偏差：
> 「7709 26 vs 19 条」——实际本项目 26/26 全覆盖；「0x0010 只取 4 字段」——实际
> 26/31 个 float（2026-11-04 已补齐 31 个）；「MAC 30 位」——实际 122 位
> （gotdx 140 条字段表 / 160 位）；「7615 19 页签」——实际更多，缺的是 12 类
> Entry 与 62 个资讯频道；0x053e/0x0547/0x054c/0x0ffc 的「落盘」表述不实
> （0x0ffc 于 2026-11-04 才补）。

> 调研对象：本机 `D:\GitHub\eltdx`，工作区版本 **3.3.2**。
> 只读研究，没有复制源码/夹具，也没有把它作为依赖引入。

## 结论

`eltdx` 是 **Python API + Rust 原生 7709 引擎 + 7615 F10 + MAC/EX + 本地文件读写** 的
全功能客户端。它比我们强在：

- 7709 命令覆盖更全（26 条 vs 我们 19 条）；
- K 线/财务/MAC 字段更完整（K 线有 amount、指数涨跌家数，MAC 126 个 FieldBit）；
- 定点复权、退市日线、特殊涨跌停、GBBQ/财务原始文件；
- Rust 连接池、deadline、主机 generation 等运行时能力。

我们比它强在：

- Parquet/JSONL 数据湖、PIT 财务、归档、manifest/SHA、DuckDB 查询；
- 与 Electron 界面、自选/预警/复盘/回测/数据工具的整合；
- stdlib-only + Nuitka 单文件 sidecar，用户不需要安装 Python/Rust。

**不能直接搬**：eltdx 使用自定义“非商业学习与数据研究”许可，与我们的
GPL-3.0-or-later 不兼容；不能复制源码、夹具、文档，也不能把 wheel 放进发行物。
只可阅读文档/协议结论，在自己的 Python 代码里独立重实现。

## 对比摘要

| 能力 | pythontdx | eltdx 3.3.2 | 判断 |
|---|---|---|---|
| 7709 行情/K线/分时/逐笔/竞价 | 19 命令，够用 | 26 命令、字段更全 | eltdx 更强 |
| K 线 amount | 本次补齐 | 有 | 已追平 |
| 指数涨跌家数 | 本次补齐 | 有 | 已追平 |
| 定点复权 `fixed_qfq/hfq + anchor` | 无 | 有 | 可补 |
| 退市日线 `0x052b` | 无 | 有 | 可补 |
| 特殊品种涨跌停 `0x0452` | 用本地规则 | 有 | 可补 |
| 0x000f GBBQ / 本地复权系数 | 部分 F10 | 有完整 tag 1..15 | 可补 |
| 0x0010 财务 136B | 只取 4 字段 | 30+ 字段 | 可补 |
| MAC 字段 | 30 位 | 126 FieldBit/122 位 | 分阶段补 |
| 7615 F10 | 19 页签 | 30+ 分区 | 可补 |
| 本地 `.day/.lc1/.lc5` | 支持，基金系数缺 | 更宽容 + GBBQ/财务 | 互补 |
| 数据湖/PIT/归档 | Parquet/JSONL/SHA/DuckDB | 无 | 我们更强 |
| 运行时 | 单连接 + 锁 | Rust pool/deadline/generation | 仅参考 |

## 可落地增强（按优先级）

### P0：字段与历史完整性

1. **K 线 amount + 指数涨跌家数**（本次已完成）
   - `tdx_bridge.py:parse_bars` 不再丢弃 0x052d 的 amount，并读取指数
     `up_count/down_count`；
   - `parquet_store.py` schema 增加 `amount/upCount/downCount`，旧 Parquet 缺列
     读取为 `null`；
   - `kline_export`、CSV、K 线浮层同步输出。
2. **0x0010 财务 136B 全字段**
   - 参考 `crates/eltdx-protocol/src/commands/corporate.rs:parse_finance_record`；
   - 当前只取 offset 0/16/40/128，缺总资产、营收、净利、现金流、股东数等；
   - 接 `parse_finance`，用 `finance2.hex` 断言。
3. **0x052d 定点复权**
   - `fixed_qfq/fixed_hfq + anchor_date`；
   - 缓存 key 必须包含 anchor，避免和普通 qfq 混用。
4. **0x052b 退市日线**
   - 新增 bridge 命令与 `/api/delisted_bars`，写 `lake/delisted`；
   - 测 `T000038` 前缀归一、空页停止、归档 SHA。

### P1：数据能力补强

5. **0x0452 特殊涨跌停表** + 7615 `limit_up_down_list`
   - 接 `limit_review`/条件选股，补 ST/新股/特殊品种；本地规则只作兜底。
6. **本地文件兼容**
   - `.day/.lc1/.lc5` 残尾容忍（33B 尾）、基金/债券/指数系数、GBBQ/历史财务；
   - 参考 `offline/daily_bar.py`、`offline/gbbq.py`，但独立实现。
7. **0x000f 股本变迁/复权系数**
   - 作为独立 `corporate_archive.py`，用于本地 qfq/hfq 审计；
   - 服务器复权价与本地仿射系数允许 0.01–0.02 元差异。
8. **MAC 字段扩展**
   - 优先 0x20/21 涨跌停、0x38 主力净额、0x69 短换手、0x73–76 DDX；
   - 用 126 FieldBit 表对照，不照搬代码。
9. **资金流历史 3/5/10/20/60 日**
   - 接 `money_flow.history` 到现有 `flow_archive`；保留天数、降序、N001..N009。

### P2：协议/运行时参考

- Rust runtime 的 pool/deadline/generation 思路可参考，但不要引入 native wheel；
- `bar_time="end"`、`on_missing`、`status=5`（盘后）可小补；
- MCP/HTTP 网关不引入，我们已有 Python HTTP/SSE 服务。

## 边界与风险

- **许可**：不得复制 eltdx 源码、夹具、文档或 wheel；只读文档后重实现协议。
- **架构**：eltdx 依赖 Rust/PyO3 native wheel；我们的 sidecar 必须保持 stdlib-only、
  Nuitka 单文件、跨平台可打包。
- **数据源**：不引入 EX 7727/MAC-EX、港股美股期货、基金债券 F10、AxData 多源；
  仍只做 A 股 + 通达信。
- **语义**：0x052b 仅日线不复权；0x0452 只覆盖特殊品种；免费站无持续推送；
  MAC 0x122F 是聚合秒数据，不是逐笔；批量扫描可能限流。

## 验证探针

只读/离线已验证：

```bash
python -c "import eltdx"  # 未安装：ModuleNotFoundError
PYTHONPATH=python python -m pytest python/tests/test_local.py python/tests/test_tdx.py -q  # 78 passed
```

后续联网验证（临时目录，不影响用户数据）：

```python
from eltdx import TdxClient
with TdxClient(timeout=6, heartbeat_interval=None) as c:
    q = c.bars.get("sh600519", period="day", count=5,
                   adjust="fixed_qfq", anchor_date="2024-06-03")
    d = c.delisted_bars.get("T000038", count=5)
    s = c.limits.scan_special(max_rows=200)
    m = c.money_flow.history("sh600519", days=60)
    print(q.adjust_mode, q.anchor_date, d.count, len(s), len(m.rows))
    print(c.resources.block_meta("block_gn.dat"))
```

验收标准：每条新命令有真实 fixture + 单测 + HTTP 路由；0x0010 资产/净利与
`finance2.hex` 对齐；0x052d amount 与原始 u32 解码一致且旧 Parquet 可读；
0x052b `T000038` 首末日期可复现；0x0452 特殊价与官方一致；`npm run check` 全绿。
