#!/usr/bin/env node
/**
 * 通达信行情协议探针（一次性脚本，不进生产代码）。
 *
 * 目的：在改 pythontdx 的数据源之前，先确认三件事：
 *   1. 本机网络能不能连上通达信行情主站（TCP 7709，二进制协议）；
 *   2. 五档行情 / 日K / 分时的字段与单位，跟现在用的腾讯接口对不对得上；
 *   3. 港股在 7709 主站上取不到（需要另一套 7727 扩展行情协议）。
 *
 * 协议实现参考 pytdx（MIT）：
 *   https://github.com/rainx/pytdx
 * 报文格式：16 字节响应头 + 可能 zlib 压缩的 body。
 *
 * 实测结论（2026-10-30，深圳/上海主站）：
 *   1. 握手只能发一条 0x000d（data=[0x01]）。pytdx 的 setup1/2/3 三连包会让
 *      服务端进入旧版会话，之后行情请求只回 4 字节空包 —— 这是最大的坑。
 *   2. 0x053e 五档批量单次最多 80 只；0x052d K 线单页最多 800 根。
 *   3. 0x052d 的 adjust=1 就是服务端前复权，与腾讯 qfq 逐根一致。
 *   4. 指数的五档字段是无效值，解析时要单独处理（K 线还要多读 4 字节）。
 *   5. 港股在 7709 上取不到（market=31 会返回错代码/错价），要走 7727 另一套协议。
 *   6. 全量代码表 52269 条约 763ms，可做本地搜索，但没有拼音。
 *
 * 用法：node scripts/probe-tdx.mjs（只需要 Node 内置模块）
 * 可选环境变量：
 *   TDX_SERVER=ip:port   指定主站（默认按 SERVERS 顺序尝试）
 *   TDX_ONLY=quote       只测行情命令
 *   TDX_ONLY=detail2     测北交所/周月K/指数/五日分时/财务/全量代码表
 *   DEBUG_TDX=1          打印收发报文
 */
import net from 'node:net'
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

/* ---------------------------------------------------------------- 主站列表 */

const SERVERS = process.env.TDX_SERVER
  ? [process.env.TDX_SERVER.split(':')]
  : [
      ['180.153.18.170', 7709],
      ['124.71.187.122', 7709],
      ['119.147.212.81', 7709],
      ['101.227.73.20', 7709],
      ['180.153.18.172', 7709]
    ]

const SETUP_PACKETS = [
  '0c0218930001030003000d0001',
  '0c0218940001030003000d0002',
  '0c031899000120002000db0fd5d0c9ccd6a4a8af0000008fc22540130000d500c9ccbdf0d7ea00000002'
]

/* ------------------------------------------------------------ 二进制读取器 */

/** 变长有符号整数：首字节 bit6 是符号，bit7 是「还有后续字节」 */
function readPrice(buf, pos) {
  let b = buf[pos]
  let value = b & 0x3f
  const negative = (b & 0x40) !== 0
  let shift = 6
  let p = pos + 1

  while (b & 0x80) {
    b = buf[p]
    value += (b & 0x7f) * 2 ** shift
    shift += 7
    p += 1
  }

  return [negative ? -value : value, p]
}

/**
 * 成交量/成交额用的是一种「压缩浮点」编码。
 * 这里改用 eltdx 的化简版实现（pytdx 的版本历史上有精度问题）：
 * 把 4 字节看成指数 + 三段尾数，再按 2 的幂拼回去。
 */
function decodeVolume(value) {
  if (value === 0) return 0
  const signed = value | 0
  const logpoint = signed >> 24
  const hleax = (signed >> 16) & 0xff
  const lheax = (signed >> 8) & 0xff
  const lleax = signed & 0xff

  const base = 2 ** (logpoint * 2 - 0x7f)
  const high = hleax > 0x80 ? (base * (64 + (hleax & 0x7f))) / 64 : (base * hleax) / 128
  const scale = hleax & 0x80 ? 2 : 1
  const middle = ((base * lheax) / 32768) * scale
  const low = ((base * lleax) / 8388608) * scale
  return base + high + middle + low
}

