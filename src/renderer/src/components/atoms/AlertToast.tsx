/**
 * 预警触发的轻量提示条：点击跳到对应股票，8 秒自动消失。
 */
import { createEffect, onCleanup, type JSX } from 'solid-js'
import type { AlertEvent } from '@shared/types'
import { IconBell, IconClose } from './Icons'

interface AlertToastProps {
  event: AlertEvent
  onDismiss: () => void
  onSelect: (code: string) => void
}

export function AlertToast(props: AlertToastProps): JSX.Element {
  createEffect(() => {
    // 读取 event 让每一条新预警重新计时；旧定时器不能关掉新提示
    const event = props.event
    const timer = window.setTimeout(() => {
      if (props.event === event) props.onDismiss()
    }, 8000)
    onCleanup(() => window.clearTimeout(timer))
  })

  return (
    <div class="alert-toast" role="status">
      <button
        class="alert-toast__main"
        onClick={() => {
          props.onSelect(props.event.rule.code)
          props.onDismiss()
        }}
      >
        <IconBell size={15} />
        <span class="alert-toast__text">{props.event.message}</span>
        <span class="alert-toast__time">
          {new Date(props.event.at).toLocaleTimeString('zh-CN')}
        </span>
      </button>
      <button class="alert-toast__close" title="关闭提示" onClick={() => props.onDismiss()}>
        <IconClose size={12} />
      </button>
    </div>
  )
}
