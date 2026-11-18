/**
 * 左栏（导航）宽度的分档：宽栏 / 紧凑 / 最窄。
 *
 * 三张列表（自选股 / 板块成分股 / 自定义板块）共用同一个行组件，所以这里只算
 * 一个分档，行内布局按分档切换 —— 绝不按视口宽度分档：左栏宽度是用户拖出来的
 * （200~380px），1440 宽的窗口里左栏照样可能只有 224px，
 * `@media (max-width: 1240px)` 这类视口断点永远命中不了它。
 *
 * 一行里的固定开销（padding 8×2 + gap 6×2 + 价格列 66 + 列表滚动条 10）：
 *   · 宽档：迷你图 46px，名称列 = 左栏宽度 - 168；
 *   · 窄档：迷你图 26px，名称列 = 左栏宽度 - 148。
 * 两档都保证迷你图始终在位（2026-11-18 用户反馈「迷你图小了一倍、右边还有很多留白」），
 * 名称列也都 ≥ 4 个汉字（52px）：
 *   · 宽档 ≥ 228px：名称 ≥ 60px，250px 栏宽下 82px、默认 264px 下 96px；
 *   · 窄档 ≤ 227：名称 52~79px，迷你图缩到 26px 但不消失。
 *
 * 为什么不用 CSS 容器查询：本项目的滚动条是自定义的（`::-webkit-scrollbar` 10px），
 * Chromium 在这种滚动条下量给容器查询的宽度不等于行的可用宽度（实测内容盒 224px
 * 时报 239px），阈值会随浏览器实现漂移。左栏宽度在 `App` 里本来就是已知的
 * 响应式值，直接用状态分档更准，也能被单元测试钉住。
 */

export type SidebarDensity = 'wide' | 'compact'

/** 只有比这个更窄才把迷你图缩到 26px（宽档 46px） */
export const SIDEBAR_COMPACT_MAX = 228

export function sidebarDensity(width: number): SidebarDensity {
  if (!Number.isFinite(width)) return 'wide'
  return width <= SIDEBAR_COMPACT_MAX ? 'compact' : 'wide'
}
