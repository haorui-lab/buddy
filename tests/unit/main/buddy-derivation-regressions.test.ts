import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BuddyRunner } from '../../../src/main/buddy/runner'
import { BuddyStore } from '../../../src/main/buddy/store'
import { derivedTaskId, resolveBreakOutcome } from '../../../src/main/buddy/derivation'
import { QueueCoordinator } from '../../../src/main/buddy/queue-coordinator'
import { taskChildren } from '../../../src/renderer/lib/taskList'
import type { DerivationSpec, Task } from '../../../src/shared/types'

const spec = (key = 'child', goal = `goal ${key}`): DerivationSpec => ({
  key,
  title: key,
  goal,
  scope: 'own files',
  context: 'context',
  dependencies: [],
  deliverables: 'files',
  acceptance: 'tests'
})

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout.trim())
    })
  })
}

async function setup(repo?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-derive-fix-'))
  const store = new BuddyStore(join(dir, 'data'))
  await store.updateGlobalSettings({ ...(await store.readGlobalSettings()), allow_nested_derivation: true })
  const root = await store.createTask({ task_id: 'root', repo_root: repo || join(dir, 'not-a-repo') })
  const runner = new BuddyRunner(store, { executeLaunchers: false })
  return { dir, store, runner, service: runner.derivation, ws: root.workspace_key }
}

async function derive(ctx: Awaited<ReturnType<typeof setup>>, parent: string, specs = [spec()]) {
  await ctx.service.propose(parent, ctx.ws, 'claude', specs)
  await ctx.service.decide(parent, ctx.ws, 'claude', 'agree', 'agree')
  await ctx.service.decide(parent, ctx.ws, 'codex', 'agree', 'agree')
  return (await ctx.service.create(parent, ctx.ws)).task_ids
}

async function markAwaiting(store: BuddyStore, taskId: string, workspaceKey: string) {
  await store.updateTaskState(taskId, workspaceKey, current => ({
    ...current,
    status: 'AWAITING_ACCEPTANCE',
    active_run: null,
    updated_at: new Date().toISOString()
  }))
}

