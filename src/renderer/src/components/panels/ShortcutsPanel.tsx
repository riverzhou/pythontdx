/** 快捷键帮助：只列真正生效的键，不把计划中的写进来。 */
import { For, type JSX } from 'solid-js'
import { IconClose } from '../atoms/Icons'

const GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: '全局',
    items: [
      ['/', '聚焦搜索框'],
      ['R', '立即刷新行情'],
      ['T', '切换深浅主题'],
      ['F3 / F4', '上证指数 / 深证成指'],
      ['F5', '分时 ↔ 日 K'],
      ['F6', '回到行情标签'],
      ['F7', '打开 / 关闭公告'],
      ['F9', '条件选股'],
      ['F10', '打开 / 关闭 F10 公司资料'],
      ['F11', '切换系统全屏'],
      ['60 / 63 / 77', '排行榜 / 全部 A 股 / 龙虎榜'],
      ['?', '打开 / 关闭本帮助'],
      ['Esc', '关闭弹窗或当前标签']
    ]
  },
  {
    title: 'K 线图',
    items: [
      ['↑ / ↓', '放大 / 缩小可见根数'],
      ['← / →', '移动十字光标'],
      ['End', '回到最新一根'],
      ['Delete', '删除选中的画线'],
      ['Ctrl+C / Ctrl+V', '复制 / 粘贴选中的画线'],
      ['Ctrl+Z / Ctrl+Y', '撤销 / 重做画线'],
      ['Esc', '收起十字光标']
    ]
  }
]

export function ShortcutsPanel(props: { onClose: () => void }): JSX.Element {
  return (
    <div class="shortcuts-backdrop" onClick={() => props.onClose()}>
      <section
        class="shortcuts-panel"
        role="dialog"
        aria-modal="true"
        aria-label="快捷键"
        onClick={(event) => event.stopPropagation()}
      >
        <header class="shortcuts__head">
          <div>
            <div class="shortcuts__eyebrow">键盘操作</div>
            <h2 class="shortcuts__title">快捷键</h2>
          </div>
          <button class="btn btn--icon btn--bare" title="关闭帮助" onClick={() => props.onClose()}>
            <IconClose size={16} />
          </button>
        </header>
        <div class="shortcuts__body">
          <For each={GROUPS}>
            {(group) => (
              <div class="shortcuts__group">
                <div class="shortcuts__group-title">{group.title}</div>
                <For each={group.items}>
                  {([key, label]) => (
                    <div class="shortcuts__row">
                      <kbd>{key}</kbd>
                      <span>{label}</span>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
        <footer class="shortcuts__foot">在输入框中不会触发全局快捷键</footer>
      </section>
    </div>
  )
}
