import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MessageBubble } from '../../../src/renderer/components/MessageBubble'
import type { TranscriptEntry } from '../../../src/shared/types'

function transcriptEntry(role: TranscriptEntry['role'], content = 'Short message'): TranscriptEntry {
  return {
    role,
    content,
    ts: '2026-05-26T07:30:00.000Z'
  }
}

describe('MessageBubble layout', () => {
  it('clearly distinguishes failed partial output from an actor conclusion', () => {
    const entry = transcriptEntry('codex', 'some work before interruption')
    entry.meta = { partial: true, kind: 'actor_partial' }
    const html = renderToStaticMarkup(<MessageBubble entry={entry} />)
    expect(html).toContain('Interrupted · partial output')
    expect(html).toContain('health-check-failed')
    expect(html).toContain('some work before interruption')
  })

  it('shows blocked completion as a short error notice while retaining original details', () => {
    const entry = transcriptEntry('system', '还有子任务未验收通过（child-1），不能结束当前任务。已取消的子任务需要先 waive 并写明原因。')
    entry.meta = { kind: 'round_notice' }
    const html = renderToStaticMarkup(<MessageBubble entry={entry} />)
    expect(html).toContain('health-check-failed')
    expect(html).not.toContain('round-notice')
    expect(html).toContain('The parent task cannot finish yet.')
    expect(html).toContain('<details')
    expect(html).toContain('child-1')
  })

  it('gives human message cards a minimum width of two thirds', () => {
    const html = renderToStaticMarkup(
      <MessageBubble entry={transcriptEntry('human')} />
    )

    expect(html).toContain('justify-end')
    expect(html).toContain('min-w-[66.666667%] max-w-[82%]')
  })

  it('keeps agent message cards full width', () => {
    const html = renderToStaticMarkup(
      <MessageBubble entry={transcriptEntry('codex')} />
    )

    expect(html).toContain('justify-start')
    expect(html).toContain('w-full')
    expect(html).not.toContain('min-w-[66.666667%]')
  })

  it('renders system messages as cards with the msg-system class', () => {
    const html = renderToStaticMarkup(
      <MessageBubble entry={transcriptEntry('system', 'codex run failed')} />
    )

    expect(html).toContain('msg-system')
    expect(html).toContain('w-full')
    expect(html).not.toContain('justify-center')
    expect(html).not.toContain('rounded-full')
  })
})
