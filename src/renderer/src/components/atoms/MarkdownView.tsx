/**
 * 轻量 Markdown 渲染器（无 innerHTML，外部标题也不会变成 HTML）。
 *
 * 支持 F10 导出实际用到的：标题、段落、引用、列表、代码块、表格、粗体、行内代码。
 */
import { createMemo, For, type JSX } from 'solid-js'

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] }

export function MarkdownView(props: { source: string }): JSX.Element {
  const blocks = createMemo(() => parseMarkdown(props.source))
  return (
    <div class="markdown-body">
      <For each={blocks()}>
        {(block) => {
          switch (block.kind) {
            case 'heading':
              return block.level === 1 ? (
                <h1>{inline(block.text)}</h1>
              ) : block.level === 2 ? (
                <h2>{inline(block.text)}</h2>
              ) : (
                <h3>{inline(block.text)}</h3>
              )
            case 'quote':
              return <blockquote>{inline(block.text)}</blockquote>
            case 'list':
              return (
                <ul>
                  <For each={block.items}>{(item) => <li>{inline(item)}</li>}</For>
                </ul>
              )
            case 'code':
              return (
                <pre>
                  <code>{block.text}</code>
                </pre>
              )
            case 'table':
              return (
                <div class="markdown-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <For each={block.header}>{(cell) => <th>{inline(cell)}</th>}</For>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={block.rows}>
                        {(row) => (
                          <tr>
                            <For each={row}>{(cell) => <td>{inline(cell)}</td>}</For>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              )
            default:
              return <p>{inline(block.text)}</p>
          }
        }}
      </For>
    </div>
  )
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    if (!trimmed) {
      index += 1
      continue
    }
    if (trimmed.startsWith('```')) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith('```')) {
        code.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      blocks.push({ kind: 'code', text: code.join('\n') })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2] ?? '' })
      index += 1
      continue
    }
    if (/^\|/.test(trimmed)) {
      const table: string[] = []
      while (index < lines.length && /^\s*\|/.test(lines[index] ?? '')) {
        table.push(lines[index] ?? '')
        index += 1
      }
      const rows = table
        .map(splitRow)
        .filter((row) => !row.every((cell) => /^:?-{3,}:?$/.test(cell)))
      if (rows.length > 0) {
        blocks.push({ kind: 'table', header: rows[0] ?? [], rows: rows.slice(1) })
      }
      continue
    }
    if (trimmed.startsWith('>')) {
      blocks.push({ kind: 'quote', text: trimmed.replace(/^>\s?/, '') })
      index += 1
      continue
    }
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*[-*]\s+/, ''))
        index += 1
      }
      blocks.push({ kind: 'list', items })
      continue
    }
    blocks.push({ kind: 'paragraph', text: trimmed })
    index += 1
  }
  return blocks
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

function inline(text: string): JSX.Element {
  // 只解析 **粗体** 与 `行内代码`；不把任何 Markdown 当 HTML 注入。
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return (
    <>
      <For each={parts}>
        {(part) => {
          if (part.startsWith('**') && part.endsWith('**')) {
            return <strong>{part.slice(2, -2)}</strong>
          }
          if (part.startsWith('`') && part.endsWith('`')) {
            return <code>{part.slice(1, -1)}</code>
          }
          return <>{part}</>
        }}
      </For>
    </>
  )
}
