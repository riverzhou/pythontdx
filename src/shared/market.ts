/**
 * 市场相关的纯函数：代码归一化、市场推断、交易时段判断。
 * 不依赖任何运行时 API，主进程与渲染进程共用。
 */
import type { Market, MarketCalendarStatus } from './types'

/** 各市场代码前缀 → 市场 */
const PREFIX_TO_MARKET: Record<string, Market> = {
  sh: 'SH',
  sz: 'SZ',
  bj: 'BJ',
  hk: 'HK',
  us: 'US'
}

export const MARKET_TO_PREFIX: Record<Market, string> = {
  SH: 'sh',
  SZ: 'sz',
  BJ: 'bj',
  HK: 'hk',
  US: 'us',
  UNKNOWN: ''
}

/** 把 'sh600519' 拆成 { market: 'SH', symbol: '600519' } */
export function splitCode(code: string): { market: Market; symbol: string } {
  const trimmed = code.trim().toLowerCase()
  const prefix = trimmed.slice(0, 2)
  const market = PREFIX_TO_MARKET[prefix]
  if (market) {
    return { market, symbol: trimmed.slice(2) }
  }
  return { market: 'UNKNOWN', symbol: trimmed }
}

/** 拼回标准代码 */
export function joinCode(market: Market, symbol: string): string {
  return `${MARKET_TO_PREFIX[market]}${symbol}`
}

/**
 * 根据纯数字代码推断市场。
 *
 * 有一个绕不开的歧义：`000xxx` 既可能是深市主板股票（000001 平安银行、
 * 000858 五粮液），也可能是上证系列指数（000001 上证指数、000300 沪深300）。
 * 因为绝大多数 000xxx 都是股票，这里**一律按深市股票解释**；
 * 要查指数请显式带上前缀，例如 `sh000001`。
 *
 * （这个规则是被单元测试逼出来的：最初写了「000 开头且非 000001 就当沪市」，
 *   结果把五粮液 000858 判成了沪市。）
 */
export function inferMarket(symbol: string): Market {
  const s = symbol.trim()
  if (!/^\d+$/.test(s)) return 'US'
  if (s.length === 5) return 'HK'
  if (s.length === 6) {
    // 北交所：43 / 83 / 87 / 88 / 92 开头
    if (/^(43|83|87|88|92)/.test(s)) return 'BJ'
    // 沪市：60 主板 / 68 科创板 / 90 B股 / 11 可转债 / 5x 基金
    if (/^(60|68|90|11|50|51|52|56|58)/.test(s)) return 'SH'
    // 其余归深市：00 主板 / 30 创业板 / 20 B股 / 15|16|18 基金 / 12 可转债 / 39 指数
    return 'SZ'
  }
  return 'UNKNOWN'
}

/** 用户输入 → 标准代码；无法识别时返回 null */
export function normalizeCode(input: string): string | null {
  const raw = input.trim().toLowerCase().replace(/\s+/g, '')
  if (!raw) return null

  // 已经带前缀
  if (/^(sh|sz|bj|hk|us)\d{4,6}$/.test(raw)) return raw

  // 纯数字
  if (/^\d{5,6}$/.test(raw)) {
    const market = inferMarket(raw)
    return market === 'UNKNOWN' ? null : joinCode(market, raw)
  }

  return null
}

/** 该市场是否适用 A 股的「红涨绿跌」配色（港股/美股习惯相反，本 App 统一按用户所在市场惯例） */
export function isRedUpMarket(market: Market): boolean {
  return market === 'SH' || market === 'SZ' || market === 'BJ' || market === 'HK'
}

/**
 * 是否指数代码（规则与 Python 侧 `is_index_code` 保持一致）。
 *
 * 必须带市场前缀判断：`sh000001` 是上证指数，`sz000001` 是平安银行，
 * 只看数字前缀一定会串。指数没有分红送转，所以「除权」相关的请求与标记
 * 都要先过这一关 —— 否则 7615 的 F10 接口只按 6 位 symbol 查，会把
 * `sh000001` 当成 `000001` 返回平安银行的分红数据（2026-11-01 实测）。
 */
export function isIndexCode(code: string): boolean {
  const { market, symbol } = splitCode(code)
  if (market === 'SH') return /^(000|999|880|881)/.test(symbol)
  if (market === 'SZ') return symbol.startsWith('399')
  if (market === 'BJ') return symbol.startsWith('899')
  return false
}

/* ------------------------------------------------------------ 交易时段 */

const SHANGHAI_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
})

export type MarketSession =
  | 'pre-open'
  | 'trading'
  | 'lunch-break'
  | 'closed'
  | 'weekend'
  | 'holiday'

export const SESSION_LABEL: Record<MarketSession, string> = {
  'pre-open': '集合竞价',
  trading: '交易中',
  'lunch-break': '午间休市',
  closed: '已收盘',
  weekend: '周末休市',
  holiday: '节假日休市'
}

const WEEKDAY_LABEL: Record<string, string> = {
  Mon: '周一',
  Tue: '周二',
  Wed: '周三',
  Thu: '周四',
  Fri: '周五',
  Sat: '周六',
  Sun: '周日'
}

/**
 * 通达信交易日历状态（由 Python `market_status` 提供）。
 *
 * 前端仍保留纯时钟函数，但节假日必须以 TDX 的今天/最近交易日为准；
 * 状态每 5 分钟刷新一次，更新后所有组件共用同一份。
 */
let marketCalendar: MarketCalendarStatus | null = null
let marketHolidays = new Set<string>()

export function setMarketCalendarStatus(status: MarketCalendarStatus | null): void {
  marketCalendar = status
  marketHolidays = new Set(status?.holidays ?? [])
}

