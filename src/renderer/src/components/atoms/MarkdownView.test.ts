import { describe, expect, it } from 'vitest'
import { parseMarkdown } from './MarkdownView'

describe('MarkdownView 渲染模型', () => {
  it('标题、引用、表格和转义竖线都按 Markdown 解析', () => {
    const blocks = parseMarkdown(
      '# 标题\n\n> 来源：7615\n\n| 日期 | 标题 |\n| --- | --- |\n| 2026-10-31 | A\\|B |'
    )
    expect(blocks[0]).toEqual({ kind: 'heading', level: 1, text: '标题' })
    expect(blocks[1]).toEqual({ kind: 'quote', text: '来源：7615' })
    expect(blocks[2]?.kind).toBe('table')
    if (blocks[2]?.kind === 'table') {
      expect(blocks[2].header).toEqual(['日期', '标题'])
      expect(blocks[2].rows[0]).toEqual(['2026-10-31', 'A|B'])
    }
  })

  it('列表与代码块保留内容', () => {
    const blocks = parseMarkdown('- 甲\n- 乙\n\n```\nconst a = 1\n```')
    expect(blocks[0]).toEqual({ kind: 'list', items: ['甲', '乙'] })
    expect(blocks[1]).toEqual({ kind: 'code', text: 'const a = 1' })
  })
})