/** 6 位代码补齐到协议要求的 6 字节 */
function code6(code) {
  const buf = Buffer.alloc(6)
  buf.write(code, 0, 6, 'ascii')
  return buf
}

/* ---------------------------------------------------------------- 连接封装 */

class TdxConnection {
  #socket
  #inbox = Buffer.alloc(0)
  #waiters = []

  constructor(socket) {
    this.#socket = socket
    socket.setTimeout(8000)
    socket.on('timeout', () => socket.destroy(new Error('socket 读超时（8s）')))
    socket.on('data', (chunk) => {
      this.#inbox = Buffer.concat([this.#inbox, chunk])
      this.#pump()
    })
    socket.on('close', () => this.#fail(new Error('连接被服务器关闭')))
    socket.on('error', (err) => this.#fail(err))
  }

  static async open(host, port, timeoutMs = 5000) {
    const socket = net.createConnection({ host, port })
    socket.setNoDelay(true)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`连接 ${host}:${port} 超时`))
      }, timeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    return new TdxConnection(socket)
  }

  #pump() {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters[0]
      if (this.#inbox.length < waiter.size) return
      const chunk = this.#inbox.subarray(0, waiter.size)
      this.#inbox = this.#inbox.subarray(waiter.size)
      this.#waiters.shift()
      waiter.resolve(chunk)
    }
  }

  #fail(err) {
    for (const waiter of this.#waiters.splice(0)) waiter.reject(err)
  }

  read(size) {
    return new Promise((resolve, reject) => {
      this.#waiters.push({ size, resolve, reject })
      this.#pump()
    })
  }

  /** 发一包，读一包：16 字节头（含压缩前后长度）+ body */
  async request(payload) {
    if (process.env.DEBUG_TDX === '1') {
      console.log(`[调试] 发送 ${payload.length} 字节：${payload.toString('hex')}`)
    }
    this.#socket.write(payload)

    const header = await this.read(16)
    const zipSize = header.readUInt16LE(12)
    const unzipSize = header.readUInt16LE(14)
    if (process.env.DEBUG_TDX === '1') {
      console.log(`[调试] 响应头：${header.toString('hex')} zip=${zipSize} unzip=${unzipSize}`)
    }
    const raw = zipSize > 0 ? await this.read(zipSize) : Buffer.alloc(0)
    const body = zipSize === unzipSize ? raw : zlib.inflateSync(raw)

    return { header, body, zipSize, unzipSize }
  }

  async handshake(modernOnly = false) {
    let body
    if (modernOnly) {
      // 新版握手：只有 0x000d + data=[0x01]，响应 189 字节（含服务器名/交易时段）
      body = (await this.request(frame(1, 0x000d, Buffer.from([0x01])))).body
    } else {
      for (const hex of SETUP_PACKETS) {
        body = (await this.request(Buffer.from(hex, 'hex'))).body
      }
    }
    return parseHandshake(body)
  }

  close() {
    this.#socket.destroy()
  }
}

/* ------------------------------------------------------------------ 请求包 */

/**
 * 现代版请求帧：12 字节头 + data。
 * 注意：pytdx 里那套「把长度写进 22 字节头、代码直接跟在后面」是旧格式，
 * 现在的服务端会返回空数据 —— 2026 年的行情主站要求 data 里先放 8 字节前缀 + 数量。
 */
function frame(msgId, msgType, data) {
  const head = Buffer.alloc(12)
  head.writeUInt8(0x0c, 0)
  head.writeUInt32LE(msgId >>> 0, 1)
  head.writeUInt8(1, 5)
  head.writeUInt16LE(data.length + 2, 6)
  head.writeUInt16LE(data.length + 2, 8)
  head.writeUInt16LE(msgType, 10)
  return Buffer.concat([head, data])
}

