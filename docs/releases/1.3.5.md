# pythontdx 1.3.5 发布说明

- 版本：`1.3.5`
- 发布日期：2026-11-04
- 仓库：<https://github.com/riverzhou/pythontdx>
- 平台：Linux x64 / Windows x64 / macOS arm64（Apple Silicon）

## 修复：点击开始同步报 “An object could not be cloned”

数据工具恢复上次配置时，`settings.offlineSync.datasets` 是 Solid store 的 Proxy；
`syncSelection` 直接持有它，启动时把 Proxy 数组放进 Electron IPC payload，
结构化克隆失败，所以任务建不起来。

1.3.5：

- 初始化时复制 `savedSync.datasets` 为普通数组；
- 预设、启动前再次 `[...syncSelection()]`；
- `codes` 同样复制为普通数组；
- 打包版实测可正常创建同步任务。

## 同时生效的 1.3.4 内容

- 默认 **8 进程 × 4 线程**，进程上限 48、每进程线程上限 4；
- 48×4 = 192 连接，不再被旧上限截断为 12 个下载器；
- 一进程一主站；
- 逐笔成交默认最近 20 交易日，界面已标注；
- 1 分钟 K 独立、最近 100 交易日（服务端约 92 日）；
- 数据工具记住上次配置、全量进度条。

## 验证

- `npm run check`：359 TS（357 通过/2 skipped）+ 280 Python（279 通过/1 skipped）；
- 面板实测 24 个数据集、8×4、逐笔「最近 20 交易日」；
- 点击开始同步不再报 clone 错误；
- 打包 sidecar worker 启动正常。

## 产物

| 平台 | 产物 |
|---|---|
| Linux x64 | `pythontdx-1.3.5.AppImage`、`pythontdx_1.3.5_amd64.deb`、`SHA256SUMS-linux.txt` |
| Windows x64 | `pythontdx-1.3.5-setup.exe`、`pythontdx-1.3.5-portable.exe`、`pythontdx-1.3.5-win-x64.zip`、`.sha256`、`pythontdx-selfsigned.cer` |
| macOS arm64 | `pythontdx-1.3.5-arm64.dmg`、`SHA256SUMS-macos.txt` |

Windows 使用免费自签名；macOS 使用 ad-hoc 签名。

> 每个产物的 SHA256 以 Release 附件中的 `.sha256` / `SHA256SUMS-*.txt` 为准。
