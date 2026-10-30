import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuddyCoreService } from '../../../src/main/buddy/service'
import { BuddyStore } from '../../../src/main/buddy/store'

describe('BuddyCoreService recovery', () => {
  it('repairs legacy cascade-paused failures without starting the child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-recovery-failed-'))
    const store = new BuddyStore(root)
    const created = await store.createTask({ task_id: 'child', repo_root: '/tmp/repo', parent_task_id: 'parent' })
    await store.updateTaskState('child', created.workspace_key, state => ({
      ...state, status: 'PAUSED', pause_cause: 'cascade', pause_resume_status: 'FAILED',
      active_run: null, last_error: { message: 'original ACP error' }
    }))
    const service = new BuddyCoreService({ dataRoot: root })
    await service.recoverInterruptedRuns()
    const state = await store.readTaskState('child', created.workspace_key)
    expect(state.status).toBe('FAILED')
    expect(state.active_run).toBeNull()
    expect(state.last_error?.message).toBe('original ACP error')
    expect(state.pause_cause).toBeNull()
  })

  it('marks active runs interrupted on startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-recovery-'))
    const store = new BuddyStore(root)
    const created = await store.createTask({ task_id: 'demo', repo_root: '/tmp/repo' })
    await store.updateTaskState('demo', created.workspace_key, (state) => ({
      ...state,
      status: 'RUNNING_CODEX',
      active_run: { actor: 'codex', started_at: '2026-05-26T00:00:00.000Z' }
    }))

    const service = new BuddyCoreService({ dataRoot: root })
    await service.recoverInterruptedRuns()

    const detail = await store.getTaskDetail('demo', created.workspace_key)
    expect(detail.state.status).toBe('PAUSED')
    expect(detail.state.active_run).toBeNull()
  })
})
