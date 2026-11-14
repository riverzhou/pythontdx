# pythontdx 1.4.0 发布说明

- 版本：`1.4.0`
- 日期：2026-11-04
- 平台：Windows x64、Linux x64、macOS arm64
- 定位：离线 K 线下载重做 + 数据缓存/续跑可靠性收口

## 重点：离线 K 线下载重做

### 日 K：官方 `.day` 文件

- `0x06b9` 直接下载 `vipdoc/{sh,sz,bj}/lday/<code>.day`；
- 600519 实测 193,120 字节、7 个块、6,035 根，最后 2026-11-04；
- 100 只 16×4 实测 **6.2 秒**；
- 失败自动回退 0x052d 分页。

### 1 分钟 K：100 个交易日

- `kline_1m` 与日 K 独立；
- 服务端实际约 92 个交易日（22,080 根/只），请求 100 日返回全部可用；
- 优先复用本地 1m 全历史缓存；
- 即使缓存已有 100 日，也至少抓最新页直到与缓存重叠，避免旧缓存写回旧分区；
- 100 只实测：48×4 **8.2 秒**，8×4 **12.3 秒**。

### Parquet 写入

- 逐行 DuckDB INSERT → 临时 CSV staging + `COPY`；
- 2.2 万行约 **4 秒 → 0.19 秒/文件**；
- 最终仍是 Parquet+ZSTD+manifest+SHA256，CSV 写完即删。

## 缓存与跳过修复

- 1m 旧 manifest 的 `complete=false` 不再导致每次重下；
- 有 parquet、无 manifest 的旧 1m 归档会读回 Parquet 自动补 manifest；
- auction manifest 的 SHA 是解压后 JSONL，改用元数据/专用规则校验，
  不再把 5,616 个 auction 全判损坏；
- money_flow 旧 manifest 无 rows，按 code/date/bytes 校验，不再全量重下；
- 服务器明确 no-data 的 auction/tick/minute_aux/history/1m/kline 写
  `.nodata.json`，第二次同步跳过；超时/连接失败不标记；
- 北交所/停牌代码官方 `.day` 仍是旧日期时，同一天只刷新一次，次日再试。

## 任务摘要与续跑

- 摘要保留 `completed/failed/incomplete/cancelled`、计划/完成/失败/行数/总耗时；
- 完成态进度条把失败也计入已处理，画满 100%；
- 失败/中断可「继续未完成任务（跳过已有）」；
- 「自动续跑」默认开启，同一 jobId 在一次会话内只自动尝试一次；
- Windows worker 看门狗改用 `OpenProcess + WaitForSingleObject`，不再误发 Ctrl+C；
- 父进程退出后 worker 自动退出，不再留下孤儿进程吃 CPU；
- 规划阶段逐笔按日期目录预加载，完整计划约 **6–7 秒**。

## 官方 1 分钟通道调查结论

- 本地是 `vipdoc/*/minline/*.lc1` 文件；
- 但 7719 文件服务对 `.lc1` 返回 `size=0`，没有 HTTP 文件 URL；
- 官方 1m 是行情协议抓取后写 `.lc1`，因此本项目继续用 0x052d，不伪造文件通道。

## 验证

- `npm run check`：359 TS（357 通过 / 2 skipped）+ 283 Python（282 通过 / 1 skipped）；
- 日 K 100 只：16×4 6.2s、48×4 12.2s；
- 1m 100 只：48×4 8.2s、8×4 12.3s；
- 1m/缓存修复后规划：auction 133、money_flow 0、ticks 2、kline 0
  （配合已生成的 no-data 标记）；
- 数据完整性：历史 148,427 份 manifest/SHA256 校验 0 失败（1.3.x 基线）。

## Windows 本机构建

```text
release/1.4.0/
  pythontdx-1.4.0-setup.exe        134,618,808 B  SHA256 9d3f1a53…4e22b12
  pythontdx-1.4.0-portable.exe     134,364,608 B  SHA256 a5f90cff…710c86839
  pythontdx-1.4.0-win-x64.zip      181,737,384 B  SHA256 4a29dd15…d230691
```

Linux AppImage/deb 与 macOS arm64 dmg 由 tag `v1.4.0` 的 GitHub Actions
`release.yml` 构建，并连同 Windows 资产一起发布到 GitHub Release。

## 已知边界

- 只做 A 股 + 通达信；7727/EX、港股/美股/期货不做；
- 全市场 ticks/history_minute 是天量数据，默认只对自选或最近窗口；
- f10 full 档全市场首次建库以小时计，默认 core；
- volume_profile（0x051a）免费主站全部超时，不进预设；
- 节假日表缺省只按周末判断。
