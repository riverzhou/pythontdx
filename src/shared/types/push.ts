/**
 * 推送：行情帧与面板级推送任务。
 *
 * 由 `shared/types.ts` 门面统一再导出；外部一律 `from '@shared/types'`。
 */
import type { KLineAdjust, KLinePeriod, Quote } from './market'
/** 主进程推送的一帧行情更新 */
export interface QuoteUpdate {
  /** 本次拉到的行情；失败时为空数组 */
  quotes: Quote[]
  /** 本地生成时间（epoch ms） */
  at: number
  /** 本次拉取失败时的原因（此时 quotes 为空，渲染层应保留上一帧数据） */
  error?: string
}

/**
 * 面板级推送任务。
 *
 * 上游 0x0547 已实测为快照，不能做真正的服务端推送；1.8 起由 Python
 * PushManager 持有订阅并通过 `/api/push` SSE 推给渲染层，界面组件不再
 * 各自 setInterval。任务只描述「要什么数据」，调度在服务端统一完成。
 */
export type PushTask =
  | {
      kind: 'category'
      category: number
      sortType: number
      start: number
      count: number
      ascending?: boolean
    }
  | { kind: 'ticks'; code: string; date?: string; start?: number; count?: number }
  | { kind: 'auction'; code: string; date?: string }
  | { kind: 'moneyFlow'; code: string }
  | { kind: 'kline'; code: string; period: KLinePeriod; count: number; adjust: KLineAdjust }
  | { kind: 'minute'; code: string }
  | { kind: 'fiveDay'; code: string }

/** 主进程推给某个面板订阅的一帧数据 */
export interface PushUpdate {
  id: number
  at: number
  task: PushTask
  data?: unknown
  error?: string
}

/* ------------------------------------------------------------------ 状态 */
