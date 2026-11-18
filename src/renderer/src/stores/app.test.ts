import { beforeEach, describe, expect, it, vi } from 'vitest'

const { patch } = vi.hoisted(() => ({ patch: vi.fn(async () => undefined) }))

vi.mock('../lib/client', () => ({
  api: {},
  shell: { state: { patch } },
  errorMessage: (error: unknown) => String(error)
}))

import {
  addStockToGroup,
  addWatchItem,
  appState,
  createGroup,
  defaultGroup,
  moveWatchItem,
  removeWatchItem
} from './app'

function groupByName(name: string) {
  return appState.groups.find((group) => group.name === name)
}

describe('自选与自定义板块多对多', () => {
  beforeEach(() => {
    // 整个文件共用一份状态；分组只建一次，用例用不同代码互不干扰
    if (!groupByName('自选')) createGroup('自选')
    if (!groupByName('电池')) createGroup('电池')
    patch.mockClear()
  })

  it('同一只股票可以同时在自选和自定义板块', () => {
    addWatchItem({ code: 'sh600519', name: '贵州茅台', market: 'SH' })
    addStockToGroup({ code: 'sh600519', name: '贵州茅台', market: 'SH' }, groupByName('电池')!.id)

    expect(groupByName('自选')?.items.map((item) => item.code)).toContain('sh600519')
    expect(groupByName('电池')?.items.map((item) => item.code)).toContain('sh600519')
    expect(defaultGroup()?.name).toBe('自选')
  })

  it('加入自选不会把股票从自定义板块里移除，反之亦然', () => {
    const battery = groupByName('电池')!
    addStockToGroup({ code: 'sz000001', name: '平安银行', market: 'SZ' }, battery.id)
    addWatchItem({ code: 'sz000001', name: '平安银行', market: 'SZ' })

    expect(groupByName('电池')?.items.map((item) => item.code)).toContain('sz000001')
    expect(groupByName('自选')?.items.map((item) => item.code)).toContain('sz000001')

    addStockToGroup({ code: 'sh600036', name: '招商银行', market: 'SH' }, battery.id)
    addWatchItem({ code: 'sh600036', name: '招商银行', market: 'SH' })
    removeWatchItem('sh600036')

    expect(groupByName('电池')?.items.map((item) => item.code)).toContain('sh600036')
  })

  it('组内拖动排序只改目标分组，别的分组顺序和归属不变', () => {
    const battery = groupByName('电池')!
    addWatchItem({ code: 'sz300750', name: '宁德时代', market: 'SZ' })
    addWatchItem({ code: 'sh600519', name: '贵州茅台', market: 'SH' })
    addStockToGroup({ code: 'sz300750', name: '宁德时代', market: 'SZ' }, battery.id)

    const before = groupByName('自选')!.items.map((item) => item.code)
    const target = groupByName('自选')!.items.length
    moveWatchItem('sz300750', groupByName('自选')!.id, target)

    const after = groupByName('自选')!.items.map((item) => item.code)
    expect(after[after.length - 1]).toBe('sz300750')
    expect(after).toHaveLength(before.length)
    expect(groupByName('电池')?.items.map((item) => item.code)).toContain('sz300750')
  })

  it('目标分组内去重，不会因为重复添加产生两条', () => {
    addWatchItem({ code: 'sh601318', name: '中国平安', market: 'SH' })
    addWatchItem({ code: 'sh601318', name: '中国平安', market: 'SH' })
    expect(groupByName('自选')?.items.filter((item) => item.code === 'sh601318')).toHaveLength(1)
  })

  /*
   * 左栏「自定义」列表的移出按钮走的就是 removeWatchItem(code, groupId)。
   * 曾经这个按钮没渲染出来（用户反馈「自定义板块的个股无法删除/移出」），
   * 这里把数据层的行为钉住：只删指定分组，别处同一只票必须留着。
   */
  it('从自定义板块移出一只：只动这个板块，自选和别的板块都还在', () => {
    const battery = groupByName('电池')!
    addWatchItem({ code: 'sz002594', name: '比亚迪', market: 'SZ' })
    addStockToGroup({ code: 'sz002594', name: '比亚迪', market: 'SZ' }, battery.id)

    removeWatchItem('sz002594', battery.id)

    expect(groupByName('电池')?.items.map((item) => item.code)).not.toContain('sz002594')
    expect(groupByName('自选')?.items.map((item) => item.code)).toContain('sz002594')
  })

  it('不传 groupId 会退回自选分组——所以列表里移出时必须显式带板块 id', () => {
    const battery = groupByName('电池')!
    addWatchItem({ code: 'sh600276', name: '恒瑞医药', market: 'SH' })
    addStockToGroup({ code: 'sh600276', name: '恒瑞医药', market: 'SH' }, battery.id)

    // 这就是界面必须挡住的那条路：拿不到自定义板块 id 时不能退化成默认参数
    removeWatchItem('sh600276')

    expect(groupByName('自选')?.items.map((item) => item.code)).not.toContain('sh600276')
    expect(groupByName('电池')?.items.map((item) => item.code)).toContain('sh600276')
  })
})