/** 0x053e 旧版批量行情：8 字节前缀 + u16 数量 + (u8 市场 + 6 字节代码) */
function quoteRequest(stocks, msgType = 0x053e, msgId = 9) {
  const data = Buffer.alloc(10 + stocks.length * 7)
  Buffer.from([5, 0, 0, 0, 0, 0, 0, 0]).copy(data, 0)
  data.writeUInt16LE(stocks.length, 8)
  stocks.forEach(([market, code], i) => {
    data.writeUInt8(market, 10 + i * 7)
    code6(code).copy(data, 11 + i * 7)
  })
  return frame(msgId, msgType, data)
}

/** 0x052d K 线：u16 市场 + 6 代码 + 周期/参数/起点/数量/复权 + u32 锚点 + 20 字节保留 */
function barsRequest(market, code, category, start, count, adjust = 1) {
  const data = Buffer.alloc(42)
  data.writeUInt16LE(market, 0)
  code6(code).copy(data, 2)
  data.writeUInt16LE(category, 8)
  data.writeUInt16LE(1, 10)
  data.writeUInt16LE(start, 12)
  data.writeUInt16LE(count, 14)
  data.writeUInt16LE(adjust, 16)
  data.writeUInt32LE(0, 18)
  return frame(0x01016408, 0x052d, data)
}

/** 0x0537 当日分时：u16 市场 + 6 代码 + 4 字节保留（00 00 00 93） */
function minuteRequest(market, code) {
  const data = Buffer.alloc(12)
  data.writeUInt16LE(market, 0)
  code6(code).copy(data, 2)
  Buffer.from([0, 0, 0, 0x93]).copy(data, 8)
  return frame(0x00016408, 0x0537, data)
}

/** 0x0fb4 指定日期历史分时：u32 日期 + u8 市场 + 6 代码 */
function historyMinuteRequest(market, code, date) {
  const data = Buffer.alloc(11)
  data.writeUInt32LE(date, 0)
  data.writeUInt8(market, 4)
  code6(code).copy(data, 5)
  return frame(0x00016408, 0x0fb4, data)
}

function countRequest(market) {
  const data = Buffer.alloc(6)
  data.writeUInt16LE(market, 0)
  Buffer.from('75c73301', 'hex').copy(data, 2)
  return frame(0x00016c18, 0x044e, data)
}

/** 0x0547 增量刷新：u16 数量 + (u8 市场 + 6 代码 + u32 游标) */
function refreshRequest(stocks, msgId = 11) {
  const data = Buffer.alloc(2 + stocks.length * 11)
  data.writeUInt16LE(stocks.length, 0)
  stocks.forEach(([market, code], i) => {
    const at = 2 + i * 11
    data.writeUInt8(market, at)
    code6(code).copy(data, at + 1)
    data.writeUInt32LE(0, at + 7)
  })
  return frame(msgId, 0x0547, data)
}

/** 0x054b 分类行情：6 个 u16 参数 + 3 个 u16 保留 */
function categoryRequest(category = 6, count = 5) {
  const values = [category, 0, 0, count, 0, 5, 0, 1, 0]
  const data = Buffer.alloc(values.length * 2)
  values.forEach((value, i) => data.writeUInt16LE(value, i * 2))
  return frame(12, 0x054b, data)
}

function listRequest(market, start, limit = 100) {
  const data = Buffer.alloc(14)
  data.writeUInt16LE(market, 0)
  data.writeUInt32LE(start, 2)
  data.writeUInt32LE(limit, 6)
  return frame(0x00016418, 0x044d, data)
}

/** 0x0010 财务信息批量：u16 数量 + (u8 市场 + 6 代码)，记录定长 143 字节 */
function financeRequest(stocks, msgId = 13) {
  const data = Buffer.alloc(2 + stocks.length * 7)
  data.writeUInt16LE(stocks.length, 0)
  stocks.forEach(([market, code], i) => {
    data.writeUInt8(market, 2 + i * 7)
    code6(code).copy(data, 3 + i * 7)
  })
  return frame(msgId, 0x0010, data)
}

/* ------------------------------------------------------------------ 解析器 */

