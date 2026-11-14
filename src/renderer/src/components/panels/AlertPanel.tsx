/**
 * 本地行情预警：规则编辑 + 今日触发记录。
 *
 * 规则只存在本机，不做条件单/交易；同一规则同一交易日只提示一次。
 */
import { createEffect, createSignal, For, untrack, Show, type JSX } from 'solid-js'
import type { AlertCondition, AlertDirection, AlertMetric, AlertRule, Quote } from '@shared/types'
import { ALERT_METRIC_LABELS, alertMetricValue, formatAlertValue } from '@shared/alerts'
import { fixed, signedPct } from '@shared/format'
import { addAlert, appState, removeAlert, toggleAlert } from '../../stores/app'
import { alertEvents } from '../../stores/alerts'
import { IconBell, IconClose } from '../atoms/Icons'

interface AlertPanelProps {
  quote: Quote | undefined
  onClose: () => void
  onSelect: (code: string) => void
  /** 作为主工作区标签页渲染（非弹窗） */
  embedded?: boolean
}

function describeCondition(condition: AlertCondition): string {
  const label =
    condition.direction === 'above'
      ? '≥'
      : condition.direction === 'below'
        ? '≤'
        : condition.direction === 'crossAbove'
          ? '上穿'
          : '下穿'
  return `${ALERT_METRIC_LABELS[condition.metric]} ${label} ${formatAlertValue(
    condition.metric,
    condition.value
  )}`
}

function describeConditions(rule: AlertRule): string {
  if (rule.groups && rule.groups.length > 0) {
    return rule.groups
      .map((group) => `(${group.map(describeCondition).join(' 且 ')})`)
      .join((rule.groupMode ?? 'or') === 'or' ? ' 或 ' : ' 且 ')
  }
  const conditions: AlertCondition[] =
    rule.conditions && rule.conditions.length > 0
      ? rule.conditions
      : [{ metric: rule.metric, direction: rule.direction, value: rule.value }]
  return conditions.map(describeCondition).join(rule.conditionMode === 'or' ? ' 或 ' : ' 且 ')
}

