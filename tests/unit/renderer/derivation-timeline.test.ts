import { describe, expect, it } from 'vitest'
import { derivationTimeline } from '../../../src/renderer/lib/derivationTimeline'
import type { TaskState, TranscriptEntry } from '../../../src/shared/types'

const state = { status: 'WAITING_CHILDREN', active_run: null } as TaskState
const entry = (role: TranscriptEntry['role'], content: string, kind?: string, ts = '2026-10-29T11:10:01Z'): TranscriptEntry => ({ role, content, ts, meta: kind ? { kind } : {} })
const notice = (kind: string, content = kind) => entry('system', content, `derivation.${kind}`)
const actor = entry('cursor', 'Actor conclusion')

describe('derivation timeline presentation', () => {
  it('groups receipts after the actor conclusion without mutating stored order', () => {
    const transcript = [notice('proposed'), notice('decided'), notice('created'), actor]
    const result = derivationTimeline(transcript, state)
    expect(result.map(item => item.entries.map(e => e.content))).toEqual([
      ['Actor conclusion'], ['proposed', 'decided', 'created']
    ])
    expect(transcript[0].content).toBe('proposed')
    expect(result.map(item => item.key)).toEqual([3, 0])
  })

  it('waits for the current actor to finish, then shows its receipts', () => {
    const transcript = [notice('proposed')]
    const running = { status: 'RUNNING_CURSOR', active_run: { actor: 'cursor', started_at: '2026-10-29T11:10:00Z' } } as TaskState
    expect(derivationTimeline(transcript, running)).toEqual([])
    expect(derivationTimeline([...transcript, actor], running)).toHaveLength(2)
  })

  it.each(['FAILED', 'PAUSED', 'CANCELLED'] as const)('keeps receipts visible after %s even without a conclusion', status => {
    expect(derivationTimeline([notice('proposed')], { ...state, status })).toHaveLength(1)
  })

  it('never moves receipts across human instructions or failures', () => {
    for (const barrier of [entry('human', 'Stop here'), entry('system', 'Actor failed', 'error')]) {
      const result = derivationTimeline([notice('decided'), barrier, actor], state)
      expect(result.map(item => item.entries[0].content)).toEqual(['decided', barrier.content, actor.content])
    }
  })

  it('surfaces child failures and incoming acceptance immediately while the actor is running', () => {
    const running = { status: 'RUNNING_CURSOR', active_run: { actor: 'cursor', started_at: '2026-10-29T11:10:00Z' } } as TaskState
    const incoming = [notice('child_failed'), notice('reviewed', '父任务 验收通过。通过')]
    expect(derivationTimeline(incoming, running).map(item => item.entries[0])).toEqual(incoming)
  })

  it('keeps old receipts visible when a different run starts', () => {
    expect(derivationTimeline([notice('decided')], { status: 'RUNNING_CURSOR', active_run: { actor: 'cursor', started_at: '2026-10-29T11:11:00Z' } })).toHaveLength(1)
  })

  it('leaves ordinary conversations unchanged', () => {
    const transcript = [entry('human', 'Hello'), actor, entry('system', 'Round complete', 'round_notice')]
    expect(derivationTimeline(transcript, state).flatMap(item => item.entries)).toEqual(transcript)
  })
})