describe('derivation review regressions', () => {
  it('does not accept a running child or a child whose descendants are unfinished', async () => {
    const ctx = await setup()
    const [child] = await derive(ctx, 'root')
    const [grand] = await derive(ctx, child)
    await ctx.service.submit(child, ctx.ws, 'claude', { version: 'unversioned', artifacts: 'file', verification: 'not checked' })
    await expect(ctx.service.review('root', ctx.ws, 'codex', child, 'accept', 'accepted early')).rejects.toThrow(/内部确认/)
    expect((await ctx.store.readTaskState(child, ctx.ws)).status.startsWith('RUNNING')).toBe(true)
    expect((await ctx.store.readTaskState(grand, ctx.ws)).status.startsWith('RUNNING')).toBe(true)

    await markAwaiting(ctx.store, child, ctx.ws)
    await expect(ctx.service.review('root', ctx.ws, 'codex', child, 'accept', 'accepted early')).rejects.toThrow(/下级/)
    expect((await ctx.store.readTaskState(child, ctx.ws)).status).toBe('AWAITING_ACCEPTANCE')

    await ctx.service.submit(grand, ctx.ws, 'claude', { version: 'unversioned', artifacts: 'file', verification: 'ok' })
    await markAwaiting(ctx.store, grand, ctx.ws)
    await ctx.service.review(child, ctx.ws, 'codex', grand, 'accept', 'grandchild done')
    await ctx.service.review('root', ctx.ws, 'codex', child, 'accept', 'child done')
    const after = await ctx.store.readTaskState(child, ctx.ws)
    expect(after.status).toBe('DONE')
    expect((await ctx.store.readTaskState(grand, ctx.ws)).status).toBe('DONE')
    expect(resolveBreakOutcome({}, [{ task_id: child, status: after.status }])).toBe('done')
  })

  it('starts a grandchild at its direct parent HEAD', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'buddy-derive-base-'))
    await git(temp, ['init'])
    await git(temp, ['config', 'user.name', 'Review'])
    await git(temp, ['config', 'user.email', 'review@example.invalid'])
    await writeFile(join(temp, 'base.txt'), 'base')
    await git(temp, ['add', '.'])
    await git(temp, ['commit', '-m', 'base'])
    const ctx = await setup(temp)
    const [child] = await derive(ctx, 'root')
    const parent = await ctx.store.readTaskState(child, ctx.ws)
    await writeFile(join(parent.work_dir!, 'parent-change.txt'), 'needed by grandchild')
    await git(parent.work_dir!, ['add', '.'])
    await git(parent.work_dir!, ['commit', '-m', 'parent work'])
    const [grand] = await derive(ctx, child)
    const grandchild = await ctx.store.readTaskState(grand, ctx.ws)
    const parentHead = await git(parent.work_dir!, ['rev-parse', 'HEAD'])
    const grandHead = await git(grandchild.work_dir!, ['rev-parse', 'HEAD'])
    const fileExists = await access(join(grandchild.work_dir!, 'parent-change.txt')).then(() => true, () => false)
    expect(grandHead).toBe(parentHead)
    expect(fileExists).toBe(true)
  })

  it('does not treat a failed worktree add as an empty directory', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'buddy-derive-wt-'))
    await git(temp, ['init'])
    await git(temp, ['config', 'user.name', 'Review'])
    await git(temp, ['config', 'user.email', 'review@example.invalid'])
    await writeFile(join(temp, 'base.txt'), 'base')
    await git(temp, ['add', '.'])
    await git(temp, ['commit', '-m', 'base'])
    const ctx = await setup(temp)
    const childId = derivedTaskId('root', 'child')
    const dest = join(ctx.store.dataRoot, 'runtime', 'worktrees', ctx.ws, childId)
    await mkdir(dest, { recursive: true })
    await writeFile(join(dest, 'block.txt'), 'occupied')
    await ctx.service.propose('root', ctx.ws, 'claude', [spec()])
    await ctx.service.decide('root', ctx.ws, 'claude', 'agree', 'yes')
    await ctx.service.decide('root', ctx.ws, 'codex', 'agree', 'yes')
    await expect(ctx.service.create('root', ctx.ws)).rejects.toThrow(/工作版本/)
    expect((await ctx.store.getTasks()).some(task => task.task_id === childId)).toBe(false)
  })

  it('resumes grandchildren when a waiting child is resumed', async () => {
    const ctx = await setup()
    const [child] = await derive(ctx, 'root')
    const [grand] = await derive(ctx, child)
    await ctx.store.updateTaskState(child, ctx.ws, current => ({ ...current, status: 'WAITING_CHILDREN', active_run: null }))
    await ctx.runner.interrupt('root', ctx.ws)
    await ctx.runner.startTask('root', { workspace_key: ctx.ws })
    await vi.waitFor(async () => {
      const parent = await ctx.store.readTaskState(child, ctx.ws)
      const grandchild = await ctx.store.readTaskState(grand, ctx.ws)
      expect(parent.status).toBe('WAITING_CHILDREN')
      expect(grandchild.status.startsWith('RUNNING')).toBe(true)
      expect(grandchild.pause_cause ?? null).toBeNull()
    })
  })

  it('wakes a parent that asked to wait before the child result arrived', async () => {
    const ctx = await setup()
    const [child] = await derive(ctx, 'root')
    await ctx.runner.startTask('root', { workspace_key: ctx.ws })
    const parent = await ctx.store.readTaskState('root', ctx.ws)
    await ctx.service.wait('root', ctx.ws)
    await ctx.store.updateTaskState(child, ctx.ws, current => ({
      ...current,
      status: 'AWAITING_ACCEPTANCE',
      active_run: null,
      delivery: {
        version: 'unversioned',
        artifacts: 'file',
        verification: 'ok',
        open_issues: '',
        submitted_at: new Date().toISOString(),
        submitted_by: 'claude'
      }
    }))
    await ctx.service.notifyParent(child, ctx.ws, 'already delivered', false)
    await (ctx.runner as unknown as {
      completeActor: (...args: unknown[]) => Promise<void>
    }).completeActor('root', ctx.ws, 'claude', parent.active_run!.run_id, '{"type":"chat","content":"waiting"}', [], 1, 0)
    const after = await ctx.store.readTaskState('root', ctx.ws)
    expect(after.status).not.toBe('WAITING_CHILDREN')
    expect(after.status).toBe('READY')
    expect(after.derivation_wake_pending ?? null).toBeNull()
  })

  it('does not start a child created after its parent was cancelled', async () => {
    const ctx = await setup()
    await ctx.service.propose('root', ctx.ws, 'claude', [spec()])
    await ctx.service.decide('root', ctx.ws, 'claude', 'agree', 'yes')
    await ctx.service.decide('root', ctx.ws, 'codex', 'agree', 'yes')
    const original = ctx.store.createTask.bind(ctx.store)
    let arrived!: () => void
    const blocked = new Promise<void>(resolve => { arrived = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    ctx.store.createTask = async input => {
      if (input.parent_task_id) {
        arrived()
        await gate
      }
      return original(input)
    }
    const creation = ctx.service.create('root', ctx.ws)
    await blocked
    await ctx.runner.cancelTask('root', ctx.ws)
    release()
    await expect(creation).rejects.toThrow(/已取消/)
    const root = await ctx.store.readTaskState('root', ctx.ws)
    expect(root.status).toBe('CANCELLED')
    const raced = (await ctx.store.getTasks()).find(task => task.parent_task_id === 'root')
    expect(raced).toBeTruthy()
    expect((await ctx.store.readTaskState(raced!.task_id, ctx.ws)).status).toBe('CANCELLED')

    await ctx.store.createTask({
      task_id: 'late-child',
      repo_root: root.repo_root,
      workspace_key: ctx.ws,
      parent_task_id: 'root',
      root_task_id: 'root'
    })
    await ctx.store.updateTaskState('late-child', ctx.ws, current => ({
      ...current,
      status: 'RUNNING_CLAUDE',
      active_run: { actor: 'claude', started_at: new Date().toISOString(), run_id: 'late' }
    }))
    await ctx.runner.cancelTask('root', ctx.ws)
    expect((await ctx.store.readTaskState('late-child', ctx.ws)).status).toBe('CANCELLED')
  })

  it('starts the waiting parents children before a later unrelated root', async () => {
    const ctx = await setup()
    const started: string[] = []
    const root = await ctx.store.readTaskState('root', ctx.ws)
    await ctx.store.updateTaskState('root', ctx.ws, current => ({
      ...current,
      execution_mode: 'queued',
      status: 'WAITING_CHILDREN',
      queue: { state: 'active', enqueued_at: '2026-01-01T00:00:00Z' }
    }))
    await ctx.store.createTask({
      task_id: 'unrelated',
      repo_root: root.repo_root,
      workspace_key: ctx.ws,
      execution_mode: 'queued'
    })
    await ctx.store.updateTaskState('unrelated', ctx.ws, current => ({
      ...current,
      queue: { state: 'waiting', enqueued_at: '2026-01-02T00:00:00Z' }
    }))
    const ids = await derive(ctx, 'root', [spec('a'), spec('b')])
    const coordinator = new QueueCoordinator({
      store: ctx.store,
      runner: {
        startTask: async (id: string) => {
          started.push(id)
          await ctx.store.updateTaskState(id, ctx.ws, current => ({ ...current, status: 'RUNNING_CLAUDE' }))
          return { run_id: id }
        }
      } as unknown as BuddyRunner
    })
    await coordinator.reconcile(ctx.ws)
    expect(started).toEqual([ids[0]])
    expect(started).not.toContain('unrelated')
  })

  it('rejects a new agreed goal that reuses an existing key', async () => {
    const ctx = await setup()
    const [id] = await derive(ctx, 'root', [spec('a')])
    const old = await ctx.store.getTaskDetail(id, ctx.ws)
    await expect(derive(ctx, 'root', [spec('a', 'a completely different revised goal')])).rejects.toThrow(/不能沿用/)
    const current = await ctx.store.getTaskDetail(id, ctx.ws)
    expect(current.task_text).toBe(old.task_text)
    expect(current.task_text).not.toContain('completely different')

    const again = await derive(ctx, 'root', [spec('a')])
    expect(again).toEqual([id])
    expect((await ctx.store.getTaskDetail(id, ctx.ws)).task_text).toBe(old.task_text)
  })

  it('wakes a waiting parent when one child is cancelled, and does not restart a parent cancelled with the tree', async () => {
    const alone = await setup()
    const [child] = await derive(alone, 'root')
    await alone.store.updateTaskState('root', alone.ws, current => ({
      ...current,
      status: 'WAITING_CHILDREN',
      active_run: null
    }))
    await alone.runner.cancelTask(child, alone.ws)
    const woken = await alone.store.readTaskState('root', alone.ws)
    expect(woken.status === 'READY' || woken.status.startsWith('RUNNING')).toBe(true)
    expect((await alone.store.readTaskState(child, alone.ws)).status).toBe('CANCELLED')

    const cascade = await setup()
    const [nested] = await derive(cascade, 'root')
    await cascade.store.updateTaskState('root', cascade.ws, current => ({
      ...current,
      status: 'WAITING_CHILDREN',
      active_run: null
    }))
    await cascade.runner.cancelTask('root', cascade.ws)
    await new Promise(resolve => setTimeout(resolve, 80))
    const root = await cascade.store.readTaskState('root', cascade.ws)
    expect(root.status).toBe('CANCELLED')
    expect(root.active_run ?? null).toBeNull()
    expect((await cascade.store.readTaskState(nested, cascade.ws)).status).toBe('CANCELLED')
  })

  it('keeps sidebar children inside their own project', () => {
    const children = taskChildren([
      { task_id: 'a', parent_task_id: 'same-root', workspace_key: 'project-a' },
      { task_id: 'b', parent_task_id: 'same-root', workspace_key: 'project-b' }
    ] as Task[], 'same-root', 'project-a')
    expect(children.map(item => item.workspace_key)).toEqual(['project-a'])
  })
})
