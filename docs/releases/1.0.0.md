# pythontdx 1.0.0 发布说明

- 版本：`1.0.0`
- 日期：2026-11-02
- 许可证：GPL-3.0-or-later
- 平台：Linux x64 / Windows x64 / macOS arm64
- 发布：GitHub Actions 三平台构建，已上传 [GitHub Release v1.0.0](https://github.com/riverzhou/pythontdx/releases/tag/v1.0.0)
- 签名：不购买付费证书；Windows 使用 CI 生成的自签名证书，macOS 使用 ad-hoc 签名

## 本版重点

### 0x0547 增量行情

- `0x0547` 确认为按代码 `updateTime` 游标的增量刷新；
- `cursor=0` 建立基线，无新成交返回 0 条，有新成交返回 1 条并推进游标；
- 客户端保存 per-code cursor、缓存上一帧，0 条响应不清空；
- 部分返回按记录内「市场 + 代码」映射；
- 每 60 秒强制一次 cursor=0 基线，防游标失步；
- 未配对推送帧仍会入队/合并；真实免费 7709 主站不做可靠主动推送：
  本项目 48 个配置主站各 5 秒、75 秒单代码、45 秒 80 代码均 0 帧；
  独立 eltdx issue #21 四层实测与维护者复验同为 0 帧，增量刷新可用。

### 实时鲁棒性

- 30 秒空闲心跳、8 秒请求超时、断线重连、跨日游标重置；
- 历史竞价服务器为空时回退永久本地归档；
- 本地 `.day/.lc1/.lc5/.5` 读/写 API 与测试；
- 板块行情列表显示指数涨跌幅，选中显示点位/涨跌幅/领涨股。

## 验证

```text
npm run check      315 TS + 168 Python（1 skipped）
npm run audit:data 39/39
build:linux / build:web / build:python 通过
```

GitHub Actions `release-1.0.0` 在 `v1.0.0` tag 上构建三平台并创建 Release。

## 产物

| 产物 | 大小 | SHA256 |
| --- | ---: | --- |
| `pythontdx-1.0.0.AppImage` | 165,206,214 B | `9b4188313c6144aac57aa9357a1a9fc5cb4ea1a454bfec0da1be0e63da524e49` |
| `pythontdx_1.0.0_amd64.deb` | 138,739,784 B | `4beed0857b370c958234fb6eccf7321552555b2a14d1f1d4059a85940f8d9204` |
| `pythontdx-1.0.0-setup.exe` | 133,361,160 B | `f142186e4175a16684a338d96d98207cf61bca82ac31a057a7d8392cfa2e35a6` |
| `pythontdx-1.0.0-portable.exe` | 133,107,024 B | `df15a0d3a2cd590d06326659e2647d8a3807d1fa5445f90ae015db62963183c1` |
| `pythontdx-1.0.0-arm64.dmg` | 166,829,697 B | `b659c2b2cff342d7a047beae1161fedd420fa07aba998eddb075ca7e271c4cfa` |
| `pythontdx-1.0.0-win-x64.zip` | 180,319,847 B | `8b38a7ae578af49dbf61ff32f60d0bc6513589406ac4dbde03bb736e65a7b4ce` |
| `pythontdx-selfsigned.cer` | 822 B | `f5c623d2ca0a7d05f5e16f778a4725adbd51c67797e7b6772971197c40681d61` |

Windows 绿色 zip 由 `release-windows-zip` 单独补发（CI run `41418995799`），
内含该次构建的签名 exe 与自签名公钥（指纹
`25FD4194C69DB7DCA892249C4A44CE36AD33AB3B`）；不影响 setup/portable 及其旧证书。

> 本页是 1.0.0 历史发布说明；Release 里的资产文件名仍是改名前的名称，
> 上表按新品牌展示，下载以 Release 页面实际文件名为准。

## 边界

- Windows 为免费自签名，SmartScreen 仍会提示未知发布者；
- macOS 为 ad-hoc 签名，未做 Developer ID 公证；
- 6 项 ⛔：研报正文、交易/下单、Level-2/付费、7727/EX、港股美股、登录/账户；
- `0x06b9` 无服务器完整目录枚举命令；
- 本地文件 API 已接，主行情 UI 仍以 7709 为主。
