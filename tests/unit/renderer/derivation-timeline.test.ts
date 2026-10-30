import { describe, expect, it } from 'vitest'
import { derivationTimeline } from '../../../src/renderer/lib/derivationTimeline'
import type { Event, TaskState, TranscriptEntry } from '../../../src/shared/types'

const state = { status: 'WAITING_CHILDREN', active_run: null } as TaskState
const entry = (role: TranscriptEntry['role'], content: string, kind?: string, ts = '2026-10-29T11:10:01Z'): TranscriptEntry => ({ role, content, ts, meta: kind ? { kind } : {} })
const notice = (kind: string, content = kind) => entry('system', content, `derivation.${kind}`)
const actor = entry('cursor', 'Actor conclusion')

describe('derivation timeline presentation', () => {
  it('adds an end-of-turn status snapshot after a stale historical conclusion without rewriting it', () => {
    const conclusion = { ...actor, content: '子任务还在运行，不能验收。', meta: { run_id: 'r1' } }
    const events = [
      { seq: 1, type: 'actor.started', run_id: 'r1', ts: actor.ts, payload: {} },
      { seq: 2, type: 'derivation.child_delivered', ts: actor.ts, payload: { child_task_id: 'child', message: '子任务 工具 已完成内部确认，等待验收。' } },
      { seq: 3, type: 'actor.completed', run_id: 'r1', ts: actor.ts, payload: {} },
      { seq: 4, type: 'derivation.child_failed', ts: actor.ts, payload: { child_task_id: 'child', message: '子任务 工具 失败。' } }
    ] as Event[]
    const transcript = [conclusion]
    const result = derivationTimeline(transcript, state, events)
    expect(result[0].entries[0]).toBe(conclusion)
    expect(result[1].entries[0].meta).toMatchObject({ kind: 'derivation.child_status_refreshed', child_task_id: 'child', child_status: 'AWAITING_ACCEPTANCE' })
    expect(conclusion.content).toBe('子任务还在运行，不能验收。')
    expect(conclusion.meta).toEqual({ run_id: 'r1' })
    expect(transcript).toHaveLength(1)
  })

  it('prefers the saved real snapshot and does not duplicate it with inferred updates', () => {
    const conclusion = { ...actor, meta: { run_id: 'r1', child_updates: [{ child_task_id: 'child', child_status: 'DONE', version: 'hash' }] } }
    const events = [
      { seq: 1, type: 'actor.started', run_id: 'r1', ts: actor.ts, payload: {} },
      { seq: 2, type: 'derivation.child_delivered', ts: actor.ts, payload: { child_task_id: 'child', message: 'ready' } },
      { seq: 3, type: 'actor.completed', run_id: 'r1', ts: actor.ts, payload: {} }
    ] as Event[]
    const result = derivationTimeline([conclusion], state, events)
    expect(result).toHaveLength(2)
    expect(result[1].entries).toHaveLength(1)
    expect(result[1].entries[0].meta).toMatchObject({ child_status: 'DONE', version: 'hash' })
  })

  it('does not infer snapshots for an interrupted or unfinished turn', () => {
    const events = [
      { seq: 1, type: 'actor.started', run_id: 'r1', ts: actor.ts, payload: {} },
      { seq: 2, type: 'derivation.child_delivered', ts: actor.ts, payload: { child_task_id: 'child', message: 'ready' } },
      { seq: 3, type: 'actor.interrupted', ts: actor.ts, payload: {} }
    ] as Event[]
    expect(derivationTimeline([{ ...actor, meta: { run_id: 'r1', partial: true } }], state, events)).toHaveLength(1)
  })

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
    const incoming = [notice('child_submitted'), notice('child_delivered'), notice('child_failed'), notice('reviewed', '父任务 验收通过。通过')]
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
