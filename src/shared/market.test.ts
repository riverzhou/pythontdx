import { describe, expect, it } from 'vitest'
import {
  inferMarket,
  isIndexCode,
  joinCode,
  marketSession,
  IDLE_POLL_MIN_MS,
  msUntilSessionChange,
  normalizeCode,
  pollDelayMs,
  shanghaiClock,
  splitCode
} from './market'

describe('splitCode', () => {
  it('拆出市场与代码', () => {
    expect(splitCode('sh600519')).toEqual({ market: 'SH', symbol: '600519' })
    expect(splitCode('SZ300750')).toEqual({ market: 'SZ', symbol: '300750' })
    expect(splitCode('hk00700')).toEqual({ market: 'HK', symbol: '00700' })
  })

  it('没有前缀时市场为 UNKNOWN，但代码保留', () => {
    expect(splitCode('600519')).toEqual({ market: 'UNKNOWN', symbol: '600519' })
  })
})

describe('inferMarket', () => {
  it('5 位数字是港股', () => {
    expect(inferMarket('00700')).toBe('HK')
  })

  it('6 位数字按前缀分流', () => {
    expect(inferMarket('600519')).toBe('SH') // 沪市主板
    expect(inferMarket('688981')).toBe('SH') // 科创板
    expect(inferMarket('300750')).toBe('SZ') // 创业板
    expect(inferMarket('002594')).toBe('SZ') // 深市主板
    expect(inferMarket('000858')).toBe('SZ')
  })

  it('北交所前缀', () => {
    expect(inferMarket('430047')).toBe('BJ')
    expect(inferMarket('830799')).toBe('BJ')
    expect(inferMarket('920001')).toBe('BJ')
  })

  it('000xxx 一律按深市股票解释（回归测试）', () => {
    // 曾经的 bug：把「000 开头且非 000001」当成沪市，导致五粮液被判成沪市
    expect(inferMarket('000001')).toBe('SZ') // 平安银行
    expect(inferMarket('000858')).toBe('SZ') // 五粮液
    expect(inferMarket('000002')).toBe('SZ') // 万科A
  })

  it('指数必须显式带前缀，不能靠数字猜', () => {
    expect(normalizeCode('sh000001')).toBe('sh000001') // 上证指数
    expect(normalizeCode('sh000300')).toBe('sh000300') // 沪深300
    // 不带前缀时按股票解释
    expect(normalizeCode('000300')).toBe('sz000300')
  })

  it('字母代码视为美股', () => {
    expect(inferMarket('AAPL')).toBe('US')
  })
})

describe('normalizeCode', () => {
  it('纯数字补全市场前缀', () => {
    expect(normalizeCode('600519')).toBe('sh600519')
    expect(normalizeCode('300750')).toBe('sz300750')
    expect(normalizeCode('00700')).toBe('hk00700')
  })

  it('已带前缀的原样返回（统一小写）', () => {
    expect(normalizeCode('SH600519')).toBe('sh600519')
    expect(normalizeCode(' hk00700 ')).toBe('hk00700')
  })

  it('无法识别时返回 null', () => {
    expect(normalizeCode('')).toBeNull()
    expect(normalizeCode('茅台')).toBeNull()
    expect(normalizeCode('123')).toBeNull()
  })
})

describe('isIndexCode', () => {
  it('沪市 000/999/880/881 是指数', () => {
    expect(isIndexCode('sh000001')).toBe(true) // 上证指数
    expect(isIndexCode('sh000300')).toBe(true) // 沪深300
    expect(isIndexCode('sh880471')).toBe(true) // 板块指数
    expect(isIndexCode('sh999999')).toBe(true)
  })

  it('深市 399 是指数，其余不是', () => {
    expect(isIndexCode('sz399001')).toBe(true) // 深证成指
    expect(isIndexCode('sz399006')).toBe(true) // 创业板指
    expect(isIndexCode('sz000001')).toBe(false) // 平安银行
    expect(isIndexCode('sz300750')).toBe(false)
  })

  it('同号不同市场不能串：sh000001 是指数，sz000001 是股票', () => {
    expect(isIndexCode('sh000001')).toBe(true)
    expect(isIndexCode('sz000001')).toBe(false)
  })

  it('普通股票与无前缀代码都返回 false', () => {
    expect(isIndexCode('sh600519')).toBe(false)
    expect(isIndexCode('bj430047')).toBe(false)
    expect(isIndexCode('000001')).toBe(false)
  })
})

describe('joinCode', () => {
  it('与 splitCode 互为逆运算', () => {
    const { market, symbol } = splitCode('sh600519')
    expect(joinCode(market, symbol)).toBe('sh600519')
  })
})

