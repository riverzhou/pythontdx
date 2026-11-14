# pythontdx 1.3.4 发布说明

- 版本：`1.3.4`
- 发布日期：2026-11-04
- 仓库：<https://github.com/riverzhou/pythontdx>
- 平台：Linux x64 / Windows x64 / macOS arm64（Apple Silicon）

## 并发模型

- 默认 **8 进程 × 4 线程**；
- 进程上限 **48**、每进程线程上限 **4**；
- 48 × 4 = **192 条连接**，不再被旧的 12 进程上限截断；
- **一进程一主站**：第 i 个 worker 钉在 `servers[i % len(servers)]`，
  该进程的 4 条线程共享这台主站；
- 服务器少于进程数时循环复用；某台故障仍可回退 endpoints 列表。

## 逐笔成交

- `ticks` 数据集默认展开**最近 20 个交易日**（按交易日升序），
  显式传 `--dates` 时尊重用户日期；
- 标签改为「逐笔成交（最近 20 交易日）」，界面直接可见；
- 20 × N 只代码的任务会明显变多，这是预期：逐笔体量最大。

## 其他

- 数据工具恢复上次配置时，进程/线程按 1–48 / 1–4 夹取；
- 日 K（全历史）与 1 分钟 K（最近 100 交易日，服务端约 92 日）保持独立选项；
- 配置记忆、进度条、打包版 worker 启动修复继续有效。

## 验证

- `npm run check`：359 TS（357 通过/2 skipped）+ 280 Python（279 通过/1 skipped）；
- 面板实测 24 个数据集，进程 8、线程 4，逐笔标签为「最近 20 交易日」；
- ticks 单只代码规划 20 个任务：2026-10-08 → 2026-11-04；
- 48×4 规范化后不再截断为 12。

## 产物

| 平台 | 产物 |
|---|---|
| Linux x64 | `pythontdx-1.3.4.AppImage`、`pythontdx_1.3.4_amd64.deb`、`SHA256SUMS-linux.txt` |
| Windows x64 | `pythontdx-1.3.4-setup.exe`、`pythontdx-1.3.4-portable.exe`、`pythontdx-1.3.4-win-x64.zip`、`.sha256`、`pythontdx-selfsigned.cer` |
| macOS arm64 | `pythontdx-1.3.4-arm64.dmg`、`SHA256SUMS-macos.txt` |

Windows 使用免费自签名；macOS 使用 ad-hoc 签名。

> 每个产物的 SHA256 以 Release 附件中的 `.sha256` / `SHA256SUMS-*.txt` 为准。
