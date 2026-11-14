/**
 * MAC 通道与资金流：板块、异动、资金流、竞价点。
 *
 * 由 `shared/types.ts` 门面统一再导出；外部一律 `from '@shared/types'`。
 */
import type { Market } from './market'
/** 0x0ffc 资金流日记录；接口固定最近 5 个交易日 */
export interface MacBoard {
  market: number
  code: string
  name: string
  price: number
  riseSpeed: number
  preClose: number
  leaderMarket: number
  leaderCode: string
  leaderName: string
  leaderPrice: number
  leaderRiseSpeed: number
  leaderPreClose: number
  type: number
}

export interface MacUnusualItem {
  market: Market
  code: string
  symbol: string
  name: string
  time: string
  desc: string
  value: string
  type: number
  index: number
}

export interface MacMoneyFlow {
  mainIn: number
  mainOut: number
  mainNet: number
  retailIn: number
  retailOut: number
  retailNet: number
  largeNet5d: number
  midNet5d: number
  receivedAt: number
}

/** 批量资金流（0x1218）返回的一行；code 由批量命令补上。 */
export interface MacMoneyFlowPoint extends MacMoneyFlow {
  code: string
}

export interface MoneyFlowRecord {
  code: string
  market: Market
  symbol: string
  date: string
  totalAmount: number
  buckets: number[]
  mainNet: number
  mainRatio: number
  mainBuyNet: number
  mainBuyRatio: number
  mainSuperLargeNet: number
  mainLargeNet: number
  mainMediumNet: number
  mainSmallNet: number
  mainBuySuperLargeNet: number
  mainBuyLargeNet: number
  mainBuyMediumNet: number
  mainBuySmallNet: number
}
