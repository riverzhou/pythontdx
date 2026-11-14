# pythontdx 1.2.0 发布说明

- 版本：`1.2.0`
- 发布日期：2026-11-03
- 仓库：<https://github.com/riverzhou/pythontdx>
- 平台：Linux x64 / Windows x64 / macOS arm64（Apple Silicon）

## 重点

### 所有分时和 K 线统一 1 秒

- 交易时段主图分时、五日、各周期 K 线统一 **1 秒**刷新；
- 多股同列九宫格同样 1 秒；
- K 线首帧全量，之后每秒只回最近 20 根并合并进 800 根缓存，
  不会每秒搬运 800 根；
- 午休 30 秒、收盘 60 秒自动降频。

### 开盘第一秒就有分时线

官方分时接口在 09:31 前没有分钟点。1.2.0 在 09:30 先补昨收基准，
把 1 秒报价累积成实时轨迹画在当前槽位；官方点到达后按槽位过滤掉临时轨迹，
不污染历史。K 线同时用最新报价补开盘第一根/最后一根。

### 集合竞价左侧栏兜底

竞价阶段部分股票（科创板尤其明显）没有快照/增量记录，左侧自选行会显示「—」。
现在对自选逐只取 `0x056a` 最后一个虚拟撮合点，显示价格并标注「竞价」；
行情头也用 `0x056a` 补最新虚拟撮合价。

### 价格时效

- `0x054c` 批量快照负责 1 秒价格/量/额，`0x0547` 保留五档深度；
- 行情头、状态栏显示真实接收时间，不用旧的 `updateTime` 冒充新帧；
- 自选迷你走势末点跟随 1 秒报价；竞价、排行、逐笔均 1 秒。

### Linux AppImage 双击修复

Ubuntu/GNOME 默认把 `application/vnd.appimage` 交给磁盘镜像挂载器，
双击只会挂载。新增桌面集成：

```bash
./pythontdx-1.2.0.AppImage --install-desktop
```

安装应用菜单入口与通用 AppImage 启动器后，文件管理器双击即可启动。
首次 GUI 启动也会询问一次，设置面板可重试。

### 主界面北京时间时钟

标题栏每秒显示 `HH:MM:SS`、日期、星期与交易时段；集合竞价/连续竞价带脉冲。

### 搜索慢点击修复

搜索列表出现后，点得稍慢（mousedown→mouseup 超过 140ms）时弹层先被移除，
导致 click 落空。现在搜索项在 mousedown 阶段锁住焦点；350ms / 500ms /
3s / 6s 慢点击均已验证可选中。

## 产物

| 平台 | 产物 |
|---|---|
| Linux x64 | `pythontdx-1.2.0.AppImage`、`pythontdx_1.2.0_amd64.deb`、`SHA256SUMS-linux.txt` |
| Windows x64 | `pythontdx-1.2.0-setup.exe`、`pythontdx-1.2.0-portable.exe`、`pythontdx-1.2.0-win-x64.zip`、`.sha256`、`pythontdx-selfsigned.cer` |
| macOS arm64 | `pythontdx-1.2.0-arm64.dmg`、`SHA256SUMS-macos.txt` |

Windows 使用免费自签名，只保证完整性，SmartScreen 仍会提示未知发布者。
macOS 使用 ad-hoc 签名，未做 Developer ID 公证。

## 验证

- `npm run check`：**359 TS + 175 Python（1 skipped）**，exit 0；
- 打包后的 Linux AppImage 实测行情头约 1 秒更新、liveTicks 持续增长、
  九宫格/K 线 1 秒；
- `--install-desktop` 后 `gio open` 能真正启动 AppImage；
- 搜索慢点击 350 / 500 / 3000 / 6000ms 均能选中；
- 开盘第一秒与竞价兜底逻辑已用单元测试锁住，仍建议下一交易日
  **09:15–09:31** 实盘复核。

> 每个产物的 SHA256 以 Release 附件中的 `.sha256` / `SHA256SUMS-*.txt` 为准。
