import { describe, expect, it } from 'vitest'
import { SIDEBAR_COMPACT_MAX, sidebarDensity, type SidebarDensity } from './sidebar-width'

const densityOf = (width: number): SidebarDensity => sidebarDensity(width)

describe('sidebarDensity', () => {
  it('默认栏宽（264/280/380）是宽档：迷你图 46px', () => {
    expect(densityOf(264)).toBe('wide')
    expect(densityOf(280)).toBe('wide')
    expect(densityOf(380)).toBe('wide')
  })

  it('用户常用的 250px 仍是宽档 —— 迷你图不缩水', () => {
    expect(densityOf(250)).toBe('wide')
    expect(densityOf(SIDEBAR_COMPACT_MAX + 1)).toBe('wide')
  })

  it('只有比 228px 更窄才进窄档：迷你图缩到 26px 但始终在位', () => {
    expect(densityOf(SIDEBAR_COMPACT_MAX)).toBe('compact')
    expect(densityOf(224)).toBe('compact')
    expect(densityOf(200)).toBe('compact')
  })

  it('宽度无效时按宽档渲染，不因为 NaN 把迷你图缩小', () => {
    expect(densityOf(NaN)).toBe('wide')
    expect(densityOf(Infinity)).toBe('wide')
  })
})
