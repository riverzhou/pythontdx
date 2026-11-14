/**
 * 自选行情墙：一屏 20–40 只，带当日分时缩略图。
 *
 * 缩略图按当前页懒加载，翻页后旧请求作废；点击卡片切回主图。
 */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX
} from 'solid-js'
import { fixed, signedPct } from '@shared/format'
import type { WatchItem } from '@shared/types'
import { activeItems, appState } from '../../stores/app'
import { quoteOf } from '../../stores/quotes'
import { api, errorMessage } from '../../lib/client'
import { IconClose } from './Icons'

interface WatchlistFullscreenProps {
  onClose: () => void
  onSelect: (code: string) => void
  /** 作为主工作区标签页渲染（非弹窗） */
  embedded?: boolean
}

const SPARK_W = 220
const SPARK_H = 44
const SPARK_PAD = 3

function sparkPath(values: number[]): string {
  if (values.length < 2) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  return values
    .map((value, index) => {
      const x = SPARK_PAD + (index / (values.length - 1)) * (SPARK_W - SPARK_PAD * 2)
      const y = SPARK_H - SPARK_PAD - ((value - min) / span) * (SPARK_H - SPARK_PAD * 2)
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
}

interface Spark {
  path: string
  changePct: number
  price: number
  date: string
}

export function WatchlistFullscreen(props: WatchlistFullscreenProps): JSX.Element {
  const [sparks, setSparks] = createSignal<Record<string, Spark>>({})
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  let requestId = 0

  const items = createMemo(() => activeItems().slice(0, 40))
  const groupName = createMemo(
    () => appState.groups.find((group) => group.id === appState.activeGroupId)?.name ?? '自选'
  )

  const loadSparks = async (list: WatchItem[]): Promise<void> => {
    const current = ++requestId
    setLoading(true)
    setError(null)
    const next: Record<string, Spark> = {}
    await Promise.all(
      list.map(async (item) => {
        try {
          const trend = await api.trend.minute(item.code)
          const points = trend.points
          if (current !== requestId || points.length < 2) return
          const close = points[points.length - 1]?.price ?? 0
          const changePct =
            trend.prevClose > 0 ? ((close - trend.prevClose) / trend.prevClose) * 100 : 0
          next[item.code] = {
            path: sparkPath(points.map((point) => point.price)),
            changePct,
            price: close,
            date: trend.date
          }
        } catch (cause) {
          if (current === requestId) setError(errorMessage(cause))
        }
      })
    )
    if (current === requestId) {
      setSparks(next)
      setLoading(false)
    }
  }

  createEffect(() => {
    const list = items()
    void loadSparks(list)
  })

  const select = (code: string): void => {
    props.onSelect(code)
    props.onClose()
  }

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
  })

  onCleanup(() => {
    requestId += 1
  })

  return (
    <div
      class="watch-full"
      classList={{ 'panel-embed': props.embedded === true }}
      role={props.embedded ? 'region' : 'dialog'}
      aria-modal={props.embedded ? undefined : 'true'}
      aria-label="自选行情墙"
    >
      <header class="watch-full__head">
        <div>
          <div class="watch-full__eyebrow">自选行情墙 · 按窗口宽度自动排布</div>
          <h2 class="watch-full__title">
            {groupName()} <span>{items().length} 只</span>
          </h2>
        </div>
        <div class="watch-full__actions">
          <Show when={loading()}>
            <span class="watch-full__loading">加载分时…</span>
          </Show>
          <button
            class="btn btn--icon btn--bare"
            title="关闭自选行情墙"
            onClick={() => props.onClose()}
          >
            <IconClose size={16} />
          </button>
        </div>
      </header>

      <Show when={error()}>{(message) => <div class="watch-full__error">{message()}</div>}</Show>

      <Show
        when={items().length > 0}
        fallback={<div class="watch-full__empty">当前分组没有股票</div>}
      >
        <div class="watch-full__grid">
          <For each={items()}>
            {(item) => {
              const quote = (): ReturnType<typeof quoteOf> => quoteOf(item.code)
              const spark = (): Spark | undefined => sparks()[item.code]
              const pct = (): number => quote()?.changePct ?? spark()?.changePct ?? 0
              return (
                <button
                  class="watch-full__card"
                  classList={{ 'watch-full__card--down': pct() < 0 }}
                  onClick={() => select(item.code)}
                >
                  <div class="watch-full__card-head">
                    <span
                      class="watch-full__name"
                      classList={{
                        'watch-full__name--long': (quote()?.name ?? item.name).length > 5
                      }}
                    >
                      {quote()?.name ?? item.name}
                    </span>
                    <span class="watch-full__code num">{item.code.toUpperCase()}</span>
                  </div>
                  <div class="watch-full__quote">
                    <strong class="num">{fixed(quote()?.price ?? spark()?.price ?? 0)}</strong>
                    <span classList={{ 'tone-up': pct() > 0, 'tone-down': pct() < 0 }}>
                      {signedPct(pct())}
                    </span>
                  </div>
                  <Show
                    when={spark()?.path}
                    fallback={<div class="watch-full__spark-empty">分时加载中…</div>}
                  >
                    <svg
                      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
                      class="watch-full__spark"
                      aria-hidden="true"
                    >
                      <path d={spark()?.path ?? ''} />
                    </svg>
                  </Show>
                  <div class="watch-full__foot">
                    <span>{spark()?.date ?? '—'}</span>
                    <span>点击查看</span>
                  </div>
                </button>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}
