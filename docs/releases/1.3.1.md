# pythontdx 1.3.1 发布说明

- 版本：`1.3.1`
- 发布日期：2026-11-04
- 仓库：<https://github.com/riverzhou/pythontdx>
- 平台：Linux x64 / Windows x64 / macOS arm64（Apple Silicon）

## 修复

### 大盘指数成交量单位

`0x053e/0x054c/0x054b` 的 `totalHand` 对个股是「手」，对指数是「股」。
实时合并时没有归一，指数最后一根量柱会比历史大 100 倍，历史量柱被压成约
1%，看起来像「量图错误/只有最后一根」；离线 K 线缓存本身是正确的，
**不需要重新下载离线数据**。

1.3.1 在 `_build_quote` 统一把指数成交量除以 100，MAC `0x122B` 的指数量同样
归一；K 线 `volume` 与实时 `quote.volume` 现在同为「手」。

### 尾盘集合竞价

`0x056a` 的 `selector=0` 只返回 09:15–09:25 开盘竞价；`selector=1` 才包含
14:57–15:00 尾盘集合竞价。此前「竞价」页签只请求 selector=0，所以看不到尾盘细节。

1.3.1 在竞价页签增加「早盘 / 尾盘 / 全天」切换：

- 早盘：09:15–09:25（原行为）；
- 尾盘：14:57–15:00，实测 600519 59 点、688499 56 点；
- 全天：两段合并。

尾盘 15:00 的最终成交仍以「明细」里的正式成交为准；竞价列表是虚拟撮合快照。

## 验证

- `npm run check`：**359 TS（357 通过/2 skipped）+ 277 Python（276 通过/1 skipped）**；
- 指数截图：`screenshots/index-volume-fixed.png`，头部成交量 599.39 万手，
  120 根量柱高度 33–67px；
- 尾盘竞价截图：`screenshots/auction-close.png`，688499 共 56 点，
  14:57:00–14:59:58；
- 指数报价实测：`sh000001` 599,394,361 股 → 5,993,943.61 手，与 K 线一致。

## 产物

| 平台 | 产物 |
|---|---|
| Linux x64 | `pythontdx-1.3.1.AppImage`、`pythontdx_1.3.1_amd64.deb`、`SHA256SUMS-linux.txt` |
| Windows x64 | `pythontdx-1.3.1-setup.exe`、`pythontdx-1.3.1-portable.exe`、`pythontdx-1.3.1-win-x64.zip`、`.sha256`、`pythontdx-selfsigned.cer` |
| macOS arm64 | `pythontdx-1.3.1-arm64.dmg`、`SHA256SUMS-macos.txt` |

Windows 使用免费自签名，只保证完整性，SmartScreen 仍会提示未知发布者。
macOS 使用 ad-hoc 签名，未做 Developer ID 公证。

> 每个产物的 SHA256 以 Release 附件中的 `.sha256` / `SHA256SUMS-*.txt` 为准。
