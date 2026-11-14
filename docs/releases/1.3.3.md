# pythontdx 1.3.3 发布说明

- 版本：`1.3.3`
- 发布日期：2026-11-04
- 仓库：<https://github.com/riverzhou/pythontdx>
- 平台：Linux x64 / Windows x64 / macOS arm64（Apple Silicon）

## 1 分钟 K 独立下载

- `全历史 K 线`（日 K）与 `1 分钟 K（最近 100 交易日）`是两个独立数据集；
- 1 分钟 K 不再混在日 K 的 `periods` 里，避免误把全历史 1 分钟线一起拉；
- 服务端当前约保留 **92 个交易日**（600519 实测 22,080 根，
  2026-06-22 → 2026-11-04），请求 100 日会返回全部可用历史；
- 写 `lake/kline_1m/trade_date=<末日>/<code>.parquet` + manifest；
- 只翻 K 线页（约 28 页），不调用 `full_kline`、不覆盖日 K 缓存。

## 数据工具记住上次配置

数据集勾选、范围、数据源（auto/mac/7709）、进程/线程、跳过已有会写入
`settings.offlineSync`，下次打开数据工具自动恢复；用户主动清空也会记住。

## 修复

- `offlineSync` 嵌套对象未拍平，打开数据工具报
  “An object could not be cloned”；已在 `plainSettings()` 复制 datasets 数组。
- 1 分钟 K 按完整日期时间计数会错当 20 根；改为按交易日 `YYYY-MM-DD` 分组。

## 验证

- `npm run check`：359 TS（357 通过/2 skipped）+ 279 Python（278 通过/1 skipped）；
- `kline_1m`：22,080 根 / 92 日 / 约 1.1s（20 日时 4,800 根）；
- 面板实测 24 个数据集，`1 分钟 K` 与 `全历史 K 线` 分列；
- 过程 7/8 设置在关闭再打开数据工具后保持；`pythontdx.json` 写入
  `offlineSync.processes=7`。

## 产物

| 平台 | 产物 |
|---|---|
| Linux x64 | `pythontdx-1.3.3.AppImage`、`pythontdx_1.3.3_amd64.deb`、`SHA256SUMS-linux.txt` |
| Windows x64 | `pythontdx-1.3.3-setup.exe`、`pythontdx-1.3.3-portable.exe`、`pythontdx-1.3.3-win-x64.zip`、`.sha256`、`pythontdx-selfsigned.cer` |
| macOS arm64 | `pythontdx-1.3.3-arm64.dmg`、`SHA256SUMS-macos.txt` |

Windows 使用免费自签名；macOS 使用 ad-hoc 签名。

> 每个产物的 SHA256 以 Release 附件中的 `.sha256` / `SHA256SUMS-*.txt` 为准。
