/**
 * 设置面板：把散落在顶栏/状态栏/图表的开关集中到一处。
 */
import { createSignal, For, onMount, Show, type JSX } from 'solid-js'
import type {
  AppSettings,
  DisplayInfo,
  GraphicsInfo,
  LayoutSlot,
  ServerSpeedResult,
  ThemeMode
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { appInfo, appState, importWatchGroups, toggleTheme, updateSettings } from '../../stores/app'
import { api, shell } from '../../lib/client'
import { downloadText } from '../../lib/download'
import {
  exportWatchlist,
  exportWatchlistCsv,
  parseWatchlist,
  parseWatchlistCsv
} from '@shared/watchlist'
import { IconClose } from '../atoms/Icons'
import { normalizeMaPeriods } from '@shared/ma'

const INTERVALS = [1000, 3000, 5000, 10_000] as const

const LAYOUTS = [
  { id: 'default', label: '默认', sidebar: 264, rail: 300 },
  { id: 'chart', label: '宽图表', sidebar: 220, rail: 272 },
  { id: 'rail', label: '宽盘口', sidebar: 264, rail: 360 }
] as const

export function SettingsPanel(props: { onClose: () => void }): JSX.Element {
  const [graphics, setGraphics] = createSignal<GraphicsInfo | null>(null)
  const [serverSpeed, setServerSpeed] = createSignal<ServerSpeedResult | null>(null)
  const [serverLoading, setServerLoading] = createSignal(false)
  const [serverError, setServerError] = createSignal<string | null>(null)
  const [serverSelecting, setServerSelecting] = createSignal<string | null>(null)
  const [displays, setDisplays] = createSignal<DisplayInfo[]>([])
  const [displayError, setDisplayError] = createSignal<string | null>(null)
  const [movingDisplay, setMovingDisplay] = createSignal<number | null>(null)
  const [desktopBusy, setDesktopBusy] = createSignal(false)
  const [desktopNote, setDesktopNote] = createSignal<string | null>(null)

  const installLinuxDesktop = async (): Promise<void> => {
    if (desktopBusy()) return
    setDesktopBusy(true)
    setDesktopNote(null)
    try {
      const result = await shell.app.installLinuxDesktop()
      setDesktopNote(
        result.changed
          ? '已安装桌面入口，并把双击 AppImage 改为直接运行'
          : '桌面入口已是最新，无需重复安装'
      )
    } catch (cause) {
      setDesktopNote(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDesktopBusy(false)
    }
  }

  const loadDisplays = async (): Promise<void> => {
    try {
      setDisplays(await shell.window.displays())
      setDisplayError(null)
    } catch (cause) {
      setDisplayError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const moveToDisplay = async (displayId: number): Promise<void> => {
    if (movingDisplay() !== null) return
    setMovingDisplay(displayId)
    setDisplayError(null)
    try {
      const moved = await shell.window.moveToDisplay(displayId)
      if (!moved) setDisplayError('没有找到该显示器')
      await loadDisplays()
    } catch (cause) {
      setDisplayError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setMovingDisplay(null)
    }
  }

  const runServerSpeedTest = async (): Promise<void> => {
    setServerLoading(true)
    setServerError(null)
    try {
      setServerSpeed(await api.server.speedTest())
    } catch (cause) {
      setServerError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setServerLoading(false)
    }
  }

  const chooseServer = async (host: string): Promise<void> => {
    setServerSelecting(host)
    setServerError(null)
    try {
      await api.server.select(host)
      setServerSpeed((current) =>
        current
          ? {
              ...current,
              preferred: host,
              hosts: current.hosts.map((item) => ({ ...item, preferred: item.host === host }))
            }
          : current
      )
    } catch (cause) {
      setServerError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setServerSelecting(null)
    }
  }

  onMount(() => {
    void shell.app
      .graphics()
      .then(setGraphics)
      .catch(() => setGraphics(null))
    void loadDisplays()
  })

  const [permission, setPermission] = createSignal(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
  )

  const requestNotify = async (): Promise<void> => {
    if (typeof Notification === 'undefined') return
    setPermission(await Notification.requestPermission())
  }

  const reset = (): void => {
    updateSettings({ ...DEFAULT_SETTINGS, chartDrawings: [] })
  }

  let importInput: HTMLInputElement | undefined

  const exportSettings = (): void => {
    downloadText('pythontdx-settings.json', JSON.stringify(appState.settings, null, 2))
  }

  const importSettings = async (file: File): Promise<void> => {
    try {
      const parsed = JSON.parse(await file.text()) as Partial<AppSettings>
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      updateSettings(parsed)
    } catch {
      // 非 JSON 文件直接忽略，避免把设置写坏。
    }
  }

  /* ------------------------------------------------ 自选股备份（从状态栏搬来） */
  let watchFileInput: HTMLInputElement | undefined
  const [watchNotice, setWatchNotice] = createSignal<string | null>(null)

  const exportWatch = (csv: boolean): void => {
    try {
      const text = csv ? exportWatchlistCsv(appState.groups) : exportWatchlist(appState.groups)
      const day = new Date().toISOString().slice(0, 10)
      downloadText(`pythontdx-watchlist-${day}.${csv ? 'csv' : 'json'}`, text)
      setWatchNotice(`已导出 ${appState.groups.length} 个分组`)
    } catch (cause) {
      setWatchNotice(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const importWatch = async (file: File | undefined): Promise<void> => {
    if (!file) return
    try {
      const text = await file.text()
      const groups = file.name.toLowerCase().endsWith('.csv')
        ? parseWatchlistCsv(text)
        : parseWatchlist(text)
      importWatchGroups(groups)
      setWatchNotice(`已导入 ${groups.length} 个分组`)
    } catch (cause) {
      setWatchNotice(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const saveLayout = (): void => {
    const slot: LayoutSlot = {
      sidebar: appState.settings.sidebarWidth ?? 300,
      rail: appState.settings.railWidth ?? 318,
      savedAt: Date.now()
    }
    updateSettings({
      layoutSlots: [slot, ...(appState.settings.layoutSlots ?? [])].slice(0, 3)
    })
  }

  const applyLayout = (slot: LayoutSlot): void => {
    updateSettings({ sidebarWidth: slot.sidebar, railWidth: slot.rail })
  }

  const removeLayout = (index: number): void => {
    updateSettings({
      layoutSlots: (appState.settings.layoutSlots ?? []).filter((_, item) => item !== index)
    })
  }

  return (
    <div class="settings-backdrop" onClick={() => props.onClose()}>
      <section
        class="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onClick={(event) => event.stopPropagation()}
      >
        <header class="settings__head">
          <div>
            <div class="settings__eyebrow">pythontdx 设置</div>
            <h2 class="settings__title">行情与界面</h2>
          </div>
          <button class="btn btn--icon btn--bare" title="关闭设置" onClick={() => props.onClose()}>
            <IconClose size={16} />
          </button>
        </header>

        <div class="settings__body">
          <div class="settings__row">
            <div>
              <div class="settings__label">主题</div>
              <div class="settings__hint">深色为默认；切换立即生效。</div>
            </div>
            <div class="settings__choices">
              <For each={['dark', 'light'] as ThemeMode[]}>
                {(mode) => (
                  <button
                    class="settings__choice"
                    data-active={appState.settings.theme === mode}
                    onClick={() => {
                      if (appState.settings.theme !== mode) toggleTheme()
                    }}
                  >
                    {mode === 'dark' ? '深色' : '浅色'}
                  </button>
                )}
              </For>
            </div>
          </div>

          <Show when={displays().length > 0}>
            <div class="settings__row">
              <div>
                <div class="settings__label">多屏</div>
                <div class="settings__hint">把当前窗口移到指定显示器；Web 端固定为浏览器窗口。</div>
              </div>
              <div class="settings__choices">
                <For each={displays()}>
                  {(display) => (
                    <button
                      class="settings__choice settings__display"
                      data-active={display.current}
                      disabled={movingDisplay() !== null}
                      title={`${display.width}×${display.height} @${display.scaleFactor}x`}
                      onClick={() => void moveToDisplay(display.id)}
                    >
                      {display.label}
                    </button>
                  )}
                </For>
              </div>
            </div>
            <Show when={displayError()}>
              {(message) => <div class="settings__error">{message()}</div>}
            </Show>
          </Show>

          <div class="settings__row">
            <div>
              <div class="settings__label">行情推送间隔</div>
              <div class="settings__hint">
                主进程按此频率推送；上游 0x0547 是快照，不能做真正的服务端推送。
              </div>
            </div>
            <div class="settings__choices">
              <For each={INTERVALS}>
                {(interval) => (
                  <button
                    class="settings__choice"
                    data-active={appState.settings.refreshInterval === interval}
                    onClick={() => updateSettings({ refreshInterval: interval })}
                  >
                    {interval / 1000}s
                  </button>
                )}
              </For>
            </div>
          </div>

          <label class="settings__row">
            <div>
              <div class="settings__label">窗口隐藏时暂停行情订阅</div>
              <div class="settings__hint">
                切到别的应用时暂停行情订阅；面板推送仍由本机服务调度。
              </div>
            </div>
            <input
              type="checkbox"
              checked={appState.settings.pauseWhenHidden}
              onChange={(event) => updateSettings({ pauseWhenHidden: event.currentTarget.checked })}
            />
          </label>

          <label class="settings__row">
            <div>
              <div class="settings__label">关闭窗口时隐藏到托盘</div>
              <div class="settings__hint">点托盘菜单「退出」才会真正结束进程。</div>
            </div>
            <input
              type="checkbox"
              checked={appState.settings.closeToTray !== false}
              onChange={(event) => updateSettings({ closeToTray: event.currentTarget.checked })}
            />
          </label>

          <label class="settings__row">
            <div>
              <div class="settings__label">自选股迷你走势</div>
              <div class="settings__hint">侧栏每行显示当日分时缩略图。</div>
            </div>
            <input
              type="checkbox"
              checked={appState.settings.showSparkline}
              onChange={(event) => updateSettings({ showSparkline: event.currentTarget.checked })}
            />
          </label>

          <div class="settings__row">
            <div>
              <div class="settings__label">版面</div>
              <div class="settings__hint">也可以直接拖拽左右栏边界；双击手柄复位。</div>
            </div>
            <div class="settings__choices">
              <For each={LAYOUTS}>
                {(layout) => (
                  <button
                    class={`settings__choice settings__layout-${layout.id}`}
                    data-active={
                      (appState.settings.sidebarWidth ?? 264) === layout.sidebar &&
                      (appState.settings.railWidth ?? 318) === layout.rail
                    }
                    onClick={() =>
                      updateSettings({ sidebarWidth: layout.sidebar, railWidth: layout.rail })
                    }
                  >
                    {layout.label}
                  </button>
                )}
              </For>
            </div>
          </div>

          <div class="settings__row">
            <div>
              <div class="settings__label">自定义版面</div>
              <div class="settings__hint">保存当前左右栏宽度，最多 3 套；点击应用。</div>
            </div>
            <div class="settings__slots">
              <button class="btn settings__slot-save" onClick={saveLayout}>
                保存当前
              </button>
              <For each={appState.settings.layoutSlots ?? []}>
                {(slot, index) => (
                  <span class="settings__slot">
                    <button
                      class={`settings__slot-apply settings__slot-apply-${index() + 1}`}
                      onClick={() => applyLayout(slot)}
                    >
                      版面 {index() + 1} · {slot.sidebar}/{slot.rail}
                    </button>
                    <button
                      class="settings__slot-remove"
                      title="删除版面"
                      onClick={() => removeLayout(index())}
                    >
                      ×
                    </button>
                  </span>
                )}
              </For>
            </div>
          </div>

          <Show when={appInfo()?.platform === 'web'}>
            <div class="settings__row">
              <div>
                <div class="settings__label">浏览器通知</div>
                <div class="settings__hint">预警触发时发送系统通知；需浏览器授权。</div>
              </div>
              <div class="settings__notify">
                <span class="settings__notify-state">
                  {permission() === 'granted'
                    ? '已授权'
                    : permission() === 'denied'
                      ? '已拒绝'
                      : permission() === 'unsupported'
                        ? '不支持'
                        : '未授权'}
                </span>
                <button
                  class="btn settings__notify-request"
                  disabled={permission() === 'granted' || permission() === 'unsupported'}
                  onClick={() => void requestNotify()}
                >
                  授权通知
                </button>
              </div>
            </div>
          </Show>

          <div class="settings__row">
            <div>
              <div class="settings__label">配置备份</div>
              <div class="settings__hint">只导出设置，不含自选、预警与持仓。</div>
            </div>
            <div class="settings__backup">
              <button class="btn settings__export" onClick={exportSettings}>
                导出
              </button>
              <button class="btn settings__import" onClick={() => importInput?.click()}>
                导入
              </button>
              <input
                ref={(element: HTMLInputElement) => {
                  importInput = element
                }}
                class="settings__import-input"
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0]
                  if (file) void importSettings(file)
                  event.currentTarget.value = ''
                }}
              />
            </div>
          </div>

          <div class="settings__row">
            <div>
              <div class="settings__label">自选股备份</div>
              <div class="settings__hint">
                自选与自定义板块；JSON/CSV 都能导入，按扩展名识别。
                {watchNotice() ? ` · ${watchNotice()}` : ''}
              </div>
            </div>
            <div class="settings__backup">
              <button class="btn" onClick={() => exportWatch(false)}>
                导出 JSON
              </button>
              <button class="btn" onClick={() => exportWatch(true)}>
                导出 CSV
              </button>
              <button class="btn" onClick={() => watchFileInput?.click()}>
                导入
              </button>
              <input
                ref={(element: HTMLInputElement) => {
                  watchFileInput = element
                }}
                class="settings__import-input"
                type="file"
                accept="application/json,.json,text/csv,.csv"
                onChange={(event) => {
                  void importWatch(event.currentTarget.files?.[0])
                  event.currentTarget.value = ''
                }}
              />
            </div>
          </div>

          <div class="settings__row">
            <div>
              <div class="settings__label">图形系统</div>
              <div class="settings__hint">
                {graphics()
                  ? `${graphics()!.session} · ${graphics()!.requested} · Vulkan ${graphics()!.gpuFeatureStatus.vulkan ?? 'unknown'}`
                  : '读取中…'}
              </div>
            </div>
            <span class="settings__graphics">
              {graphics()?.wayland ? 'Wayland 会话' : 'X11 / Web'}
            </span>
          </div>

          <Show when={appInfo()?.platform === 'linux' && appInfo()?.appImage}>
            <div class="settings__row settings__row--desktop">
              <div>
                <div class="settings__label">Linux 桌面集成</div>
                <div class="settings__hint">
                  文件管理器默认把 AppImage 当磁盘镜像，双击不会启动。这里安装桌面入口， 并把双击
                  AppImage 的默认行为改为直接运行。
                </div>
                <Show when={desktopNote()}>
                  {(message) => <div class="settings__desktop-note">{message()}</div>}
                </Show>
              </div>
              <button
                class="btn settings__desktop-install"
                disabled={desktopBusy()}
                onClick={() => void installLinuxDesktop()}
              >
                {desktopBusy() ? '安装中…' : '修复双击'}
              </button>
            </div>
          </Show>

          <div class="settings__row settings__row--server">
            <div>
              <div class="settings__label">行情主站</div>
              <div class="settings__hint">
                Windows 通达信公开主站列表；测速后点击延迟最低的站点。
                {serverSpeed()?.preferred ? ` 当前：${serverSpeed()!.preferred}` : ''}
              </div>
              <div class="settings__server-actions">
                <button
                  class="btn settings__server-test"
                  disabled={serverLoading()}
                  onClick={() => void runServerSpeedTest()}
                >
                  {serverLoading() ? '测速中…' : '测速'}
                </button>
                <Show when={serverError()}>
                  {(message) => <span class="settings__server-error">{message()}</span>}
                </Show>
              </div>
            </div>
            <Show when={serverSpeed()}>
              {(result) => (
                <div class="settings__server-list">
                  <For each={result().hosts}>
                    {(host) => (
                      <button
                        class="settings__server-item"
                        classList={{ 'settings__server-item--active': host.preferred }}
                        disabled={host.status !== 'ok' || serverSelecting() !== null}
                        title={host.error || `${host.host}:${host.port}`}
                        onClick={() => void chooseServer(host.host)}
                      >
                        <span class="settings__server-host">{host.host}</span>
                        <span class="settings__server-latency">
                          {host.status === 'ok' ? `${host.latencyMs.toFixed(1)} ms` : '连接失败'}
                        </span>
                        <span class="settings__server-state">
                          {host.preferred
                            ? '使用中'
                            : serverSelecting() === host.host
                              ? '切换中'
                              : '选择'}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              )}
            </Show>
          </div>

          <div class="settings__row">
            <div>
              <div class="settings__label">主图均线</div>
              <div class="settings__hint">五条均线周期，K 线重启后继续生效。</div>
            </div>
            <div class="settings__ma">
              <For each={[0, 1, 2, 3, 4]}>
                {(index) => (
                  <input
                    class={`settings__ma-${index}`}
                    type="number"
                    min="1"
                    max="120"
                    value={String(normalizeMaPeriods(appState.settings.maPeriods)[index])}
                    onChange={(event) => {
                      const next = normalizeMaPeriods(appState.settings.maPeriods)
                      const parsed = Number(event.currentTarget.value)
                      next[index] =
                        Number.isFinite(parsed) && parsed > 0
                          ? Math.min(250, Math.floor(parsed))
                          : next[index]
                      updateSettings({ maPeriods: next })
                    }}
                  />
                )}
              </For>
            </div>
          </div>

          <div class="settings__row">
            <div>
              <div class="settings__label">图表默认</div>
              <div class="settings__hint">周期、复权、对数、副图在图表头单独记忆。</div>
            </div>
            <button class="btn settings__reset" onClick={reset}>
              恢复默认
            </button>
          </div>
        </div>

        <footer class="settings__foot">
          <span>设置立即写入本地配置</span>
          <span>不包含交易与授权数据</span>
        </footer>
      </section>
    </div>
  )
}
