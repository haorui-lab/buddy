import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BuddyStore } from '../../../src/main/buddy/store'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }

describe('all task state writers share per-task serialization', () => {
  it.each(['update', 'event', 'transcript', 'drain'] as const)('serializes %s behind an outstanding state write without blocking other tasks', async path => {
    const dir = await mkdtemp(join(tmpdir(), 'buddy-store-concurrency-')); roots.push(dir)
    const store = new BuddyStore(dir)
    const { workspace_key: ws } = await store.createTask({ task_id: 'a', repo_root: join(dir, 'repo') })
    await store.createTask({ task_id: 'b', repo_root: join(dir, 'repo'), workspace_key: ws })
    await store.enqueueInstruction('a', ws, 'keep me')
    const arrived = gate(), release = gate()
    const originalWrite = (store as any).writeTaskState.bind(store)
    let first = true
    vi.spyOn(store as any, 'writeTaskState').mockImplementation(async (...args: any[]) => {
      if (args[0] === 'a' && first) { first = false; arrived.release(); await release.promise }
      return originalWrite(...args)
    })
    // This removes unrelated file-read scheduling from the event entry path.
    vi.spyOn(store as any, 'readEvents').mockResolvedValue([])
    const read = vi.spyOn(store, 'readTaskState')
    const a = store.updateTaskState('a', ws, s => ({ ...s, round: 99, derivation_wake_pending: true }))
    await arrived.promise
    const followers = {
      update: () => store.updateTaskState('a', ws, s => ({ ...s, status: 'DONE' })),
      event: () => store.appendTaskEvent('a', ws, { type: 'test', payload: {} }),
      transcript: () => store.appendTranscript('a', ws, 'system', 'receipt'),
      drain: () => store.drainInstructionQueue('a', ws)
    }
    const b = followers[path]()
    // Drain the known promise continuations, never a timer or timing race.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    try {
      expect(read.mock.calls.filter(call => call[0] === 'a')).toHaveLength(1)
      // A different task must finish while a is held, ruling out a global lock.
      await store.updateTaskState('b', ws, s => ({ ...s, round: 7 }))
    } finally { release.release(); await Promise.all([a, b]) }
    const result = await store.readTaskState('a', ws)
    expect(result.round).toBe(99); expect(result.derivation_wake_pending).toBe(true)
    if (path === 'update') expect(result.status).toBe('DONE')
    if (path === 'event') expect(result.event_seq).toBeGreaterThan(1)
    if (path === 'transcript') expect(result.transcript_seq).toBe(1)
    if (path === 'drain') expect(result.instruction_queue).toEqual([])
  })

  it('does not lose event or transcript rows and sequences under concurrent appends', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'buddy-store-seq-')); roots.push(dir)
    const store = new BuddyStore(dir)
    const { workspace_key: ws } = await store.createTask({ task_id: 'a', repo_root: join(dir, 'repo') })
    await Promise.all(Array.from({ length: 12 }, (_, i) => Promise.all([
      store.appendTaskEvent('a', ws, { type: 'test', payload: { i } }),
      store.appendTranscript('a', ws, 'system', `row ${i}`)
    ])))
    const result = await store.getTaskDetail('a', ws)
    expect(result.transcript).toHaveLength(12)
    expect(result.events).toHaveLength(13)
    expect(new Set(result.events.map(event => event.seq)).size).toBe(13)
    expect(result.state.transcript_seq).toBe(12)
  })
})