export function currentMarketCalendarStatus(): MarketCalendarStatus | null {
  return marketCalendar
}

/** 当前日期被 TDX 明确判为休市（周末另判）。 */
function isCalendarHoliday(date: string, weekday: number): boolean {
  if (weekday === 0 || weekday === 6) return false
  if (marketHolidays.has(date)) return true
  if (!marketCalendar || marketCalendar.today !== date) return false
  return !marketCalendar.isTradingDay
}

export interface ShanghaiClock {
  /** 北京时间 HH:MM:SS（24 小时制） */
  time: string
  /** 北京时间 YYYY-MM-DD */
  date: string
  /** 周一 ~ 周日 */
  weekday: string
  session: MarketSession
  sessionLabel: string
  /** 集合竞价或连续竞价，界面上用这个决定是否显示实时脉冲 */
  trading: boolean
}

/**
 * 主界面时钟：行情软件的时间必须按交易所所在时区显示，不能跟着系统时区漂。
 * 每秒渲染一次，纯函数便于测试。
 */
export function shanghaiClock(now: Date = new Date()): ShanghaiClock {
  const parts = SHANGHAI_PARTS.formatToParts(now)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  const hour = String(Number(get('hour')) % 24).padStart(2, '0')
  const minute = get('minute')
  const second = get('second')
  const session = marketSession(now)
  return {
    time: `${hour}:${minute}:${second}`,
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: WEEKDAY_LABEL[get('weekday')] ?? get('weekday'),
    session,
    sessionLabel: SESSION_LABEL[session],
    trading: session === 'trading' || session === 'pre-open'
  }
}

/**
 * 判断 A 股当前所处的时段。
 *
 * 周末与时钟是本地纯函数；节假日来自 Python `market_status` 的 TDX 日历状态，
 * 未加载时按工作日兜底，加载后返回 `holiday`（「节假日休市」）。
 */
export function marketSession(now: Date = new Date()): MarketSession {
  const parts = SHANGHAI_PARTS.formatToParts(now)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  const weekday = get('weekday')
  const hour = Number(get('hour')) % 24
  const minute = Number(get('minute'))
  const hm = hour * 60 + minute
  const date = `${get('year')}-${get('month')}-${get('day')}`
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday)

  if (weekday === 'Sat' || weekday === 'Sun') return 'weekend'
  if (isCalendarHoliday(date, weekdayIndex)) return 'holiday'
  if (hm >= 9 * 60 + 15 && hm < 9 * 60 + 30) return 'pre-open'
  if (hm >= 9 * 60 + 30 && hm < 11 * 60 + 30) return 'trading'
  if (hm >= 11 * 60 + 30 && hm < 13 * 60) return 'lunch-break'
  if (hm >= 13 * 60 && hm <= 15 * 60) return 'trading'
  return 'closed'
}

/** Asia/Shanghai 自 1991 年起不再使用夏令时，固定 +08:00 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const SESSION_BOUNDARIES: ReadonlyArray<readonly [number, number]> = [
  [9, 15],
  [9, 30],
  [11, 30],
  [13, 0],
  [15, 0]
]

/**
 * 距离下一次交易时段切换还有多久（毫秒）。
 *
 * 行情轮询在午休/收盘会降频到 30 秒；如果恰好在 12:59:30 之后进入低频，
 * 13:00 开盘可以被拖到 13:00:30 才恢复 1 秒推送。用它把定时器压在时段边界上。
 * 使用 TDX 交易日历跳过已确认的节假日；未来尚未确认的日期仍按工作日
 * 唤醒一次，等下一次 market_status 刷新后再修正。
 */
export function msUntilSessionChange(now: Date = new Date()): number {
  const shanghai = new Date(now.getTime() + SHANGHAI_OFFSET_MS)
  const year = shanghai.getUTCFullYear()
  const month = shanghai.getUTCMonth()
  const day = shanghai.getUTCDate()
  let best = Number.POSITIVE_INFINITY

  for (let offset = 0; offset < 40; offset += 1) {
    const date = new Date(Date.UTC(year, month, day + offset))
    const weekday = date.getUTCDay()
    if (weekday === 0 || weekday === 6) continue
    const dateText = date.toISOString().slice(0, 10)
    if (isCalendarHoliday(dateText, weekday)) continue
    for (const [hour, minute] of SESSION_BOUNDARIES) {
      const at = Date.UTC(year, month, day + offset, hour, minute) - SHANGHAI_OFFSET_MS
      const delta = at - now.getTime()
      // 不要跳过 0~500ms 的临近边界：轮询可能正好在 12:59:59.6 醒来，
      // 跳过它就会再等一个完整低频周期，13:00 的第一帧被拖后 30 秒。
      if (delta >= 0 && delta < best) best = delta
    }
  }

  return Number.isFinite(best) ? best : 24 * 60 * 60 * 1000
}

export function isTradingNow(now: Date = new Date()): boolean {
  const session = marketSession(now)
  return session === 'trading' || session === 'pre-open'
}

/** 非交易时段轮询下限：再快也没有新数据，还会被上游限流。 */
export const IDLE_POLL_MIN_MS = 30_000
/** 非交易时段相对用户设置间隔的放大倍数。 */
export const IDLE_POLL_SCALE = 10

/**
 * 行情轮询的有效间隔。
 *
 * 渲染层轮询降级用这一条规则；Python 的 SSE/WS 调度另有一份同规则实现
 * （`_quote_interval`），两处测试锁住。
 */
export function pollDelayMs(intervalMs: number, now: Date = new Date()): number {
  const requested = Math.max(1000, Math.trunc(intervalMs) || 3000)
  if (isTradingNow(now)) return requested
  return Math.max(requested * IDLE_POLL_SCALE, IDLE_POLL_MIN_MS)
}
