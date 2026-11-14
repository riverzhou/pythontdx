/**
 * 渲染进程入口（Electron 与 Web 共用）。
 *
 * 样式顺序很重要，就是层叠顺序，不要重排：
 *   tokens（变量） → base（重置） → components（通用小件）
 *   → panels/*（业务面板） → layout/*（应用骨架与工作区）
 * 这份清单同时是「哪份样式管哪块」的目录：新增面板样式放进对应的 panels 文件。
 *
 * 数据面在 `lib/http-api.ts` 统一创建；这里只负责挂载。
 * 独立 K 线窗口已移除：行情显示全部回到主工作区标签页。
 */
import { render } from 'solid-js/web'
import App from './App'
import { migrateLegacyLocalStorage } from './lib/legacy-storage'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/panels/market.css'
import './styles/panels/f10.css'
import './styles/panels/tools.css'
import './styles/panels/settings.css'
import './styles/panels/reports.css'
import './styles/panels/shell.css'
import './styles/panels/tables.css'
import './styles/layout/shell.css'
import './styles/layout/workspace.css'
import './styles/layout/tuning.css'

// 旧 StockLens 的报价/分时快照 key 先复制到 pythontdx 前缀。
migrateLegacyLocalStorage()

const container = document.getElementById('root')
if (!container) {
  throw new Error('找不到 #root 挂载点，请检查 index.html')
}

render(() => <App />, container)