export function AlertPanel(props: AlertPanelProps): JSX.Element {
  const [metric, setMetric] = createSignal<AlertMetric>('price')
  const [direction, setDirection] = createSignal<AlertDirection>('above')
  const [value, setValue] = createSignal('')
  const [error, setError] = createSignal<string | null>(null)
  const [extras, setExtras] = createSignal<
    Array<{ metric: AlertMetric; direction: AlertDirection; value: string; group: 0 | 1 }>
  >([])
  const [conditionMode, setConditionMode] = createSignal<'and' | 'or'>('and')
  const [groupMode, setGroupMode] = createSignal<'and' | 'or'>('or')

  // 切换股票时用当前价/涨幅作为输入初值；只在 code 改变时重置
  createEffect(() => {
    const code = props.quote?.code
    if (!code) return
    const initial = untrack(() => props.quote)
    setValue(initial ? (initial.price > 0 ? fixed(initial.price) : fixed(initial.changePct)) : '')
    setMetric('price')
    setDirection('above')
    setExtras([])
    setConditionMode('and')
    setGroupMode('or')
    setError(null)
  })

  const submit = (): void => {
    const quote = props.quote
    if (!quote) return
    const parsed = Number(value())
    if (!Number.isFinite(parsed)) {
      setError('请输入有效阈值')
      return
    }
    const extrasWithValues = extras().map((condition) => ({
      metric: condition.metric,
      direction: condition.direction,
      value: Number(condition.value),
      group: condition.group
    }))
    const conditions =
      extrasWithValues.length > 0
        ? [
            { metric: metric(), direction: direction(), value: parsed },
            ...extrasWithValues.map((condition) => ({
              metric: condition.metric,
              direction: condition.direction,
              value: condition.value
            }))
          ]
        : undefined
    if (conditions && conditions.some((condition) => !Number.isFinite(condition.value))) {
      setError('请输入有效的组合条件阈值')
      return
    }
    const hasGroups = extrasWithValues.some((condition) => condition.group === 1)
    const groups = hasGroups
      ? [
          [
            { metric: metric(), direction: direction(), value: parsed },
            ...extrasWithValues
              .filter((condition) => condition.group === 0)
              .map((condition) => ({
                metric: condition.metric,
                direction: condition.direction,
                value: condition.value
              }))
          ],
          extrasWithValues
            .filter((condition) => condition.group === 1)
            .map((condition) => ({
              metric: condition.metric,
              direction: condition.direction,
              value: condition.value
            }))
        ]
      : undefined
    addAlert({
      code: quote.code,
      name: quote.name,
      metric: metric(),
      direction: direction(),
      value: parsed,
      conditions,
      conditionMode: !hasGroups && extras().length > 0 ? conditionMode() : undefined,
      groups,
      groupMode: hasGroups ? groupMode() : undefined
    })
    setError(null)
  }

  const hasGroups = (): boolean => extras().some((condition) => condition.group === 1)

  const changeMetric = (next: AlertMetric): void => {
    setMetric(next)
    const quote = props.quote
    if (!quote) return
    const initial = alertMetricValue(next, quote)
    setValue(Number.isFinite(initial) ? initial.toFixed(2) : '')
  }

  return (
    <div
      class="alert-backdrop"
      classList={{ 'panel-embed': props.embedded === true }}
      onClick={() => {
        if (!props.embedded) props.onClose()
      }}
    >
      <section
        class="alert-panel"
        role={props.embedded ? 'region' : 'dialog'}
        aria-modal={props.embedded ? undefined : 'true'}
        aria-label="行情预警"
        onClick={(event) => event.stopPropagation()}
      >
        <header class="alert__head">
          <div>
            <div class="alert__eyebrow">本地规则 · 同一天只提示一次</div>
            <h2 class="alert__title">行情预警</h2>
          </div>
          <button class="btn btn--icon btn--bare" title="关闭预警" onClick={() => props.onClose()}>
            <IconClose size={16} />
          </button>
        </header>

        <div class="alert__body">
          <Show
            when={props.quote}
            fallback={<div class="alert__hint">先在左侧选一只股票，再添加预警。</div>}
          >
            {(quote) => (
              <div class="alert__current">
                <IconBell size={14} />
                <span>
                  {quote().name} <code>{quote().code.toUpperCase()}</code>
                </span>
                <span class="num">{fixed(quote().price)}</span>
                <span
                  class="num"
                  classList={{
                    'tone-up': quote().changePct > 0,
                    'tone-down': quote().changePct < 0
                  }}
                >
                  {signedPct(quote().changePct)}
                </span>
              </div>
            )}
          </Show>

          <div class="alert__form">
            <select
              class="alert__select"
              value={metric()}
              aria-label="预警指标"
              onChange={(event) => changeMetric(event.currentTarget.value as AlertMetric)}
            >
              <For each={Object.entries(ALERT_METRIC_LABELS)}>
                {([value, label]) => <option value={value}>{label}</option>}
              </For>
            </select>
            <select
              class="alert__select"
              value={direction()}
              aria-label="触发方向"
              onChange={(event) => setDirection(event.currentTarget.value as AlertDirection)}
            >
              <option value="above">≥</option>
              <option value="below">≤</option>
              <option value="crossAbove">上穿</option>
              <option value="crossBelow">下穿</option>
            </select>
            <input
              class="alert__input"
              type="number"
              step="0.01"
              placeholder={
                metric() === 'price'
                  ? '阈值价格'
                  : metric() === 'volumeRatio'
                    ? '阈值量比'
                    : '阈值 %'
              }
              value={value()}
              onInput={(event) => setValue(event.currentTarget.value)}
            />
            <button class="btn btn--primary alert__add" disabled={!props.quote} onClick={submit}>
              添加
            </button>
          </div>
          <For each={extras()}>
            {(condition, index) => (
              <div class="alert__form alert__form--secondary">
                <select
                  class="alert__select"
                  value={condition.metric}
                  aria-label="组合条件指标"
                  onChange={(event) => {
                    const metric = event.currentTarget.value as AlertMetric
                    setExtras((items) =>
                      items.map((item, itemIndex) =>
                        itemIndex === index() ? { ...item, metric } : item
                      )
                    )
                  }}
                >
                  <For each={Object.entries(ALERT_METRIC_LABELS)}>
                    {([value, label]) => <option value={value}>{label}</option>}
                  </For>
                </select>
                <select
                  class="alert__select"
                  value={condition.direction}
                  aria-label="组合条件方向"
                  onChange={(event) => {
                    const direction = event.currentTarget.value as AlertDirection
                    setExtras((items) =>
                      items.map((item, itemIndex) =>
                        itemIndex === index() ? { ...item, direction } : item
                      )
                    )
                  }}
                >
                  <option value="above">≥</option>
                  <option value="below">≤</option>
                  <option value="crossAbove">上穿</option>
                  <option value="crossBelow">下穿</option>
                </select>
                <select
                  class="alert__select alert__group"
                  value={String(condition.group)}
                  aria-label="条件分组"
                  onChange={(event) => {
                    const group = Number(event.currentTarget.value) === 1 ? 1 : 0
                    setExtras((items) =>
                      items.map((item, itemIndex) =>
                        itemIndex === index() ? { ...item, group } : item
                      )
                    )
                  }}
                >
                  <option value="0">组1</option>
                  <option value="1">组2</option>
                </select>
                <input
                  class="alert__input"
                  type="number"
                  step="0.01"
                  placeholder="组合阈值"
                  value={condition.value}
                  onInput={(event) => {
                    const value = event.currentTarget.value
                    setExtras((items) =>
                      items.map((item, itemIndex) =>
                        itemIndex === index() ? { ...item, value } : item
                      )
                    )
                  }}
                />
                <button
                  class="alert__delete"
                  title="移除条件"
                  onClick={() => setExtras((items) => items.filter((_, i) => i !== index()))}
                >
                  ×
                </button>
              </div>
            )}
          </For>

          <Show when={extras().length > 0}>
            <div class="alert__mode">
              <span>{hasGroups() ? '组间关系' : '组合关系'}</span>
              <select
                class="alert__select alert__mode-select"
                value={hasGroups() ? groupMode() : conditionMode()}
                aria-label="组合条件关系"
                onChange={(event) => {
                  const mode = event.currentTarget.value as 'and' | 'or'
                  if (hasGroups()) setGroupMode(mode)
                  else setConditionMode(mode)
                }}
              >
                <option value="and">全部满足（且）</option>
                <option value="or">任一满足（或）</option>
              </select>
            </div>
          </Show>

          <button
            class="btn alert__add-condition"
            disabled={extras().length >= 3}
            onClick={() =>
              setExtras((items) => [
                ...items,
                { metric: 'changePct', direction: 'above', value: '', group: 0 }
              ])
            }
          >
            {extras().length >= 3 ? '最多 4 个条件' : '+ 条件'}
          </button>

          <Show when={error()}>
            <div class="alert__error">{error()}</div>
          </Show>

          <section class="alert__section">
            <div class="alert__section-head">
              <span>规则</span>
              <span>{appState.alerts.length} 条</span>
            </div>
            <Show
              when={appState.alerts.length > 0}
              fallback={<div class="alert__empty">还没有规则</div>}
            >
              <div class="alert__rules">
                <For each={appState.alerts}>
                  {(rule) => (
                    <div class="alert__rule" classList={{ 'alert__rule--off': !rule.enabled }}>
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        title={rule.enabled ? '暂停规则' : '启用规则'}
                        onChange={() => toggleAlert(rule.id)}
                      />
                      <button class="alert__rule-main" onClick={() => props.onSelect(rule.code)}>
                        <span class="alert__rule-name">{rule.name}</span>
                        <span class="alert__rule-desc">{describeConditions(rule)}</span>
                      </button>
                      <span class="alert__rule-state">
                        {rule.lastTriggeredDate ? `已触发 ${rule.lastTriggeredDate}` : '等待'}
                      </span>
                      <button
                        class="alert__delete"
                        title="删除规则"
                        onClick={() => removeAlert(rule.id)}
                      >
                        ×
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </section>

          <section class="alert__section">
            <div class="alert__section-head">
              <span>本次运行已触发</span>
              <span>{alertEvents().length} 条</span>
            </div>
            <Show
              when={alertEvents().length > 0}
              fallback={<div class="alert__empty">还没有触发记录</div>}
            >
              <div class="alert__events">
                <For each={alertEvents().slice(0, 8)}>
                  {(event) => (
                    <button class="alert__event" onClick={() => props.onSelect(event.rule.code)}>
                      <span>{event.message}</span>
                      <time>{new Date(event.at).toLocaleTimeString('zh-CN')}</time>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </section>
        </div>

        <footer class="alert__foot">
          <span>仅本地提示，不生成交易指令</span>
          <span>同一天同一规则只触发一次</span>
        </footer>
      </section>
    </div>
  )
}
