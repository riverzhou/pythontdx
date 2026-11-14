import { describe, expect, it } from 'vitest'
import { sparklineTone, toneColorVar, toneLineVar, toneOf, toneVsPrevClose } from './tone'

describe('toneOf', () => {
  it('正数涨、负数跌、零与无效值一律平', () => {
    expect(toneOf(1)).toBe('up')
    expect(toneOf(-1)).toBe('down')
    expect(toneOf(0)).toBe('flat')
    expect(toneOf(null)).toBe('flat')
    expect(toneOf(undefined)).toBe('flat')
    expect(toneOf(NaN)).toBe('flat')
    expect(toneOf(Infinity)).toBe('flat')
  })
})

describe('toneVsPrevClose（行情头那一排指标）', () => {
  it('今开/最高/最低/均价一律以昨收为基准', () => {
    expect(toneVsPrevClose(101, 100)).toBe('up')
    expect(toneVsPrevClose(99, 100)).toBe('down')
    expect(toneVsPrevClose(100, 100)).toBe('flat')
  })

  it('跳空低开一整天：最高仍在昨收之下 → 绿，不能硬编码成红', () => {
    // 昨收 100，全天最高 97、最低 92：两个数相对昨收都是跌
    expect(toneVsPrevClose(97, 100)).toBe('down')
    expect(toneVsPrevClose(92, 100)).toBe('down')
  })

  it('跳空高开一整天：最低仍在昨收之上 → 红', () => {
    expect(toneVsPrevClose(105, 100)).toBe('up')
  })

  it('缺值 / 昨收无效时给平，不抛异常', () => {
    expect(toneVsPrevClose(undefined, 100)).toBe('flat')
    expect(toneVsPrevClose(NaN, 100)).toBe('flat')
    expect(toneVsPrevClose(101, 0)).toBe('flat')
  })
})

describe('颜色变量映射', () => {
  it('文字色与折线色各自对应正确的令牌', () => {
    expect(toneColorVar('up')).toBe('var(--up)')
    expect(toneLineVar('up')).toBe('var(--up-line)')
    expect(toneLineVar('down')).toBe('var(--down-line)')
    expect(toneLineVar('flat')).toBe('var(--flat)')
  })
})

describe('sparklineTone（迷你走势图线色）', () => {
  it('给定昨收时，颜色只取决于「现价 vs 昨收」', () => {
    // 高开回落：日内从 110 跌到 105，但昨收 100 → 相对昨收仍是涨
    const values = [110, 108, 105]
    expect(sparklineTone(values, 100)).toBe('up')
    // 若错误地用「末点 vs 首点」就会得到 down —— 这正是要避免的自相矛盾
    expect(sparklineTone(values)).toBe('down')
  })

  it('低开高走：日内涨但仍在昨收之下 → 绿', () => {
    const values = [95, 97, 99]
    expect(sparklineTone(values, 100)).toBe('down')
    expect(sparklineTone(values)).toBe('up')
  })

  it('现价等于昨收时为平', () => {
    expect(sparklineTone([100, 105, 100], 100)).toBe('flat')
  })

  it('没有昨收时退化为「末点 vs 首点」', () => {
    expect(sparklineTone([100, 110])).toBe('up')
    expect(sparklineTone([110, 100])).toBe('down')
  })

  it('只有一个点且没有基准时视为平', () => {
    expect(sparklineTone([100])).toBe('flat')
  })

  it('空数组返回平，不抛异常', () => {
    expect(sparklineTone([], 100)).toBe('flat')
  })
})
