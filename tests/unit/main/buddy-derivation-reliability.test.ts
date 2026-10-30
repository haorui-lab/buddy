import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BuddyStore } from '../../../src/main/buddy/store'
import { BuddyRunner } from '../../../src/main/buddy/runner'
import type { TaskState } from '../../../src/shared/types'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-reliability-')); roots.push(dir)
  const store = new BuddyStore(join(dir, 'data'))
  const root = await store.createTask({ task_id: 'parent', repo_root: join(dir, 'repo') })
  await store.createTask({ task_id: 'child', workspace_key: root.workspace_key, repo_root: join(dir, 'repo'), parent_task_id: 'parent' })
  await store.updateTaskState('parent', root.workspace_key, s => ({ ...s, child_task_ids: ['child'] }))
  const runner = new BuddyRunner(store, { executeLaunchers: false })
  return { dir, store, runner, service: runner.derivation, ws: root.workspace_key }
}
const delivery = { version: 'v1', artifacts: 'file', verification: 'ok', open_issues: '', submitted_at: new Date().toISOString(), submitted_by: 'claude' }

// Inject a competing state transition immediately before the protected update callback.
function raceUpdate(store: BuddyStore, task: string, transition: Partial<TaskState>) {
  const original = store.updateTaskState.bind(store)
  let once = true
  vi.spyOn(store, 'updateTaskState').mockImplementation(async (id, ws, update) => {
    if (id === task && once) { once = false; await original(id, ws, s => ({ ...s, ...transition })) }
    return original(id, ws, update)
  })
}

