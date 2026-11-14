# pythontdx 1.3.0 发布说明

- 版本：`1.3.0`
- 发布日期：2026-11-04
- 仓库：<https://github.com/riverzhou/pythontdx>
- 平台：Linux x64 / Windows x64 / macOS arm64（Apple Silicon）

## 重点

### 数据能力收口

- **7709**：29 条 A 股命令全部接入；K 线补 `openMilli/closeMilli/highMilli/
  lowMilli/lastCloseMilli/volumeRaw/amountRaw`，报价补 `currentHand/openAmount/
  recordHex`，代码表补 `multiple/prevClose`，历史逐笔补 `priceBase`。
- **MAC 0x12xx**：新增 0x120F/1215/1217/122A/122C/122D/122E/123D/123E/124A；
  A 股相关 15 条中 14 条可用，0x1217 文件分片在测试主机返回空分片，下载仍走 0x06b9。
  MAC 不是 7709 超集，采用 MAC 优先 + 7709 兜底。
- **7615**：9/9 HQServ 页、20 个行业子页、84 个资讯频道、涨跌停梯子；
  三主机 failover、ColDes 回退、重复列 `__2`。
- **gpcw 历史专业财务**：5,572 只 × 658 float，落 `lake/finance_history`。
- **本地 GBBQ**：解密/解析 `T0002/hq_cache/gbbq`，本机 202,313 条验证；
  字段统一为 `c1..c4 + categoryName`，避免把股本字段误读成分红。
- **0x000d 握手**：189B 回包解析服务器日期/两段交易时段/服务器名/产品标识。

### 离线同步

- 多进程 × 每进程多线程 × 多服务器，默认 **4 进程 × 8 线程**；
- **23 个数据集**，新增 `blocks`（默认勾选）、`gbbq`（默认不勾选）、
  `finance_history`、`limit_ladder`；
- F10 从所有预设移除、默认不勾选；
- 数据源 `auto/mac/7709`；旧的两套前台批量下载已删除，只保留并行同步一套；
- 交易日 08:45–15:45 保护，暂停/取消不再合并部分 bulk，归档前校验文件+SHA。

### 归档与安全

- 分区级文件锁 + 唯一临时文件 + 原子替换，避免并发归档互相覆盖；
- 损坏副本可校验重写，合法同名归档仍保留第一版；
- HTTP 写接口 Origin 白名单，阻止网页覆盖本地行情/绕过窗口；
- jobId 白名单与目录逃逸校验。

### 文档

新增 `docs/19-MAC协议与数据源策略.md`、`docs/20-数据功能补齐与代码审计.md`、
`docs/21-通达信协议总表.md`；同步更新 `docs/03/08/09/11/12/15/16/17/18` 与
README/PLAN/CHANGELOG。

## 产物

| 平台 | 产物 |
|---|---|
| Linux x64 | `pythontdx-1.3.0.AppImage`、`pythontdx_1.3.0_amd64.deb`、`SHA256SUMS-linux.txt` |
| Windows x64 | `pythontdx-1.3.0-setup.exe`、`pythontdx-1.3.0-portable.exe`、`pythontdx-1.3.0-win-x64.zip`、`.sha256`、`pythontdx-selfsigned.cer` |
| macOS arm64 | `pythontdx-1.3.0-arm64.dmg`、`SHA256SUMS-macos.txt` |

Windows 使用免费自签名，只保证完整性，SmartScreen 仍会提示未知发布者。
macOS 使用 ad-hoc 签名，未做 Developer ID 公证。

## 验证

- `npm run check`：**359 TS（357 通过/2 skipped）+ 277 Python（276 通过/1 skipped）**；
- MAC 日 K 全历史 6,035 根与 7709 一致；当日分时 176 点；
- gpcw 5,572 只 × 658 字段，6.9s；
- GBBQ 本机 202,313 条；
- 离线同步面板 23 数据集，截图见 `screenshots/data-offline-sync.png`。

> 每个产物的 SHA256 以 Release 附件中的 `.sha256` / `SHA256SUMS-*.txt` 为准。