/** 握手响应：服务器时间、交易时段、主站名、产品标识（GBK） */
function parseHandshake(body) {
  if (!body || body.length < 189) return { name: '(空)', tag: '', date: '' }
  const year = body.readUInt16LE(1)
  const date =
    `${year}-${String(body[4]).padStart(2, '0')}-${String(body[3]).padStart(2, '0')} ` +
    `${String(body[6]).padStart(2, '0')}:${String(body[5]).padStart(2, '0')}:${String(body[8]).padStart(2, '0')}`
  const name = new TextDecoder('gbk').decode(body.subarray(68, 152)).replace(/\0+$/, '').trim()
  const tag = new TextDecoder('gbk').decode(body.subarray(160, 189)).replace(/\0+$/, '').trim()
  return { name, tag, date }
}

function debugBody(label, body) {
  if (process.env.DEBUG_TDX !== '1') return
  console.log(`[调试] ${label} bodyLen=${body.length} head=${body.subarray(0, 48).toString('hex')}`)
}

function parseQuotes(body) {
  debugBody('quotes', body)
  let pos = 2
  const count = body.readUInt16LE(pos)
  pos += 2
  const quotes = []

  for (let i = 0; i < count; i++) {
    const market = body[pos]
    const code = body.toString('ascii', pos + 1, pos + 7).replace(/\0+$/, '')
    const active1 = body.readUInt16LE(pos + 7)
    pos += 9

    const fields = {}
    const read = (name) => {
      const [value, next] = readPrice(body, pos)
      fields[name] = value
      pos = next
    }

    read('price')
    read('lastCloseDiff')
    read('openDiff')
    read('highDiff')
    read('lowDiff')
    read('timeRaw')
    read('reversed1')
    read('vol')
    read('curVol')
    const amountRaw = body.readUInt32LE(pos)
    pos += 4
    read('sVol')
    read('bVol')
    read('reversed2')
    read('reversed3')

    const levels = []
    for (let level = 0; level < 5; level++) {
      const bid = {}
      const ask = {}
      let v
      ;[v, pos] = readPrice(body, pos)
      bid.price = v
      ;[v, pos] = readPrice(body, pos)
      ask.price = v
      ;[v, pos] = readPrice(body, pos)
      bid.volume = v
      ;[v, pos] = readPrice(body, pos)
      ask.volume = v
      levels.push({ bid, ask })
    }

    pos += 2 // reversed_bytes4 (ushort)
    read('reversed5')
    read('reversed6')
    read('reversed7')
    read('reversed8')
    const speed = body.readInt16LE(pos)
    pos += 2
    const active2 = body.readUInt16LE(pos)
    pos += 2

    const price = fields.price / 100
    const base = price
    quotes.push({
      market,
      code,
      active1,
      price,
      lastClose: base + fields.lastCloseDiff / 100,
      open: base + fields.openDiff / 100,
      high: base + fields.highDiff / 100,
      low: base + fields.lowDiff / 100,
      timeRaw: fields.timeRaw,
      vol: fields.vol,
      curVol: fields.curVol,
      amount: decodeVolume(amountRaw),
      amountRaw,
      speed: speed / 100,
      active2,
      bids: levels.map((l) => ({ price: base + l.bid.price / 100, volume: l.bid.volume })),
      asks: levels.map((l) => ({ price: base + l.ask.price / 100, volume: l.ask.volume }))
    })
  }

  return quotes
}

