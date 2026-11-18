import { describe, expect, it } from 'vitest'
import type { Quote } from '@shared/types'
import { compareSortValues, nextSort, quoteSortValue, sortIndicator, sortRows } from './table-sort'

/** 只填排序会用到的字段，其余留空不影响用例 */
function quoteOf(code: string, fields: Partial<Quote>): Quote {
  return { code, symbol: code.slice(2), name: code, market: 'SH', ...fields } as Quote
}

describe('表头排序状态', () => {
  it('第一次点某列用该列的默认方向', () => {
    expect(nextSort(null, 'change')).toEqual({ key: 'change', dir: 'desc' })
    expect(nextSort(null, 'name', 'asc')).toEqual({ key: 'name', dir: 'asc' })
  })

  it('同一列再点一次翻转方向，不会停在「没排序」', () => {
    const once = nextSort(null, 'change')
    const twice = nextSort(once, 'change')
    const thrice = nextSort(twice, 'change')
    expect(twice).toEqual({ key: 'change', dir: 'asc' })
    expect(thrice).toEqual({ key: 'change', dir: 'desc' })
  })

  it('换列时丢掉上一列的方向，重新按默认方向开始', () => {
    const byChange = nextSort(null, 'change')
    const byChangeAsc = nextSort(byChange, 'change')
    expect(nextSort(byChangeAsc, 'amount')).toEqual({ key: 'amount', dir: 'desc' })
  })

  it('只有当前列才有排序指示', () => {
    const state = { key: 'amount', dir: 'asc' } as const
    expect(sortIndicator(state, 'amount')).toBe('asc')
    expect(sortIndicator(state, 'change')).toBeNull()
    expect(sortIndicator(null, 'amount')).toBeNull()
  })
})

describe('单值比较', () => {
  it('数值按大小', () => {
    expect(compareSortValues(1, 2)).toBeLessThan(0)
    expect(compareSortValues(2, 1)).toBeGreaterThan(0)
    expect(compareSortValues(1, 1)).toBe(0)
  })

  it('缺值排最后，且 NaN 也算缺值', () => {
    expect(compareSortValues(undefined, 1)).toBeGreaterThan(0)
    expect(compareSortValues(1, undefined)).toBeLessThan(0)
    expect(compareSortValues(Number.NaN, 1)).toBeGreaterThan(0)
    expect(compareSortValues(null, undefined)).toBe(0)
  })

  it('中文名称按拼音而不是码点', () => {
    // 「安庆」在拼音序里排在「比亚迪」前面；按 UTF-16 码点也是这个结果，
    // 所以再验一组码点序相反的：安(5B89) > 北(5317) 但拼音 an < bei
    expect(compareSortValues('安庆', '北方稀土')).toBeLessThan(0)
    expect(compareSortValues('北方稀土', '安庆')).toBeGreaterThan(0)
  })

  it('带数字的文本按数值大小比较', () => {
    expect(compareSortValues('第2组', '第10组')).toBeLessThan(0)
  })
})

describe('整表排序', () => {
  const rows = [
    quoteOf('sh600001', { changePct: 1.2, turnoverRate: 3, name: '比亚迪' }),
    quoteOf('sh600002', { changePct: -4.5, turnoverRate: undefined, name: '安庆' }),
    quoteOf('sh600003', { changePct: 9.9, turnoverRate: 1, name: '中芯国际' })
  ]

  it('数值列降序 = 从大到小', () => {
    const sorted = sortRows(rows, { key: 'change', dir: 'desc' }, (row, key) =>
      quoteSortValue(row, key as 'change')
    )
    expect(sorted.map((row) => row.code)).toEqual(['sh600003', 'sh600001', 'sh600002'])
  })

  it('数值列升序 = 从小到大', () => {
    const sorted = sortRows(rows, { key: 'change', dir: 'asc' }, (row, key) =>
      quoteSortValue(row, key as 'change')
    )
    expect(sorted.map((row) => row.code)).toEqual(['sh600002', 'sh600001', 'sh600003'])
  })

  it('缺值在升序里也沉底（停牌股不该霸占榜首）', () => {
    const sorted = sortRows(rows, { key: 'turnover', dir: 'asc' }, (row, key) =>
      quoteSortValue(row, key as 'turnover')
    )
    expect(sorted.map((row) => row.code)).toEqual(['sh600003', 'sh600001', 'sh600002'])
  })

  it('缺值在降序里同样沉底', () => {
    const sorted = sortRows(rows, { key: 'turnover', dir: 'desc' }, (row, key) =>
      quoteSortValue(row, key as 'turnover')
    )
    expect(sorted.map((row) => row.code)).toEqual(['sh600001', 'sh600003', 'sh600002'])
  })

  it('相等值保持原有相对顺序（稳定排序）', () => {
    const same = [
      quoteOf('sh600010', { changePct: 1 }),
      quoteOf('sh600011', { changePct: 1 }),
      quoteOf('sh600012', { changePct: 1 })
    ]
    const sorted = sortRows(same, { key: 'change', dir: 'desc' }, (row, key) =>
      quoteSortValue(row, key as 'change')
    )
    expect(sorted.map((row) => row.code)).toEqual(['sh600010', 'sh600011', 'sh600012'])
  })

  it('不改入参：原数组顺序原样保留', () => {
    const before = rows.map((row) => row.code)
    sortRows(rows, { key: 'change', dir: 'asc' }, (row, key) =>
      quoteSortValue(row, key as 'change')
    )
    expect(rows.map((row) => row.code)).toEqual(before)
  })

  it('没有排序时原样返回一份副本', () => {
    const sorted = sortRows(rows, null, () => undefined)
    expect(sorted.map((row) => row.code)).toEqual(rows.map((row) => row.code))
    expect(sorted).not.toBe(rows)
  })
})

describe('报价取值', () => {
  const quote = quoteOf('sh600519', {
    price: 1680,
    changePct: 0.35,
    amount: 1.2e9,
    turnoverRate: 0.42,
    volumeRatio: 1.18,
    riseSpeed: -0.06
  })

  it('六个数值列各取各的字段', () => {
    expect(quoteSortValue(quote, 'price')).toBe(1680)
    expect(quoteSortValue(quote, 'change')).toBe(0.35)
    expect(quoteSortValue(quote, 'amount')).toBe(1.2e9)
    expect(quoteSortValue(quote, 'turnover')).toBe(0.42)
    expect(quoteSortValue(quote, 'volume')).toBe(1.18)
    expect(quoteSortValue(quote, 'speed')).toBe(-0.06)
  })

  it('报价还没回来时返回 undefined（由 sortRows 沉底）', () => {
    expect(quoteSortValue(undefined, 'change')).toBeUndefined()
    expect(quoteSortValue(quoteOf('sz000001', {}), 'turnover')).toBeUndefined()
  })
})
