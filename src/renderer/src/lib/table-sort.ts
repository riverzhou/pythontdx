/**
 * 股票列表排序：全市场 / 板块 / 排行榜三张表唯一的一份实现。
 *
 * 为什么抽出来：表头点击排序最容易走样——每张表各写一遍比较函数，
 * 就会出现「涨幅升序把停牌股排到最前」「名称按 UTF-16 码点排、不是按拼音」
 * 「同一列在三张表里第一次点击方向不同」这类肉眼难查的不一致。
 * 这里只暴露三件事：点表头怎么翻方向（`nextSort`）、单值怎么比（`compareSortValues`）、
 * 整表怎么排（`sortRows`）。
 *
 * 两条硬约定：
 *  1. **缺值永远沉底**，不随升降序翻转。停牌、未加载、数据源没给的股票
 *     不该因为点了「升序」就霸占榜首。
 *  2. 文本按中文本地化比较（`localeCompare`），中文名称才是拼音序而不是码点序。
 */
import type { Quote } from '@shared/types'

export type SortDir = 'asc' | 'desc'

export interface SortState {
  /** 列标识，与表头的 `data-sort` 对应 */
  key: string
  dir: SortDir
}

export type SortValue = number | string | null | undefined

/**
 * 点表头：同一列切换升降序，换列用该列自己的首次方向。
 * 数值列一般先看最大的（`desc`），代码/名称这种文本列先看最小的（`asc`）。
 */
export function nextSort(
  current: SortState | null,
  key: string,
  firstDir: SortDir = 'desc'
): SortState {
  if (current?.key === key) return { key, dir: current.dir === 'desc' ? 'asc' : 'desc' }
  return { key, dir: firstDir }
}

/** 该列当前的排序方向；没排这一列返回 null（表头据此画不画箭头） */
export function sortIndicator(current: SortState | null, key: string): SortDir | null {
  return current?.key === key ? current.dir : null
}

/** 缺值判定：undefined / null / NaN 都算没有值 */
function missing(value: SortValue): boolean {
  if (value === null || value === undefined) return true
  return typeof value === 'number' && !Number.isFinite(value)
}

/**
 * 单值比较，升序语义：缺值排最后，数值按大小，文本按中文（拼音）序。
 * `sortRows` 会自己处理方向与缺值，导出它主要是为了能单测。
 */
export function compareSortValues(a: SortValue, b: SortValue): number {
  const aMissing = missing(a)
  const bMissing = missing(b)
  if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true })
}

/**
 * 按 `state` 排一份新数组（不改入参）。`state` 为 null 时保持原顺序。
 * `value` 从行里取当前列的原始值，取不到就返回 undefined（沉底）。
 */
export function sortRows<T>(
  rows: readonly T[],
  state: SortState | null,
  value: (row: T, key: string) => SortValue
): T[] {
  const copy = [...rows]
  if (!state) return copy
  const { key, dir } = state
  return copy.sort((left, right) => {
    const a = value(left, key)
    const b = value(right, key)
    const order = compareSortValues(a, b)
    // 缺值那一侧的方向固定为「沉底」，不跟着 asc/desc 翻转
    if (missing(a) || missing(b)) return order
    return dir === 'asc' ? order : -order
  })
}

/** 三张股票表共用的数值列（代码/名称之外） */
export type QuoteSortKey = 'price' | 'change' | 'amount' | 'turnover' | 'volume' | 'speed'

/** 取报价里某一列的可比较值；该字段缺失时返回 undefined，交给 `sortRows` 沉底 */
export function quoteSortValue(quote: Quote | undefined, key: QuoteSortKey): number | undefined {
  if (!quote) return undefined
  if (key === 'price') return quote.price
  if (key === 'change') return quote.changePct
  if (key === 'amount') return quote.amount
  if (key === 'turnover') return quote.turnoverRate
  if (key === 'volume') return quote.volumeRatio
  return quote.riseSpeed
}
