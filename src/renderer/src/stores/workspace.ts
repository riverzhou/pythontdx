/**
 * 主工作区状态：标签页 + 当前视图 + 弹窗。
 *
 * 设计原则（2026-11-14 用户要求）：
 *   · 行情相关的显示一律进主工作区标签页；
 *   · 只有设置、数据、F10/公告、公式/指标编辑器、服务器、快捷键保留弹窗。
 *
 * 视图与弹窗都集中在这里，组件直接调用 openView/openPopup，
 * 不再由 App 维护二十个布尔信号、也不再把面板做成全屏模态。
 */
import { createSignal } from 'solid-js'
import type { Quote } from '@shared/types'
import { setActiveCode } from './app'

export type WorkspaceView =
  | 'chart'
  | 'ranking'
  | 'blocks'
  | 'sector'
  | 'market'
  | 'screener'
  | 'multi'
  | 'watch'
  | 'tape'
  | 'portfolio'
  | 'report'
  | 'dragon'
  | 'unusual'
  | 'replay'
  | 'alerts'

export type PopupId =
  'settings' | 'data' | 'f10' | 'announcements' | 'formula' | 'indicators' | 'servers' | 'shortcuts'

export const VIEW_LABELS: Record<WorkspaceView, string> = {
  chart: '行情',
  ranking: '排行榜',
  blocks: '板块 / 概念',
  sector: '选择板块',
  market: '全部 A 股',
  screener: '条件选股',
  multi: '多股同列',
  watch: '自选行情墙',
  tape: '逐笔明细',
  portfolio: '组合分析',
  report: '大盘资料',
  dragon: '龙虎榜',
  unusual: '沪深异动',
  replay: '复盘',
  alerts: '预警'
}

/**
 * 「+」选择器里的视图顺序（分组在 WorkspaceTabs 里排版）。
 *
 * 不进这张表：
 *   · `chart`   固定标签，永远存在；
 *   · `sector`  板块选择是左栏「板块」视图的动作，入口在 Sidebar；
 *   · `alerts`  预警入口挂在标题栏铃铛上（带未读数）。
 */
export const VIEW_ORDER: WorkspaceView[] = [
  'ranking',
  'market',
  'blocks',
  'multi',
  'watch',
  'tape',
  'screener',
  'replay',
  'portfolio',
  'dragon',
  'unusual',
  'report'
]

/** 分组标题：只影响「+」菜单的排版，不影响视图本身。 */
export const VIEW_SECTIONS: Array<{ title: string; views: WorkspaceView[] }> = [
  { title: '行情', views: ['ranking', 'market', 'blocks', 'multi', 'watch', 'tape'] },
  { title: '分析', views: ['screener', 'replay', 'portfolio'] },
  { title: '资讯', views: ['dragon', 'unusual', 'report'] }
]

const [activeView, setActiveView] = createSignal<WorkspaceView>('chart')
const [tabs, setTabs] = createSignal<WorkspaceView[]>(['chart'])
const [popup, setPopup] = createSignal<PopupId | null>(null)

export { activeView, tabs, popup }

export function openView(view: WorkspaceView): void {
  setPopup(null)
  if (view === 'chart') {
    setActiveView('chart')
    return
  }
  setTabs((current) => (current.includes(view) ? current : [...current, view]))
  setActiveView(view)
}

export function closeView(view: WorkspaceView): void {
  if (view === 'chart') {
    setActiveView('chart')
    return
  }
  const current = tabs()
  const index = current.indexOf(view)
  if (index < 0) return
  const next = current.filter((item) => item !== view)
  setTabs(next.length > 0 ? next : ['chart'])
  if (activeView() === view) {
    setActiveView(next[Math.max(0, index - 1)] ?? 'chart')
  }
}

export function openPopup(id: PopupId): void {
  setPopup(id)
}

export function closePopup(): void {
  setPopup(null)
}

/** 测试/HMR 用：回到只有「行情」标签的初始状态。 */
export function resetWorkspace(): void {
  setTabs(['chart'])
  setActiveView('chart')
  setPopup(null)
}

/** 同一个入口再点一次就关掉（F10 键、工具栏按钮都适用）。 */
export function togglePopup(id: PopupId): void {
  setPopup((current) => (current === id ? null : id))
}

/**
 * 从任意行情列表选中一只股票：更新行情头，并回到「行情」标签。
 * 原来的行为是关闭弹窗后回主图；现在是切到固定标签，其它标签保留。
 */
export function selectStock(code: string): void {
  setActiveCode(code)
  setPopup(null)
  setActiveView('chart')
}

/** 列表里已经有完整报价时，先塞进 quoteMap，避免主图等下一拍推送。 */
export function selectQuote(quote: Quote, apply: (quotes: Quote[]) => void): void {
  apply([quote])
  selectStock(quote.code)
}
