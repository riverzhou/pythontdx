# pythontdx 1.1.0 发布说明

- 版本：`1.1.0`
- 发布日期：2026-11-02
- 仓库：<https://github.com/riverzhou/pythontdx>
- 平台：Linux x64 / Windows x64 / macOS arm64（Apple Silicon）

## 重点

### 正式改名 pythontdx

项目正式名称统一为 **pythontdx**：窗口/托盘/设置、`appId`、包名、exe、
安装包/快捷方式、userData、Python 数据目录、localStorage、Parquet schema、
备份清单、CI 产物与文档全部改名。

旧数据会在首次启动时自动迁移，**旧目录保留**：

- 旧 userData 复制到 `%APPDATA%/pythontdx`（macOS/Linux 对应目录）；
- 旧配置文件名复制为 `pythontdx.json`；
- 便携版旧数据目录复制为 `pythontdx-data`；
- Python `~/.local/share/stocklens` 迁移到 `~/.local/share/pythontdx`；
- 旧 localStorage key、备份清单继续兼容；
- 旧 `STOCKLENS_DATA_DIR` 环境变量仍可用。

### 1440×900 默认窗口与宽表适配

- 默认窗口改为 **1440×900**；旧默认 1600×900 / 1280×820 启动时升级。
- 主行情 12 项指标固定单行，1440 下不换行、不裁切。
- 全市场、板块/概念、排行榜收窄名称列，走势列加宽到 58px；
  1440×900 下三张宽表均无横向滚动条。
- 排行榜“全市场”模式 21 列也不横向滚动。
- 修复板块侧栏迷你走势图加载不全：按显示顺序预热，滚动时补齐可见行。

## 产物

| 平台 | 产物 |
|---|---|
| Linux x64 | `pythontdx-1.1.0.AppImage`、`pythontdx_1.1.0_amd64.deb`、`SHA256SUMS-linux.txt` |
| Windows x64 | `pythontdx-1.1.0-setup.exe`、`pythontdx-1.1.0-portable.exe`、`pythontdx-1.1.0-win-x64.zip`、`.sha256`、`pythontdx-selfsigned.cer` |
| macOS arm64 | `pythontdx-1.1.0-arm64.dmg`、`SHA256SUMS-macos.txt` |

Windows 绿色 zip 内含签名后的 `pythontdx.exe`、`tdx-bridge.exe` 与自签名公钥。
Windows 使用免费自签名，只保证完整性，**SmartScreen 仍会提示未知发布者**。
macOS 使用 ad-hoc 签名，未做 Developer ID 公证。

## 验证

- `npm run check`：**319 TS（318 passed + 1 skipped）+ 172 Python（1 skipped）**
- 1440×900 主指标单行；全市场/板块/排行榜表格 `scrollWidth === clientWidth`
- 旧用户数据迁移、旧备份恢复、旧环境变量别名均有测试覆盖
- 各平台由 GitHub Actions 原生 runner 构建

> 每个产物的 SHA256 以 Release 附件中的 `.sha256` / `SHA256SUMS-*.txt` 为准。
