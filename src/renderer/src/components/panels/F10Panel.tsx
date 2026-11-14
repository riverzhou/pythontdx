/**
 * F10 公司资料（0x02cf 目录 + 0x02d0 正文）。
 *
 * 左侧段落目录，右侧 GBK 文本；段落按需加载并缓存，关闭即释放。
 */
import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import type { F10Section } from '@shared/types'
import { parseF10 } from '@shared/f10'
import { api, errorMessage, shell } from '../../lib/client'
import { IconClose } from '../atoms/Icons'

interface F10PanelProps {
  code: string
  name: string
  onClose: () => void
}

export function F10Panel(props: F10PanelProps): JSX.Element {
  const [sections, setSections] = createSignal<F10Section[]>([])
  const [active, setActive] = createSignal<F10Section | null>(null)
  const [text, setText] = createSignal('')
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const cache = new Map<string, string>()
  const blocks = createMemo(() => parseF10(text()))
  let requestId = 0

  const openSection = async (section: F10Section): Promise<void> => {
    const current = ++requestId
    setActive(section)
    setLoading(true)
    try {
      const cached = cache.get(section.name)
      const content = cached ?? (await api.f10.content(props.code, section))
      if (current !== requestId) return
      cache.set(section.name, content)
      setText(content)
      setError(null)
    } catch (cause) {
      if (current !== requestId) return
      setError(errorMessage(cause))
      setText('')
    } finally {
      if (current === requestId) setLoading(false)
    }
  }

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))

    void (async () => {
      try {
        const catalog = await api.f10.catalog(props.code)
        setSections(catalog)
        if (catalog[0]) await openSection(catalog[0])
        else setLoading(false)
      } catch (cause) {
        setError(errorMessage(cause))
        setLoading(false)
      }
    })()
  })

  return (
    <div class="f10-backdrop" onClick={() => props.onClose()}>
      <section
        class="f10"
        role="dialog"
        aria-modal="true"
        aria-label={`${props.name} F10 公司资料`}
        onClick={(event) => event.stopPropagation()}
      >
        <header class="f10__head">
          <div>
            <div class="f10__eyebrow">{props.code.toUpperCase()} · 通达信 F10</div>
            <h2 class="f10__title">{props.name} · 公司资料</h2>
          </div>
          <button class="btn btn--icon btn--bare" title="关闭 F10" onClick={() => props.onClose()}>
            <IconClose size={16} />
          </button>
        </header>

        <div class="f10__body">
          <aside class="f10__nav" aria-label="F10 段落目录">
            <For each={sections()}>
              {(section) => (
                <button
                  class="f10__nav-item"
                  classList={{ 'f10__nav-item--active': section.name === active()?.name }}
                  onClick={() => void openSection(section)}
                >
                  {section.name}
                </button>
              )}
            </For>
            <Show when={sections().length === 0 && !error()}>
              <span class="f10__nav-empty">目录加载中…</span>
            </Show>
          </aside>

          <div class="f10__content">
            <Show when={error()}>
              {(message) => (
                <div class="f10__error" role="alert">
                  {message()}
                </div>
              )}
            </Show>
            <Show when={loading()}>
              <div class="f10__loading">加载中…</div>
            </Show>
            <For each={blocks()}>
              {(block) =>
                block.kind === 'table' ? (
                  <div class="f10-table-wrap">
                    <table class="f10-table">
                      <Show when={!block.headerless}>
                        <thead>
                          <tr>
                            <For each={block.rows[0]}>
                              {(cell, index) => (
                                <th classList={{ num: block.numeric[index()] }}>{cell}</th>
                              )}
                            </For>
                          </tr>
                        </thead>
                      </Show>
                      <tbody>
                        <For each={block.headerless ? block.rows : block.rows.slice(1)}>
                          {(row, rowIndex) => {
                            const link = () =>
                              block.links?.[(block.headerless ? 0 : 1) + rowIndex()]
                            return (
                              <tr
                                classList={{ 'f10-table__row--link': Boolean(link()) }}
                                title={link() ? '在浏览器中打开' : undefined}
                                onClick={() => {
                                  const url = link()
                                  if (url) void shell.app.openExternal(url)
                                }}
                              >
                                <For each={row}>
                                  {(cell, index) => (
                                    <td
                                      classList={{ num: block.numeric[index()] }}
                                      colspan={
                                        row.length === 1
                                          ? Math.max(1, block.rows[0]?.length ?? 1)
                                          : undefined
                                      }
                                    >
                                      {cell}
                                      <Show when={index() === 0 && link()}>
                                        <span class="f10-table__link-mark"> ↗</span>
                                      </Show>
                                    </td>
                                  )}
                                </For>
                              </tr>
                            )
                          }}
                        </For>
                      </tbody>
                    </table>
                  </div>
                ) : block.kind === 'heading' ? (
                  <h3 class="f10__heading">{block.text}</h3>
                ) : block.kind === 'kv' ? (
                  <dl class="f10-kv">
                    <For each={block.pairs}>
                      {(pair) => (
                        <div class="f10-kv__row">
                          <dt>{pair.label}</dt>
                          <dd>{pair.value}</dd>
                        </div>
                      )}
                    </For>
                  </dl>
                ) : block.kind === 'link' ? (
                  <button
                    class="f10__link"
                    title="在浏览器中打开"
                    onClick={() => void shell.app.openExternal(block.url)}
                  >
                    {block.url}
                  </button>
                ) : (
                  <pre
                    class="f10__text"
                    classList={{ 'f10__text--mono': block.kind === 'text' && block.mono }}
                  >
                    {block.text}
                  </pre>
                )
              }
            </For>
          </div>
        </div>

        <footer class="f10__foot">
          <span>数据源：7709 · 0x02cf / 0x02d0</span>
          <span>GBK 文本，按主站原文展示</span>
        </footer>
      </section>
    </div>
  )
}