function parseBars(body, category, kind = 'stock') {
  debugBody('bars', body)
  let pos = 0
  const count = body.readUInt16LE(pos)
  pos += 2
  const bars = []
  let base = 0

  for (let i = 0; i < count; i++) {
    let year
    let month
    let day
    if (category < 4 || category === 7 || category === 8) {
      const zipday = body.readUInt16LE(pos)
      const minutes = body.readUInt16LE(pos + 2)
      year = (zipday >> 11) + 2004
      month = Math.floor((zipday % 2048) / 100)
      day = (zipday % 2048) % 100
      void minutes
    } else {
      const zipday = body.readUInt32LE(pos)
      year = Math.floor(zipday / 10000)
      month = Math.floor((zipday % 10000) / 100)
      day = zipday % 100
    }
    pos += 4

    const [openDiff, p1] = readPrice(body, pos)
    const [closeDiff, p2] = readPrice(body, p1)
    const [highDiff, p3] = readPrice(body, p2)
    const [lowDiff, p4] = readPrice(body, p3)
    pos = p4

    const openRaw = base + openDiff
    const closeRaw = openRaw + closeDiff
    const vol = decodeVolume(body.readUInt32LE(pos))
    const amount = decodeVolume(body.readUInt32LE(pos + 4))
    pos += 8
    if (kind === 'index') pos += 4

    bars.push({
      date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      open: openRaw / 1000,
      close: closeRaw / 1000,
      high: (openRaw + highDiff) / 1000,
      low: (openRaw + lowDiff) / 1000,
      wireVolume: vol,
      volume: vol / 100,
      amount
    })
    base = closeRaw
  }

  return bars
}

function parseMinute(body) {
  debugBody('minute', body)
  const count = body.readUInt16LE(0)
  let pos = 4
  let firstPrice = 0
  let firstAvg = 0
  const points = []

  for (let i = 0; i < count; i++) {
    const [priceField, p1] = readPrice(body, pos)
    const [avgField, p2] = readPrice(body, p1)
    const [vol, p3] = readPrice(body, p2)
    pos = p3

    if (i === 0) {
      firstPrice = priceField
      firstAvg = avgField
    }
    const priceRaw = i === 0 ? priceField : firstPrice + priceField
    const avgRaw = i === 0 ? avgField : firstAvg + avgField
    points.push({ price: priceRaw / 100, avg: avgRaw / 10000, vol })
  }

  return { count, points }
}

function parseHistoryMinute(body) {
  debugBody('history-minute', body)
  const count = body.readUInt16LE(0)
  const prevClose = body.readFloatLE(2)
  let pos = 6
  let last = 0
  const points = []

  for (let i = 0; i < count; i++) {
    const [diff, p1] = readPrice(body, pos)
    const [, p2] = readPrice(body, p1)
    const [vol, p3] = readPrice(body, p2)
    pos = p3
    last += diff
    points.push({ price: last / 100, vol })
  }

  return { count, prevClose, points }
}

function parseList(body) {
  const count = body.readUInt16LE(0)
  let pos = 2
  const stocks = []
  for (let i = 0; i < count; i++) {
    const code = body.toString('ascii', pos, pos + 6).replace(/\0+$/, '')
    const multiple = body.readUInt16LE(pos + 6)
    const name = new TextDecoder('gbk').decode(body.subarray(pos + 8, pos + 24)).replace(/\0+$/, '')
    const decimal = body[pos + 28]
    const preClose = body.readFloatLE(pos + 29)
    stocks.push({ code, multiple, name, decimal, preClose })
    pos += 37
  }
  return { count, stocks }
}

/* -------------------------------------------------------------- 腾讯对照 */

async function tencentQuote(code) {
  const res = await fetch(`https://qt.gtimg.cn/q=${code}`, {
    headers: { Referer: 'https://gu.qq.com/' }
  })
  const text = new TextDecoder('gbk').decode(await res.arrayBuffer())
  const match = /="([^"]*)"/.exec(text)
  return match ? match[1].split('~') : []
}