describe('derivation reliability and stop conditions', () => {
  it.each(['DONE', 'CANCELLED', 'PAUSED'] as const)('wait preserves concurrent %s and its active run', async status => {
    const c = await setup()
    const active_run = { actor: 'claude', run_id: 'still-live', started_at: new Date().toISOString() }
    raceUpdate(c.store, 'parent', { status, pause_cause: status === 'PAUSED' ? 'user' : null, active_run })
    await expect(c.service.wait('parent', c.ws)).rejects.toThrow()
    const after = await c.store.readTaskState('parent', c.ws)
    expect(after.status).toBe(status); expect(after.active_run).toEqual(active_run)
  })

  it.each(['DONE', 'CANCELLED', 'AWAITING_ACCEPTANCE', 'PAUSED'] as const)('child result never revives concurrent parent %s', async status => {
    const c = await setup()
    await c.store.updateTaskState('parent', c.ws, s => ({ ...s, status: 'WAITING_CHILDREN' }))
    await c.store.updateTaskState('child', c.ws, s => ({ ...s, status: 'FAILED' }))
    raceUpdate(c.store, 'parent', { status, pause_cause: status === 'PAUSED' ? 'user' : null })
    await c.service.notifyParent('child', c.ws, 'failed', true)
    expect((await c.store.readTaskState('parent', c.ws)).status).toBe(status)
  })

  it('clears rejection on a new delivery but refuses an already accepted DONE child', async () => {
    const c = await setup()
    const rejection = { decision: 'reject' as const, comment: 'redo', at: new Date().toISOString(), actor: 'codex', version: 'v1' }
    await c.store.updateTaskState('child', c.ws, s => ({ ...s, acceptance: rejection }))
    await c.service.submit('child', c.ws, 'claude', { version: 'v2' })
    expect((await c.store.readTaskState('child', c.ws)).acceptance ?? null).toBeNull()
    const acceptance = { ...rejection, decision: 'accept' as const, version: 'v2' }
    await c.store.updateTaskState('child', c.ws, s => ({ ...s, status: 'DONE', acceptance }))
    await expect(c.service.submit('child', c.ws, 'claude', { version: 'v3' })).rejects.toThrow()
    expect((await c.store.readTaskState('child', c.ws)).acceptance).toEqual(acceptance)
  })

  it('wakes for corrupt children, displays corruption, and still blocks completion', async () => {
    const c = await setup()
    await c.store.updateTaskState('parent', c.ws, s => ({ ...s, status: 'WAITING_CHILDREN' }))
    await writeFile(c.store.statePath('child', c.ws), '{broken')
    expect(await c.service.childrenNeedParent('parent', c.ws)).toBe(true)
    expect(await c.service.promptSection('parent', c.ws)).toContain('损坏')
    expect(await c.service.promptSection('parent', c.ws)).not.toContain('MISSING')
    await expect(c.service.review('parent', c.ws, 'codex', 'child', 'accept', 'yes')).rejects.toThrow()
    expect(await c.service.releaseWaitIfChildrenReady('parent', c.ws)).toBe(true)
    expect((await c.store.readTaskState('parent', c.ws)).status).toBe('READY')
    const state = await c.store.readTaskState('parent', c.ws)
    const snapshots = await (c.runner as any).childSnapshots(state, c.ws)
    expect(snapshots).toEqual([expect.objectContaining({ status: 'FAILED' })])
  })

  it('refuses acceptance if a descendant state is unreadable', async () => {
    const c = await setup()
    await c.store.createTask({ task_id: 'grand', workspace_key: c.ws, repo_root: join(c.dir, 'repo'), parent_task_id: 'child' })
    await c.store.updateTaskState('child', c.ws, s => ({ ...s, status: 'AWAITING_ACCEPTANCE', child_task_ids: ['grand'], delivery }))
    await writeFile(c.store.statePath('grand', c.ws), '{broken')
    await expect(c.service.review('parent', c.ws, 'codex', 'child', 'accept', 'yes')).rejects.toThrow(/下级/)
  })

  it('dual break with an unfinished child pauses instead of launching another round', async () => {
    const c = await setup()
    await c.store.updateTaskState('child', c.ws, s => ({ ...s, status: 'FAILED' }))
    await c.runner.startTask('parent', { workspace_key: c.ws, actor: 'claude' })
    let state = await c.store.readTaskState('parent', c.ws)
    await (c.runner as any).completeActor('parent', c.ws, 'claude', state.active_run!.run_id, '{"type":"break","content":"cannot proceed"}', [], 1, 0)
    await c.runner.startTask('parent', { workspace_key: c.ws, actor: 'codex' })
    state = await c.store.readTaskState('parent', c.ws)
    const terminal = vi.fn(); c.runner.onTaskTerminal = terminal
    await (c.runner as any).completeActor('parent', c.ws, 'codex', state.active_run!.run_id, '{"type":"break","content":"stop here"}', [], 1, 0)
    state = await c.store.readTaskState('parent', c.ws)
    expect(state.status).toBe('PAUSED'); expect(state.active_run).toBeNull(); expect(terminal).toHaveBeenCalled()
  })

  it('pausing/resuming a parent preserves failure and does not retry a failed child', async () => {
    const c = await setup()
    await c.store.updateTaskState('child', c.ws, s => ({ ...s, status: 'FAILED', last_error: { message: 'ACP failed' } }))
    await c.runner.interrupt('parent', c.ws)
    expect((await c.store.readTaskState('child', c.ws)).status).toBe('FAILED')
    await c.runner.startTask('parent', { workspace_key: c.ws })
    await (c.runner as any).resumeCascaded('parent', c.ws)
    expect((await c.store.readTaskState('child', c.ws)).status).toBe('FAILED')
  })

  it('restores legacy cascade-paused failures without starting them', async () => {
    const c = await setup()
    await c.store.updateTaskState('child', c.ws, s => ({ ...s, status: 'PAUSED', pause_cause: 'cascade', pause_resume_status: 'FAILED', last_error: { message: 'ACP failed' } }))
    await (c.runner as any).resumeCascaded('parent', c.ws)
    expect((await c.store.readTaskState('child', c.ws)).status).toBe('FAILED')
  })

  it('an actor completion cannot undo a concurrent user pause', async () => {
    const c = await setup()
    await c.runner.startTask('parent', { workspace_key: c.ws, actor: 'claude' })
    const state = await c.store.readTaskState('parent', c.ws)
    raceUpdate(c.store, 'parent', { status: 'PAUSED', pause_cause: 'user', active_run: null })
    await (c.runner as any).completeActor('parent', c.ws, 'claude', state.active_run!.run_id, '{"type":"chat","content":"working"}', [], 1, 0)
    const after = await c.store.readTaskState('parent', c.ws)
    expect(after.status).toBe('PAUSED'); expect(after.pause_cause).toBe('user'); expect(after.active_run).toBeNull()
  })

  it('a late actor failure cannot overwrite a concurrent user pause', async () => {
    const c = await setup()
    await c.runner.startTask('parent', { workspace_key: c.ws, actor: 'claude' })
    const state = await c.store.readTaskState('parent', c.ws)
    raceUpdate(c.store, 'parent', { status: 'PAUSED', pause_cause: 'user', active_run: null })
    await (c.runner as any).markFailed('parent', c.ws, 'claude', 'late error', state.active_run!.run_id)
    expect((await c.store.readTaskState('parent', c.ws)).status).toBe('PAUSED')
  })

  it('reviewer failure after a break cannot bypass required children', async () => {
    const c = await setup()
    await c.store.updateTaskState('child', c.ws, s => ({ ...s, status: 'FAILED' }))
    await c.runner.startTask('parent', { workspace_key: c.ws, actor: 'codex' })
    await c.store.updateTaskState('parent', c.ws, s => ({ ...s, pending_break: { actor: 'claude', round: 1 } }))
    const state = await c.store.readTaskState('parent', c.ws)
    await (c.runner as any).markFailed('parent', c.ws, 'codex', 'ACP stream ended', state.active_run!.run_id)
    expect((await c.store.readTaskState('parent', c.ws)).status).toBe('PAUSED')
    const detail = await c.store.getTaskDetail('parent', c.ws)
    expect(detail.events.some(e => e.type === 'task.done')).toBe(false)
    expect(detail.events.some(e => e.type === 'task.completion_blocked')).toBe(true)
  })

  it('counts child failures even when the other actor already requested break', async () => {
    const c = await setup()
    await c.runner.startTask('child', { workspace_key: c.ws, actor: 'codex' })
    await c.store.updateTaskState('child', c.ws, s => ({ ...s, consecutive_failures: 1, pending_break: { actor: 'claude', round: 1 } }))
    const state = await c.store.readTaskState('child', c.ws)
    await (c.runner as any).markFailed('child', c.ws, 'codex', 'ACP stream ended', state.active_run!.run_id)
    expect((await c.store.readTaskState('child', c.ws)).consecutive_failures).toBe(2)
  })

  it('an automatic child-result wake cannot restart a parent paused after its state update', async () => {
    const c = await setup()
    await c.store.updateTaskState('parent', c.ws, s => ({ ...s, status: 'WAITING_CHILDREN' }))
    await c.store.updateTaskState('child', c.ws, s => ({ ...s, status: 'FAILED' }))
    const original = c.runner.startTask.bind(c.runner)
    const start = vi.spyOn(c.runner, 'startTask').mockImplementation(async (...args) => {
      await c.store.updateTaskState('parent', c.ws, s => ({ ...s, status: 'PAUSED', pause_cause: 'user' }))
      return original(...args)
    })
    await c.service.notifyParent('child', c.ws, 'failed', true)
    await start.mock.results[0].value.catch(() => {})
    expect((await c.store.readTaskState('parent', c.ws)).status).toBe('PAUSED')
  })

  it('restart preserves failure count and enforces the configured ceiling', async () => {
    const c = await setup()
    await c.store.updateGlobalSettings({ ...(await c.store.readGlobalSettings()), max_consecutive_failures: 3 })
    await c.store.updateTaskState('child', c.ws, s => ({ ...s, status: 'FAILED', consecutive_failures: 2 }))
    const started = vi.spyOn(c.runner, 'startTask')
    await c.service.restart('parent', c.ws, 'claude', 'child')
    await started.mock.results[0].value
    expect((await c.store.readTaskState('child', c.ws)).consecutive_failures).toBe(2)
    await c.store.updateTaskState('child', c.ws, s => ({ ...s, status: 'FAILED', active_run: null, consecutive_failures: 3 }))
    await expect(c.service.restart('parent', c.ws, 'codex', 'child')).rejects.toThrow(/上限/)
    expect((await c.store.readTaskState('child', c.ws)).status).toBe('FAILED')
  })

  it('restart does not overwrite a child that changed after the FAILED snapshot', async () => {
    const c = await setup()
    await c.store.updateTaskState('child', c.ws, s => ({ ...s, status: 'FAILED', consecutive_failures: 0 }))
    const active_run = { actor: 'claude', run_id: 'already-live', started_at: new Date().toISOString() }
    // 锁外读到 FAILED 后、回调执行前，用户已经把子任务重新启动了。
    raceUpdate(c.store, 'child', { status: 'RUNNING_CLAUDE', active_run })
    await expect(c.service.restart('parent', c.ws, 'claude', 'child')).rejects.toThrow(/没有执行重启/)
    const after = await c.store.readTaskState('child', c.ws)
    expect(after.status).toBe('RUNNING_CLAUDE')
    expect(after.active_run).toEqual(active_run)
  })

  it('resumeCascaded does not overwrite a child the user already resumed', async () => {
    const c = await setup()
    const active_run = { actor: 'claude', run_id: 'user-resumed', started_at: new Date().toISOString() }
    await c.store.updateTaskState('child', c.ws, s => ({
      ...s, status: 'PAUSED', pause_cause: 'cascade', pause_resume_status: 'FAILED'
    }))
    // 锁外读到 cascade 暂停后、回调执行前，用户已经把子任务拉起来了。
    raceUpdate(c.store, 'child', { status: 'RUNNING_CLAUDE', pause_cause: null, pause_resume_status: undefined, active_run })
    await (c.runner as any).resumeCascaded('parent', c.ws)
    const after = await c.store.readTaskState('child', c.ws)
    expect(after.status).toBe('RUNNING_CLAUDE')
    expect(after.active_run).toEqual(active_run)
  })

  it('resumeCascaded restores a cascade-paused child that is still paused', async () => {
    const c = await setup()
    await c.store.updateTaskState('child', c.ws, s => ({
      ...s, status: 'PAUSED', pause_cause: 'cascade', pause_resume_status: 'FAILED', active_run: null
    }))
    await (c.runner as any).resumeCascaded('parent', c.ws)
    const after = await c.store.readTaskState('child', c.ws)
    expect(after.status).toBe('FAILED')
    expect(after.pause_cause ?? null).toBeNull()
    expect(after.active_run ?? null).toBeNull()
  })
})
