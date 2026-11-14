/**
 * 空状态：自选股被清空时显示。
 */
import type { JSX } from 'solid-js'

export function EmptyState(): JSX.Element {
  return (
    <div class="empty">
      <svg
        class="empty__art"
        viewBox="0 0 120 120"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        style={{ color: 'var(--text-3)' }}
      >
        <defs>
          <linearGradient id="empty-line" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stop-color="var(--accent)" />
            <stop offset="100%" stop-color="var(--accent-2)" />
          </linearGradient>
        </defs>
        <rect x="14" y="20" width="92" height="72" rx="12" stroke-width="1.4" opacity="0.5" />
        <path d="M26 76 L44 58 L58 68 L78 40 L94 52" stroke="url(#empty-line)" stroke-width="2.4" />
        <circle cx="78" cy="40" r="3.6" fill="url(#empty-line)" stroke="none" />
        <path d="M26 92h68" stroke-width="1.4" opacity="0.35" />
        <path d="M26 32h20" stroke-width="1.4" opacity="0.35" />
      </svg>

      <div class="empty__title">还没有选中的股票</div>
      <div class="empty__desc">
        在右上角的搜索框里输入股票名称、拼音或代码（例如「茅台」「600519」），
        回车即可加入自选并开始查看行情。
      </div>
    </div>
  )
}