async function tencentKline(code, count) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,${count},qfq`
  const res = await fetch(url, { headers: { Referer: 'https://gu.qq.com/' } })
  const json = await res.json()
  const body = json?.data?.[code] ?? {}
  return body.qfqday ?? body.day ?? []
}

/* ------------------------------------------------------------------ 主流程 */

async function connectFirst() {
  for (const [host, port] of SERVERS) {
    const startedAt = Date.now()
    try {
      const conn = await TdxConnection.open(host, port, 4000)
      // 只发 0x000d 握手。pytdx 那三连包（setup1/2/3）会让服务端进入旧版会话，
      // 之后行情请求只回 4 字节空包 —— 这是本次探测踩到的最大坑。
      const info = await conn.handshake(true)
      console.log(
        `[连接] ${host}:${port} 握手成功 ${info.date} 主站=${info.name} 产品=${info.tag} 耗时 ${Date.now() - startedAt}ms`
      )
      return conn
    } catch (err) {
      console.log(`[连接] ${host}:${port} 失败：${err.message}`)
    }
  }
  throw new Error('所有主站都连不上')
}

async function main() {
  const conn = await connectFirst()

  try {
    if (process.env.TDX_ONLY === 'quote') {
      const one = [[1, '600519']]
      const many = [
        [1, '600519'],
        [0, '000858'],
        [1, '600036'],
        [0, '300750'],
        [1, '600000']
      ]
      const variants = [
        ['053e x1', quoteRequest(one, 0x053e, 9)],
        ['053e x5', quoteRequest(many, 0x053e, 9)],
        ['054c x1', quoteRequest(one, 0x054c, 9)],
        ['0547 x1', refreshRequest(one)],
        ['054b cat', categoryRequest(6, 5)]
      ]
      for (const [label, packet] of variants) {
        const { header, body } = await conn.request(packet)
        console.log(
          `${label}: 响应头=${header.toString('hex')} bodyLen=${body.length} body=${body.subarray(0, 48).toString('hex')}`
        )
      }
      return
    }
    if (process.env.TDX_ONLY === 'dump') {
      // 把真实响应体落成 hex，供 python/fixtures 当 fixture
      const dir = process.env.TDX_DUMP_DIR || '/tmp/tdx-fixtures'
      fs.mkdirSync(dir, { recursive: true })
      const save = async (name, packet) => {
        const { body } = await conn.request(packet)
        fs.writeFileSync(path.join(dir, `${name}.hex`), body.toString('hex'))
        console.log(`[dump] ${name} ${body.length}B`)
      }
      await save('quote1', quoteRequest([[1, '600519']]))
      await save(
        'quote5',
        quoteRequest([
          [1, '600519'],
          [0, '000858'],
          [1, '600036'],
          [0, '300750'],
          [1, '600000']
        ])
      )
      await save('quote-index', quoteRequest([[1, '000001']]))
      await save('bars-day5', barsRequest(1, '600519', 4, 0, 5, 1))
      await save('bars-week3', barsRequest(1, '600519', 5, 0, 3, 1))
      await save('bars-index3', barsRequest(1, '000001', 4, 0, 3, 1))
      await save('minute', minuteRequest(1, '600519'))
      await save('minute-history', historyMinuteRequest(1, '600519', 20261029))
      await save('list3', listRequest(1, 0, 3))
      await save(
        'finance2',
        financeRequest([
          [1, '600519'],
          [0, '000858']
        ])
      )
      console.log(`[dump] 已写入 ${dir}`)
      return
    }
    if (process.env.TDX_ONLY === 'detail2') {
      /* 北交所：市场号 2 */
      const bjCount = (await conn.request(countRequest(2))).body.readUInt16LE(0)
      const bjList = parseList((await conn.request(listRequest(2, 0, 100))).body)
      console.log(`[北交所] 数量=${bjCount} 首页=${bjList.count}`)
      console.log(
        `         ${bjList.stocks
          .slice(0, 3)
          .map((s) => `${s.code} ${s.name}`)
          .join('  ')}`
      )
      const bjQuotes = parseQuotes(
        (await conn.request(quoteRequest(bjList.stocks.slice(0, 3).map((s) => [2, s.code])))).body
      )
      console.log(
        `         行情：${bjQuotes.map((q) => `${q.code} ${q.price}/${q.lastClose}`).join('  ')}`
      )

      /* 周K / 月K */
      for (const category of [5, 6]) {
        const bars = parseBars(
          (await conn.request(barsRequest(1, '600519', category, 0, 3, 1))).body,
          category,
          'stock'
        )
        console.log(
          `[${category === 5 ? '周K' : '月K'}] ` +
            bars.map((b) => `${b.date} C=${b.close}`).join('  ')
        )
      }

      /* 指数日K：记录比个股多 4 字节（上涨/下跌家数） */
      const indexBars = parseBars(
        (await conn.request(barsRequest(1, '000001', 4, 0, 3, 1))).body,
        4,
        'index'
      )
      console.log(
        `[指数日K] ` + indexBars.map((b) => `${b.date} O=${b.open} C=${b.close}`).join('  ')
      )

      /* 五日分时：用日K最后 5 个交易日，逐日拉历史分时 */
      const daily = parseBars(
        (await conn.request(barsRequest(1, '600519', 4, 0, 8, 1))).body,
        4,
        'stock'
      )
      const last5 = daily.slice(-5)
      console.log(`[五日分时] 日期=${last5.map((b) => b.date).join(',')}`)
      for (const bar of last5) {
        const date = Number(bar.date.replaceAll('-', ''))
        const one = parseHistoryMinute(
          (await conn.request(historyMinuteRequest(1, '600519', date))).body
        )
        console.log(
          `         ${bar.date} 点数=${one.count} 昨收=${one.prevClose} ` +
            `首=${one.points[0]?.price} 尾=${one.points.at(-1)?.price}`
        )
      }

      /* 财务信息：能不能用它补回 PE/PB/市值/换手率 */
      const fin = (
        await conn.request(
          financeRequest([
            [1, '600519'],
            [0, '000858']
          ])
        )
      ).body
      const finCount = fin.readUInt16LE(0)
      console.log(`[财务] 返回 ${finCount} 条，bodyLen=${fin.length}`)
      for (let i = 0; i < finCount; i++) {
        const base = 2 + i * 143
        const info = base + 7
        const code = fin.toString('ascii', base + 1, base + 7)
        const floatShares = fin.readFloatLE(info) // 万股
        const totalShares = fin.readFloatLE(info + 16) // 万股
        const eps = fin.readFloatLE(info + 40)
        const netAssetsPerShare = fin.readFloatLE(info + 128)
        console.log(
          `       ${code} 流通=${floatShares.toFixed(0)}万股 总股本=${totalShares.toFixed(0)}万股 ` +
            `EPS=${eps} 每股净资产=${netAssetsPerShare}`
        )
      }

      /* 全量代码表：搜索联想如果要走本地索引，得先知道代价 */
      const startedAll = Date.now()
      let total = 0
      for (const market of [0, 1]) {
        const count = (await conn.request(countRequest(market))).body.readUInt16LE(0)
        for (let start = 0; start < count; start += 1000) {
          total += parseList((await conn.request(listRequest(market, start, 1000))).body).count
        }
      }
      console.log(`[代码表] 全量 ${total} 条，耗时 ${Date.now() - startedAll}ms`)
      return
    }
    /* 1. 市场证券数量 + 列表（GBK 名称） */
    for (const market of [0, 1]) {
      const { body } = await conn.request(countRequest(market))
      const count = body.readUInt16LE(0)
      console.log(`[数量] market=${market} 共 ${count} 只`)
    }

    const list = parseList((await conn.request(listRequest(1, 0))).body)
    console.log(`[列表] 沪市前 ${Math.min(5, list.count)} 只：`)
    for (const stock of list.stocks.slice(0, 5)) {
      console.log(
        `       ${stock.code} ${stock.name} multiple=${stock.multiple} decimal=${stock.decimal}`
      )
    }

    /* 2. 五档行情（和腾讯逐字段对照） */
    const codes = [
      [1, '600519'],
      [0, '000858'],
      [1, '600036'],
      [0, '300750'],
      [1, '000001']
    ]
    const quotesStarted = Date.now()
    const quotes = parseQuotes((await conn.request(quoteRequest(codes))).body)
    console.log(`\n[行情] ${quotes.length} 只，耗时 ${Date.now() - quotesStarted}ms`)
    for (const q of quotes) {
      console.log(
        `       ${q.market === 1 ? 'sh' : 'sz'}${q.code} ` +
          `price=${q.price} prev=${q.lastClose.toFixed(2)} open=${q.open.toFixed(2)} ` +
          `high=${q.high.toFixed(2)} low=${q.low.toFixed(2)} ` +
          `vol=${q.vol} amount=${q.amount.toFixed(0)} speed=${q.speed} timeRaw=${q.timeRaw}`
      )
      console.log(
        `         bid1=${q.bids[0].price.toFixed(2)}x${q.bids[0].volume} ` +
          `ask1=${q.asks[0].price.toFixed(2)}x${q.asks[0].volume}`
      )
    }

    const tencent = await tencentQuote('sh600519,sz000858,sh600036,sz300750,sh000001')
    console.log('\n[对照] 腾讯 qt.gtimg.cn：')
    for (const line of tencent) {
      const f = line.split('~')
      if (f.length < 40) continue
      console.log(
        `       ${f[2]} ${f[1]} price=${f[3]} prev=${f[4]} open=${f[5]} ` +
          `vol(手)=${f[6]} amount(万)=${f[37]} bid1=${f[9]}x${f[10]} ask1=${f[19]}x${f[20]}`
      )
    }

    /* 3. 日K（不复权）与腾讯前复权对照最近 5 根 */
    const tdxBars = parseBars(
      (await conn.request(barsRequest(1, '600519', 4, 0, 5, 1))).body,
      4,
      'stock'
    )
    console.log('\n[日K] 600519 通达信 category=4（前复权）最近 5 根：')
    for (const bar of tdxBars) {
      console.log(
        `       ${bar.date} O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close} ` +
          `vol(手)=${bar.volume} amount=${bar.amount.toFixed(0)}`
      )
    }

    const txBars = await tencentKline('sh600519', 5)
    console.log('[日K] 腾讯 qfq 最近 5 根：')
    for (const row of txBars) {
      console.log(`       ${row[0]} O=${row[1]} C=${row[2]} H=${row[3]} L=${row[4]} vol=${row[5]}`)
    }

    /* 4. 分时：点数、首尾价格 */
    const minute = parseMinute((await conn.request(minuteRequest(1, '600519'))).body)
    console.log(`\n[分时] 600519 点数=${minute.count}`)
    if (minute.count > 0) {
      console.log(
        `       首 ${minute.points[0].price} / 尾 ${minute.points[minute.points.length - 1].price}`
      )
      console.log(
        `       前 3 点 价/均/量: ` +
          minute.points
            .slice(0, 3)
            .map((p) => `${p.price}/${p.avg.toFixed(3)}/${p.vol}`)
            .join('  ')
      )
    }

    /* 5. 历史分时：用日K最后一根的日期 */
    if (tdxBars.length > 0) {
      const lastDate = Number(tdxBars[tdxBars.length - 1].date.replaceAll('-', ''))
      const hist = parseHistoryMinute(
        (await conn.request(historyMinuteRequest(1, '600519', lastDate))).body
      )
      console.log(`\n[历史分时] 600519 ${lastDate} 点数=${hist.count}`)
      if (hist.count > 0) {
        console.log(
          `       昨收=${hist.prevClose} 首 ${hist.points[0].price} / 尾 ${hist.points.at(-1).price}`
        )
      }
    }

    /* 6. 港股：7709 主站到底认不认 market=31 */
    const hk = parseQuotes((await conn.request(quoteRequest([[31, '00700']]))).body)
    console.log(`\n[港股] 7709 主站 market=31 返回 ${hk.length} 条`)
    if (hk.length > 0) {
      const q = hk[0]
      console.log(`       ${q.code} price=${q.price} prev=${q.lastClose} vol=${q.vol}`)
    }

    /* 7. 批量上限：一次到底能要多少只 */
    for (const size of [80, 81, 100]) {
      const many = list.stocks.slice(0, size).map((stock) => [1, stock.code])
      const started = Date.now()
      const result = parseQuotes((await conn.request(quoteRequest(many))).body)
      console.log(
        `[批量] 请求 ${size} 只 → 返回 ${result.length} 条，耗时 ${Date.now() - started}ms`
      )
    }
  } finally {
    conn.close()
  }
}

main().catch((err) => {
  console.error('\n[失败]', err)
  process.exitCode = 1
})