describe('marketSession（A 股交易时段）', () => {
  // 2026-09-21 是周一
  const at = (iso: string): Date => new Date(iso)

  it('集合竞价 09:15–09:30', () => {
    expect(marketSession(at('2026-09-21T01:20:00Z'))).toBe('pre-open')
  })

  it('上午连续竞价 09:30–11:30', () => {
    expect(marketSession(at('2026-09-21T01:30:00Z'))).toBe('trading')
    expect(marketSession(at('2026-09-21T03:29:00Z'))).toBe('trading')
  })

  it('午间休市 11:30–13:00', () => {
    expect(marketSession(at('2026-09-21T03:30:00Z'))).toBe('lunch-break')
    expect(marketSession(at('2026-09-21T04:59:00Z'))).toBe('lunch-break')
  })

  it('下午连续竞价 13:00–15:00', () => {
    expect(marketSession(at('2026-09-21T05:00:00Z'))).toBe('trading')
    expect(marketSession(at('2026-09-21T07:00:00Z'))).toBe('trading')
  })

  it('15:00 之后是已收盘', () => {
    expect(marketSession(at('2026-09-21T07:01:00Z'))).toBe('closed')
  })

  it('开盘前是已收盘', () => {
    expect(marketSession(at('2026-09-21T01:00:00Z'))).toBe('closed')
    expect(marketSession(at('2026-09-21T00:00:00Z'))).toBe('closed')
  })

  it('周末休市（2026-09-26 是周六）', () => {
    expect(marketSession(at('2026-09-26T02:00:00Z'))).toBe('weekend')
    expect(marketSession(at('2026-09-27T02:00:00Z'))).toBe('weekend')
  })

  it('判断结果与运行机器的时区无关（内部固定用东八区）', () => {
    // 同一时刻用 UTC 与东八区字符串表达，结果必须一致
    expect(marketSession(new Date('2026-09-21T02:00:00Z'))).toBe(
      marketSession(new Date('2026-09-21T10:00:00+08:00'))
    )
  })
})

describe('shanghaiClock（主界面北京时间）', () => {
  it('固定按东八区输出日期、时间与星期', () => {
    const clock = shanghaiClock(new Date('2026-11-03T04:34:05Z'))
    expect(clock.time).toBe('12:34:05')
    expect(clock.date).toBe('2026-11-03')
    expect(clock.weekday).toBe('周二')
    expect(clock.session).toBe('lunch-break')
    expect(clock.sessionLabel).toBe('午间休市')
    expect(clock.trading).toBe(false)
  })

  it('集合竞价与连续竞价标记为 trading', () => {
    expect(shanghaiClock(new Date('2026-11-03T01:20:00Z')).trading).toBe(true)
    expect(shanghaiClock(new Date('2026-11-03T02:00:00Z')).session).toBe('trading')
  })

  it('午夜不能显示成 24 点', () => {
    const clock = shanghaiClock(new Date('2026-11-02T16:00:01Z'))
    expect(clock.time).toBe('00:00:01')
    expect(clock.date).toBe('2026-11-03')
  })
})

describe('pollDelayMs（桌面与 Web 共用降频规则）', () => {
  it('交易时段保持用户设置的间隔', () => {
    expect(pollDelayMs(1000, new Date('2026-11-02T02:00:00Z'))).toBe(1000)
    expect(pollDelayMs(3000, new Date('2026-11-02T02:00:00Z'))).toBe(3000)
  })

  it('午休/收盘放大 10 倍，且不低于 30 秒', () => {
    expect(pollDelayMs(1000, new Date('2026-11-02T04:00:00Z'))).toBe(IDLE_POLL_MIN_MS)
    expect(pollDelayMs(5000, new Date('2026-11-02T04:00:00Z'))).toBe(50_000)
    expect(pollDelayMs(1000, new Date('2026-11-02T08:00:00Z'))).toBe(IDLE_POLL_MIN_MS)
  })

  it('周末按休市降频', () => {
    expect(pollDelayMs(1000, new Date('2026-11-07T02:00:00Z'))).toBe(IDLE_POLL_MIN_MS)
  })
})

describe('msUntilSessionChange（定时器对齐交易时段）', () => {
  it('午休末尾会精确对齐 13:00', () => {
    // 2026-11-02 是周一，12:59:30 北京时间 = 04:59:30Z
    expect(msUntilSessionChange(new Date('2026-11-02T04:59:30Z'))).toBe(30_000)
  })

  it('刚跨过边界时返回 0，低频等待只多等 250ms 就恢复', () => {
    expect(msUntilSessionChange(new Date('2026-11-02T03:30:00Z'))).toBe(0)
  })

  it('临近边界不足 500ms 也要返回，不能跳过', () => {
    expect(msUntilSessionChange(new Date('2026-11-02T04:59:59.600Z'))).toBe(400)
  })

  it('收盘后跨过周末指向周一 09:15', () => {
    // 2026-11-06 周五 15:30 北京时间 = 07:30Z；下一个边界是周一 09:15
    const ms = msUntilSessionChange(new Date('2026-11-06T07:30:00Z'))
    expect(ms).toBe((2 * 24 + 17 + 45 / 60) * 60 * 60_000)
  })

  it('开盘前 1 秒指向 09:15', () => {
    expect(msUntilSessionChange(new Date('2026-11-02T01:14:59Z'))).toBe(1000)
  })
})
