/**
 * F10 / 公告：段落目录、财务表、新闻与公告条目。
 *
 * 由 `shared/types.ts` 门面统一再导出；外部一律 `from '@shared/types'`。
 */
/** 0x02cf F10 段落目录 */
export interface F10Section {
  name: string
  filename: string
  start: number
  length: number
}

export interface F10ProfileTable {
  columns: string[]
  rows: Array<Array<string | number | null>>
  reportDate?: string
  template?: number
  kind?: string
  full?: boolean
}

export interface F10TradingTable {
  section: string
  rawColumns: string[]
  columns: string[]
  rows: Array<Array<string | number>>
  count: number
}

export interface F10NewsItem {
  id: string
  date: string
  title: string
  source: string
}

export interface F10Announcement {
  id: string
  date: string
  title: string
  type: string
  source: string
  url: string
}

/* --------------------------------------------------------------- 数据工具 */
