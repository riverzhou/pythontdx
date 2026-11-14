/**
 * 自动选股池：每 60 秒按跟踪预设重扫一次，并整组替换「自动池 · 预设名」。
 *
 * 只在用户显式点「跟踪」后启动；不生成交易指令。
 */
import { createEffect, createSignal } from 'solid-js'
import type { ScreenPreset } from '@shared/types'
import { api } from '../lib/client'
import { appState, replaceGroupItems } from './app'

const INTERVAL_MS = 60_000
export const [screenTrackingAt, setScreenTrackingAt] = createSignal<number | null>(null)
export const [screenTrackingError, setScreenTrackingError] = createSignal<string | null>(null)

function numberOrUndefined(value: string): number | undefined {
  const parsed = Number(value.trim())
  return value.trim() && Number.isFinite(parsed) ? parsed : undefined
}

async function tick(preset: ScreenPreset): Promise<void> {
  try {
    const amountYi = numberOrUndefined(preset.minAmountYi)
    const data = await api.screen.run({
      minChangePct: numberOrUndefined(preset.minChange),
      minAmount: amountYi === undefined ? undefined : amountYi * 100_000_000,
      minTurnoverRate: numberOrUndefined(preset.minTurnover),
      minAmplitude: numberOrUndefined(preset.minAmplitude),
      maxPrice: numberOrUndefined(preset.maxPrice),
      industry: preset.industry.trim() || undefined,
      sortBy: preset.sortBy,
      limit: 100
    })
    replaceGroupItems(
      `pool-${preset.id}`,
      `自动池 · ${preset.name}`,
      data.quotes.map((quote) => ({ code: quote.code, name: quote.name, market: quote.market }))
    )
    setScreenTrackingAt(Date.now())
    setScreenTrackingError(null)
  } catch (cause) {
    setScreenTrackingError(cause instanceof Error ? cause.message : String(cause))
  }
}

/** App 启动时调用一次；settings 里 trackingPresetId 变化会重启计时器。 */
function trackedIds(): string[] {
  const settings = appState.settings
  const explicit = settings.trackingPresetIds ?? []
  if (explicit.length > 0) return explicit
  return settings.trackingPresetId ? [settings.trackingPresetId] : []
}

export function startScreenTracking(): void {
  let timer: number | null = null
  let activeKey = ''

  createEffect(() => {
    const ids = trackedIds()
    const key = ids.join(',')
    if (key === activeKey) return
    activeKey = key
    if (timer !== null) window.clearInterval(timer)
    timer = null
    if (ids.length === 0) return
    const tickAll = (): void => {
      for (const id of ids) {
        const preset = (appState.settings.screenPresets ?? []).find((item) => item.id === id)
        if (preset) void tick(preset)
      }
    }
    tickAll()
    timer = window.setInterval(tickAll, INTERVAL_MS)
  })
}
