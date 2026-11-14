/**
 * 程序化生成应用图标 —— 不依赖任何图形库，只用 Node 内置的 zlib。
 *
 * 为什么手写 PNG/ICO 编码？
 *  1. 学习项目不想为了一个图标引入 sharp / canvas 这类重量级原生依赖；
 *  2. PNG 和 ICO 的容器格式其实非常简单，自己写一遍就彻底搞懂了；
 *  3. 图标可以随主题色一起版本化——改几个常量重新生成即可。
 *
 * 用法：npm run icon
 * 产物：build/icon.ico（Windows 多尺寸）、build/icon.png、resources/icon.png
 *
 * 绘制流程：先在 3 倍分辨率上「硬边」绘制，再做盒式降采样得到抗锯齿，
 * 这是最朴素也最可靠的 AA 方案。
 */
import { crc32, deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/* ------------------------------------------------------------ 画布工具 */

const SUPER = 3 // 超采样倍数
const SIZE = 256 // 最终尺寸
const N = SIZE * SUPER // 绘制分辨率
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

/** RGBA 画布，每像素 4 个字节 */
const canvas = new Uint8ClampedArray(N * N * 4)

function index(x, y) {
  return (y * N + x) * 4
}

/** 把颜色按 alpha 混合到画布上（source-over） */
function blend(x, y, [r, g, b, a]) {
  if (a <= 0 || x < 0 || y < 0 || x >= N || y >= N) return
  const i = index(x, y)
  const srcA = a
  const dstA = canvas[i + 3] / 255
  const outA = srcA + dstA * (1 - srcA)
  if (outA <= 0) return
  canvas[i] = (r * srcA + canvas[i] * dstA * (1 - srcA)) / outA
  canvas[i + 1] = (g * srcA + canvas[i + 1] * dstA * (1 - srcA)) / outA
  canvas[i + 2] = (b * srcA + canvas[i + 2] * dstA * (1 - srcA)) / outA
  canvas[i + 3] = outA * 255
}

function hex(value) {
  const n = parseInt(value.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** 圆角矩形：返回点是否在形状内 */
function insideRoundRect(x, y, left, top, width, height, radius) {
  if (x < left || y < top || x >= left + width || y >= top + height) return false
  const dx = Math.max(left + radius - x, 0, x - (left + width - radius))
  const dy = Math.max(top + radius - y, 0, y - (top + height - radius))
  return dx * dx + dy * dy <= radius * radius
}

/** 点到线段的距离 */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const lengthSq = vx * vx + vy * vy
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / lengthSq))
  const cx = ax + vx * t
  const cy = ay + vy * t
  return Math.hypot(px - cx, py - cy)
}

/* -------------------------------------------------------------- 绘制 */

const BRAND_A = hex('#5B8CFF')
const BRAND_B = hex('#A06BFF')
const ACCENT = hex('#7CF7C4')

function drawIcon() {
  const pad = N * 0.055
  const box = N - pad * 2
  const radius = box * 0.235

  // 1) 圆角底板 + 对角渐变
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!insideRoundRect(x, y, pad, pad, box, box, radius)) continue
      const t = Math.min(1, Math.max(0, ((x - pad) / box) * 0.55 + ((y - pad) / box) * 0.45))
      const base = mix(BRAND_A, BRAND_B, t)

      // 左上角加一点高光，让平面有球面感
      const hx = (x - pad) / box - 0.24
      const hy = (y - pad) / box - 0.18
      const highlight = Math.max(0, 1 - Math.hypot(hx, hy) * 2.1) * 0.3

      blend(x, y, [
        Math.min(255, base[0] + 255 * highlight),
        Math.min(255, base[1] + 255 * highlight),
        Math.min(255, base[2] + 255 * highlight),
        1
      ])
    }
  }

  // 2) 走势折线下的面积
  //    先画进独立的 alpha 层再做横向模糊：折线陡峭时相邻像素列的高度会跳变，
  //    直接逐列填充会留下「窗帘」状的竖向接缝。
  const points = [
    [0.2, 0.68],
    [0.37, 0.5],
    [0.5, 0.6],
    [0.68, 0.33],
    [0.82, 0.42]
  ].map(([x, y]) => [pad + x * box, pad + y * box])

  const floor = pad + box * 0.84
  const layer = new Float32Array(N * N)

  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i]
    const [bx, by] = points[i + 1]
    const minX = Math.max(0, Math.floor(Math.min(ax, bx)) - 1)
    const maxX = Math.min(N - 1, Math.ceil(Math.max(ax, bx)) + 1)

    for (let x = minX; x <= maxX; x++) {
      const t = Math.max(0, Math.min(1, (x + 0.5 - ax) / (bx - ax || 1)))
      const lineY = ay + (by - ay) * t
      const span = Math.max(1, floor - lineY)
      for (let y = Math.max(0, Math.floor(lineY)); y <= Math.min(N - 1, floor); y++) {
        const depth = (y + 0.5 - lineY) / span
        if (depth < 0) continue
        layer[y * N + x] = Math.max(layer[y * N + x], 0.24 * (1 - depth))
      }
    }
  }

  const RADIUS = 3
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let sum = 0
      let count = 0
      for (let k = -RADIUS; k <= RADIUS; k++) {
        const sx = x + k
        if (sx < 0 || sx >= N) continue
        sum += layer[y * N + sx]
        count++
      }
      const alpha = count > 0 ? sum / count : 0
      if (alpha > 0.002) blend(x, y, [255, 255, 255, alpha])
    }
  }

  // 3) 折线本体
  const strokeWidth = box * 0.062
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i]
    const [bx, by] = points[i + 1]
    const minX = Math.floor(Math.min(ax, bx) - strokeWidth - 2)
    const maxX = Math.ceil(Math.max(ax, bx) + strokeWidth + 2)
    const minY = Math.floor(Math.min(ay, by) - strokeWidth - 2)
    const maxY = Math.ceil(Math.max(ay, by) + strokeWidth + 2)

    for (let y = Math.max(0, minY); y <= Math.min(N - 1, maxY); y++) {
      for (let x = Math.max(0, minX); x <= Math.min(N - 1, maxX); x++) {
        const d = distanceToSegment(x + 0.5, y + 0.5, ax, ay, bx, by)
        // 边缘 1.5px 内做线性羽化，配合超采样更干净
        const coverage = Math.max(0, Math.min(1, (strokeWidth / 2 - d) / 1.5 + 0.5))
        blend(x, y, [255, 255, 255, coverage * 0.97])
      }
    }
  }

  // 4) 末端高亮点（表示"最新价"）
  const [ex, ey] = points[points.length - 1]
  const dotRadius = box * 0.062
  for (let y = Math.floor(ey - dotRadius - 2); y <= Math.ceil(ey + dotRadius + 2); y++) {
    for (let x = Math.floor(ex - dotRadius - 2); x <= Math.ceil(ex + dotRadius + 2); x++) {
      const d = Math.hypot(x + 0.5 - ex, y + 0.5 - ey)
      const coverage = Math.max(0, Math.min(1, (dotRadius - d) / 1.5 + 0.5))
      if (coverage <= 0) continue
      blend(x, y, [...ACCENT, coverage])
    }
  }
}

