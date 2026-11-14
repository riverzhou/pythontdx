# pythontdx 1.3.2 发布说明

- 版本：`1.3.2`
- 发布日期：2026-11-04
- 仓库：<https://github.com/riverzhou/pythontdx>
- 平台：Linux x64 / Windows x64 / macOS arm64（Apple Silicon）

## 修复

### 打包版离线同步无法启动 worker

安装包/便携版通过 `subprocess.Popen` 启动 worker 时，`cwd` 可能指向构建机路径，
日志只有 `[spawn] [WinError 2] 系统找不到指定的文件`，任务停在 `probing/planning`，
数据一个都没下载。

1.3.2：

- `cwd` 改为确定存在的 `job_dir`，不再依赖 `__file__` 的构建路径；
- worker 可执行文件优先选真实存在的 `sys.executable`，回退 `sys.argv[0]`；
- 打包后的 `tdx-bridge.exe` 实测 `offline_sync_start` 能拉起 worker（PID 运行中）；
- 同步状态为 `failed` 时，数据面板直接显示错误，不再只显示「同步中」。

### 数据工具全量进度条

所有耗时操作都有进度条，能算百分比就画确定进度，拿不到总量就画不确定动画 + 已耗时：

- 并行同步：探测主站 / 生成计划 / 真实完成数 / 吞吐 / ETA / worker 进度；
- 下载 `zhb.zip`、规范化导出、Parquet/CSV 导出；
- 本地目录扫描、完整性校验（逐份 manifest/SHA256）；
- 自选 K 线导出、全市场快照、数据湖归档、自选竞价归档、竞价归档历史；
- 本地 `.day` 读取、导入数据湖、写回；
- SQL 查询；
- 备份/恢复保留真实字节进度。

## README 翻新

- 新主图、数据工具进度截图、尾盘集合竞价截图；
- 重写功能、数据湖目录、协议边界、快速开始、构建、测试与文档索引。

## 验证

- `npm run check`：**359 TS（357 通过/2 skipped）+ 279 Python（278 通过/1 skipped）**；
- 打包 sidecar：`offline_sync_start` → worker PID 运行中；
- 指数成交量 599.39 万手，120 根量柱高度 33–67px；
- 尾盘竞价 688499 56 点（14:57–14:59:58）。

## 产物

| 平台 | 产物 |
|---|---|
| Linux x64 | `pythontdx-1.3.2.AppImage`、`pythontdx_1.3.2_amd64.deb`、`SHA256SUMS-linux.txt` |
| Windows x64 | `pythontdx-1.3.2-setup.exe`、`pythontdx-1.3.2-portable.exe`、`pythontdx-1.3.2-win-x64.zip`、`.sha256`、`pythontdx-selfsigned.cer` |
| macOS arm64 | `pythontdx-1.3.2-arm64.dmg`、`SHA256SUMS-macos.txt` |

Windows 使用免费自签名；macOS 使用 ad-hoc 签名。

> 每个产物的 SHA256 以 Release 附件中的 `.sha256` / `SHA256SUMS-*.txt` 为准。
