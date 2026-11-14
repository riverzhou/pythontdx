/**
 * 底部状态栏：连接状态、行情时间、涨跌家数、交易时段、刷新频率、版本。
 *
 * 自选导入/导出已移到设置面板（它们是低频配置，不该占状态栏）；
 * 大盘资料/快捷键等入口收进标题栏菜单，状态栏只留“现在能不能信这屏数据”。
 */
import { createEffect, createSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import type { MarketBreadth } from '@shared/types'
import { SESSION_LABEL, marketSession } from '@shared/market'
import { hhmmssLabel, relativeFrom, timeOfDay } from '@shared/format'
import { scheduleBreadth } from '../../lib/breadth'
import { api } from '../../lib/client'
import { activeQuoteCode, appInfo, appState, updateSettings, watchCodes } from '../../stores/app'
import { connection, lastUpdateAt, quoteOf, refreshQuotes, streamError } from '../../stores/quotes'
import { clockNow } from '../../stores/clock'
import { openView } from '../../stores/workspace'
import { IconRefresh } from '../atoms/Icons'

const INTERVAL_OPTIONS = [
  { value: 1000, label: '1s' },
  { value: 3000, label: '3s' },
  { value: 5000, label: '5s' },
  { value: 10_000, label: '10s' }
]

const STATUS_TEXT: Record<string, string> = {
  idle: '未订阅',
  connecting: '连接中',
  live: '实时',
  error: '连接异常',
  paused: '已暂停'
}

export function StatusBar(): JSX.Element {
  const [breadth, setBreadth] = createSignal<MarketBreadth | null>(null)

  const loadBreadth = async (): Promise<void> => {
    try {
      setBreadth(await api.market.breadth())
    } catch {
      // 涨跌家数是辅助信息，失败静默，不打断状态栏
    }
  }
  // 全市场扫描很慢（macOS 冷启动实测独占 sidecar 7.5 秒），
  // 等首帧行情/图表就绪后再后台加载，别把分时图堵在队列后面。
  createEffect(() => {
    const status = connection()
    onCleanup(scheduleBreadth(status, () => void loadBreadth()))
  })

  const quote = () => quoteOf(activeQuoteCode())
  const session = () => marketSession(new Date(clockNow()))

  return (
    <footer class="statusbar">
      <div class="statusbar__group">
        <span
          class="dot"
          classList={{
            'dot--live': connection() === 'live',
            'dot--error': connection() === 'error',
            'dot--connecting': connection() === 'connecting',
            'dot--paused': connection() === 'paused'
          }}
        />
        <span class="statusbar__text">{STATUS_TEXT[connection()] ?? connection()}</span>
      </div>

      <Show when={streamError()}>
        <span class="statusbar__text statusbar__error" title={streamError() ?? ''}>
          {streamError()}
        </span>
      </Show>

      <Show when={quote()}>
        {(current) => (
          <span class="statusbar__text num">
            行情{' '}
            {current().updateTime != null
              ? hhmmssLabel(current().updateTime)
              : timeOfDay(current().time)}{' '}
            · {relativeFrom(lastUpdateAt() || Date.now(), clockNow())}
          </span>
        )}
      </Show>

      <Show when={breadth()}>
        {(value) => (
          <button
            class="statusbar__text market-breadth market-report-open"
            title={`打开大盘资料 · 涨停 ${value().limitUp ?? '—'} / 跌停 ${value().limitDown ?? '—'}`}
            onClick={() => openView('report')}
          >
            涨 <span class="tone-up">{value().up}</span> / 跌{' '}
            <span class="tone-down">{value().down}</span> / 平 {value().flat}
            <Show when={value().limitUp !== undefined}>
              <span class="statusbar__limit">
                {' '}
                · 停 {value().limitUp}/{value().limitDown}
              </span>
            </Show>
          </button>
        )}
      </Show>

      <div class="statusbar__spacer" />

      <span class="statusbar__text">
        {SESSION_LABEL[session()]} · {appState.groups.length} 组 / {watchCodes().length} 只
      </span>

      <div class="statusbar__group">
        <span class="statusbar__text">推送</span>
        <For each={INTERVAL_OPTIONS}>
          {(option) => (
            <button
              class="statusbar__btn"
              data-active={appState.settings.refreshInterval === option.value}
              onClick={() => updateSettings({ refreshInterval: option.value })}
              title={`每 ${option.label} 刷新一次（上游快照）`}
            >
              {option.label}
            </button>
          )}
        </For>
      </div>

      <button
        class="statusbar__btn"
        title="立即刷新"
        onClick={() => void refreshQuotes(watchCodes())}
      >
        <IconRefresh size={11} />
      </button>

      <span class="statusbar__text num">v{appInfo()?.version ?? '0.0.0'}</span>
    </footer>
  )
}
