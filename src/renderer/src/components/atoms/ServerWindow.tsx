/**
 * 行情服务器弹层内容。
 *
 * 只负责测速、选择和持久化；不交易、不读账户、不碰授权数据。
 * 由主窗口以弹层方式挂载，不再单独开原生窗口。
 */
import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import type { ServerSpeedResult } from '@shared/types'
import { api, errorMessage } from '../../lib/client'
import { IconClose } from './Icons'

export function ServerWindow(props: { onClose: () => void }): JSX.Element {
  const [result, setResult] = createSignal<ServerSpeedResult | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [showAll, setShowAll] = createSignal(false)
  const [selecting, setSelecting] = createSignal<string | null>(null)
  const [preferred, setPreferred] = createSignal<string | null>(null)

  const run = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.server.speedTest()
      setResult(data)
      setPreferred(data.preferred)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }

  const choose = async (host: string): Promise<void> => {
    setSelecting(host)
    setError(null)
    try {
      const selected = await api.server.select(host)
      setPreferred(selected.preferred)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSelecting(null)
    }
  }

  const hosts = createMemo(() => {
    const data = result()
    if (!data) return []
    return showAll() ? data.hosts : data.hosts.filter((item) => item.status === 'ok')
  })

  const unavailable = createMemo(
    () => (result()?.hosts ?? []).filter((item) => item.status !== 'ok').length
  )

  onMount(() => {
    void run()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
  })

  return (
    <div class="server-page">
      <header class="server-page__head">
        <div>
          <div class="server-page__eyebrow">通达信 Windows 公开主站 · TCP 7709</div>
          <h1 class="server-page__title">行情服务器</h1>
          <p class="server-page__sub">
            优先读取 Windows 客户端解包的 <code>connect.cfg</code>；只测 TCP 建连延迟，
            不发送账户或交易数据。默认只显示可达站点，失败站点自动隐藏。
          </p>
          <p class="server-page__source">
            列表来源：<code>{result()?.source ?? '读取中…'}</code>
          </p>
        </div>
        <button
          class="btn btn--icon btn--bare server-page__close"
          title="关闭"
          onClick={() => props.onClose()}
        >
          <IconClose size={16} />
        </button>
      </header>

      <div class="server-page__toolbar">
        <button
          class="btn btn--primary server-page__test"
          disabled={loading()}
          onClick={() => void run()}
        >
          {loading() ? '测速中…' : '重新测速'}
        </button>
        <span class="server-page__summary">
          可用 {result()?.hosts.filter((item) => item.status === 'ok').length ?? 0} / 候选{' '}
          {result()?.hosts.length ?? 0}
          {unavailable() > 0 ? ` · 隐藏不可达 ${unavailable()}` : ''}
        </span>
        <label class="server-page__show-all">
          <input
            type="checkbox"
            checked={showAll()}
            onChange={(event) => setShowAll(event.currentTarget.checked)}
          />
          显示不可达
        </label>
        <Show when={preferred()}>
          {(host) => <span class="server-page__current">当前：{host()}</span>}
        </Show>
      </div>

      <Show when={error()}>
        {(message) => (
          <div class="server-page__error" role="alert">
            {message()}
          </div>
        )}
      </Show>

      <div class="server-page__list" aria-busy={loading()}>
        <Show when={!loading() && hosts().length === 0}>
          <div class="server-page__empty">没有可达的行情主站，请检查网络后重试。</div>
        </Show>
        <For each={hosts()}>
          {(host) => (
            <button
              class="server-page__item"
              classList={{
                'server-page__item--active': host.host === preferred(),
                'server-page__item--error': host.status !== 'ok'
              }}
              disabled={host.status !== 'ok' || selecting() !== null}
              onClick={() => void choose(host.host)}
              title={host.error || `${host.host}:${host.port}`}
            >
              <span class="server-page__host">
                {host.host}:{host.port}
              </span>
              <span class="server-page__latency">
                {host.status === 'ok' ? `${host.latencyMs.toFixed(1)} ms` : '不可达'}
              </span>
              <span class="server-page__state">
                {host.host === preferred()
                  ? '使用中'
                  : selecting() === host.host
                    ? '切换中…'
                    : host.status === 'ok'
                      ? '选择'
                      : '—'}
              </span>
            </button>
          )}
        </For>
      </div>

      <footer class="server-page__foot">
        选择会写入本地 <code>server.json</code>；连接失败时仍会自动尝试其它主站。
      </footer>
    </div>
  )
}