/* ------------------------------------------------------ 降采样与编码 */

/** 盒式降采样到目标尺寸 */
function downsample(target) {
  const out = new Uint8ClampedArray(target * target * 4)
  const factor = N / target
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0
      const startX = Math.floor(x * factor)
      const startY = Math.floor(y * factor)
      const endX = Math.min(N, Math.floor((x + 1) * factor))
      const endY = Math.min(N, Math.floor((y + 1) * factor))
      for (let sy = startY; sy < endY; sy++) {
        for (let sx = startX; sx < endX; sx++) {
          const i = index(sx, sy)
          const alpha = canvas[i + 3] / 255
          // 预乘 alpha 再平均，避免透明边缘出现黑边
          r += canvas[i] * alpha
          g += canvas[i + 1] * alpha
          b += canvas[i + 2] * alpha
          a += alpha
          count++
        }
      }
      if (count === 0) continue
      const o = (y * target + x) * 4
      out[o] = a > 0 ? r / a : 0
      out[o + 1] = a > 0 ? g / a : 0
      out[o + 2] = a > 0 ? b / a : 0
      out[o + 3] = (a / count) * 255
    }
  }
  return out
}

/** 把 RGBA 像素编码成 PNG（真彩 + Alpha） */
function encodePng(pixels, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // 过滤器类型：None
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型：RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** 打包成 ICO（Vista 之后允许直接内嵌 PNG） */
function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)

  let offset = 6 + entries.length * 16
  const directory = []
  for (const { size, data } of entries) {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size // 0 表示 256
    entry[1] = size >= 256 ? 0 : size
    entry[2] = 0 // 调色板数量
    entry[3] = 0
    entry.writeUInt16LE(1, 4) // 色彩平面
    entry.writeUInt16LE(32, 6) // 位深
    entry.writeUInt32LE(data.length, 8) // 数据长度
    entry.writeUInt32LE(offset, 12) // 数据偏移
    directory.push(entry)
    offset += data.length
  }

  return Buffer.concat([header, ...directory, ...entries.map((entry) => entry.data)])
}

/* ---------------------------------------------------------------- 主流程 */

drawIcon()

const pngs = new Map()
for (const size of [...new Set([...ICO_SIZES, 512])]) {
  pngs.set(size, encodePng(downsample(size), size))
}

mkdirSync(join(ROOT, 'build'), { recursive: true })
mkdirSync(join(ROOT, 'resources'), { recursive: true })

writeFileSync(
  join(ROOT, 'build', 'icon.ico'),
  encodeIco(ICO_SIZES.map((size) => ({ size, data: pngs.get(size) })))
)
writeFileSync(join(ROOT, 'build', 'icon.png'), pngs.get(512))
writeFileSync(join(ROOT, 'resources', 'icon.png'), pngs.get(256))

console.log('✓ build/icon.ico      (' + ICO_SIZES.join(' / ') + ')')
console.log('✓ build/icon.png      (512×512，供 macOS / Linux 打包转换)')
console.log('✓ resources/icon.png  (256×256，开发模式窗口图标)')
