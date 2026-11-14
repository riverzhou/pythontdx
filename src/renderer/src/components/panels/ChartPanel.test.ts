/**
 * 图表头部结构守卫：更新时间不再做成徽标，工具常驻在标题行里。
 *
 * 为什么读源码而不渲染组件：单测跑在 node 环境（vitest.config.ts 没有 jsdom），
 * Solid 组件挂不上去；而这两条要防的都是「同一个东西被摆到第二个位置」——
 *   · 2026-11-14 用户报「工具的弹出菜单里有个重复的时间显示」：收起式工具行里
 *     也放了一个「更新 hh:mm:ss」，展开后和标题区同时显示同一个时间；
 *   · 随后用户要求工具不再单独占一行、直接排在 指标/公式/复盘 左侧常驻显示，
 *     并且「更新时间的位置难看，换个好地方或者彻底去掉」——现改为挂在 ↻ 的 title 上。
 * 两条都能在源码里数出来，不需要 DOM 和行情数据。
 */
import { describe, expect, it } from 'vitest'
import source from './ChartPanel.tsx?raw'

const HEADLINE = 'class="chart-headline"'
const TOOLS = 'class="chart-tools"'

describe('ChartPanel 顶部不再常驻推送时间', () => {
  it('没有「更新」徽标，只剩 ↻ 的 title', () => {
    expect(source).not.toContain('chart-live-badge')
    expect(source).not.toContain('chart-headline__meta')
    expect(source).toContain('最近推送')
  })
})

describe('ChartPanel 工具常驻标题行', () => {
  it('没有可收起的第二行工具栏', () => {
    // 工具一旦被折叠/弹层包起来，收起时就看不见，展开时又会多占一行
    expect(source).not.toContain('chart-toolbar--secondary')
    expect(source).not.toContain('chart-tools-toggle')
    expect(source).not.toContain('toolsOpen')
  })

  it('工具组渲染在标题行内，且在 指标 左侧', () => {
    expect(source.indexOf(TOOLS)).toBeGreaterThan(source.indexOf(HEADLINE))
    expect(source.indexOf(TOOLS)).toBeLessThan(
      source.indexOf('class="btn btn--bare indicator-open"')
    )
  })

  it('操作组单独成组靠右，工具从左往右读', () => {
    const actions = source.indexOf('class="chart-headline__actions"')
    expect(actions).toBeGreaterThan(source.indexOf(TOOLS))
    expect(actions).toBeLessThan(source.indexOf('class="btn btn--bare indicator-open"'))
  })
})
