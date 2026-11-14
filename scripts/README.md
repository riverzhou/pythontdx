# scripts/ —— 开发与发布用的命令行工具

这里只放「跑一次、看一眼」的工具，不参与运行时。运行时代码在 `src/` 与 `python/`。

| 目录         | 管什么                                             | 典型命令                                                         |
| ------------ | -------------------------------------------------- | ---------------------------------------------------------------- |
| `python.mjs` | Python 命令的唯一入口（选解释器、给中文报错）      | `npm run test:python` / `audit:data` / `build:python` / `social` |
| `build/`     | 打包前后处理：图标、sidecar 平台校验、签名、绿色包 | `npm run icon` / `build:win` / `sign:win`                        |
| `dev/`       | 本机验收素材：截图、Web 截图、社交预览图           | `npm run shot` / `shot:web` / `social`                           |
| `dev/audit-docs.mjs` | 文档自检：链接、截图、路径引用、HTTP 契约  | `npm run audit:docs`                                             |
| `data/`      | 数据覆盖自检、收盘后自动归档                       | `npm run audit:data` / `archive:snapshot`                        |
| `probe/`     | 一次性协议探针（只产出证据，不进发布流程）         | `node scripts/probe/probe-tdx.mjs`                               |

**约定**

- 目录名是用途，文件名是动作：`动词-对象`（`build-win-zip.ps1`、`probe-tdx.mjs`）。
- Python 脚本自己算仓库根：`Path(__file__).resolve().parents[2]`；Node 脚本用
  `join(dirname(fileURLToPath(import.meta.url)), '..', '..')`。不依赖调用时的 cwd。
- 探针脚本只写证据，不做判断；结论回写 `docs/03` / `docs/08`。
- 新脚本先问：能不能用现有 npm 命令？能就不加新脚本。

脚本清单与归属规则见 [`docs/24-项目结构与命名规范.md`](../docs/24-项目结构与命名规范.md)。
