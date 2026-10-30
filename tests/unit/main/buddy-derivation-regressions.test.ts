import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
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
  workspace_mode: 'isolated',
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

async function gitRepo(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'buddy-derive-repo-'))
  await git(path, ['init'])
  await git(path, ['config', 'user.name', 'Review'])
  await git(path, ['config', 'user.email', 'review@example.invalid'])
  await writeFile(join(path, 'base.txt'), 'old')
  await git(path, ['add', '.'])
  await git(path, ['commit', '-m', 'base'])
  return path
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
    expect(await readFile(join(dest, 'block.txt'), 'utf8')).toBe('occupied')
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

  it('does not start a child when the parent is paused during creation', async () => {
    const ctx = await setup()
    await ctx.runner.startTask('root', { workspace_key: ctx.ws })
    await ctx.service.propose('root', ctx.ws, 'claude', [spec()])
    await ctx.service.decide('root', ctx.ws, 'claude', 'agree', 'yes')
    await ctx.service.decide('root', ctx.ws, 'codex', 'agree', 'yes')
    const original = ctx.store.createTask.bind(ctx.store)
    let arrived!: () => void
    const blocked = new Promise<void>(resolve => { arrived = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    ctx.store.createTask = async input => {
      if (input.parent_task_id === 'root') {
        arrived()
        await gate
      }
      return original(input)
    }
    const creation = ctx.service.create('root', ctx.ws)
    await blocked
    await ctx.runner.interrupt('root', ctx.ws)
    release()
    await expect(creation).rejects.toThrow(/暂停/)
    expect((await ctx.store.readTaskState('root', ctx.ws)).status).toBe('PAUSED')
    const child = (await ctx.store.getTasks()).find(task => task.parent_task_id === 'root')
    expect(child).toBeTruthy()
    expect((await ctx.store.readTaskState(child!.task_id, ctx.ws)).status).toBe('CANCELLED')
  })

  it('keeps an in-flight create valid after the nested switch is turned off', async () => {
    const ctx = await setup()
    const [child] = await derive(ctx, 'root')
    await ctx.service.propose(child, ctx.ws, 'claude', [spec('grand')])
    await ctx.service.decide(child, ctx.ws, 'claude', 'agree', 'yes')
    await ctx.service.decide(child, ctx.ws, 'codex', 'agree', 'yes')
    const original = ctx.store.createTask.bind(ctx.store)
    let arrived!: () => void
    const blocked = new Promise<void>(resolve => { arrived = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    ctx.store.createTask = async input => {
      if (input.parent_task_id === child) {
        arrived()
        await gate
      }
      return original(input)
    }
    const creation = ctx.service.create(child, ctx.ws)
    await blocked
    await ctx.store.updateGlobalSettings({ ...(await ctx.store.readGlobalSettings()), allow_nested_derivation: false })
    release()
    const result = await creation
    const grand = await ctx.store.readTaskState(result.task_ids[0], ctx.ws)
    expect(grand.derivation_depth).toBe(2)
    expect(grand.status.startsWith('RUNNING')).toBe(true)
  })

  it('does not reject a child that is still running', async () => {
    const ctx = await setup()
    const [child] = await derive(ctx, 'root')
    const before = await ctx.store.readTaskState(child, ctx.ws)
    const controller = new AbortController()
    ;(ctx.runner as unknown as { runControllers: Map<string, { runId: string; controller: AbortController }> })
      .runControllers.set(`${ctx.ws}::${child}`, { runId: before.active_run!.run_id!, controller })
    await expect(ctx.service.review('root', ctx.ws, 'codex', child, 'reject', 'change the approach')).rejects.toThrow(/内部确认|仍在运行/)
    const after = await ctx.store.readTaskState(child, ctx.ws)
    expect(after.active_run?.run_id).toBe(before.active_run?.run_id)
    expect(after.status.startsWith('RUNNING')).toBe(true)
    expect(controller.signal.aborted).toBe(false)

    await markAwaiting(ctx.store, child, ctx.ws)
    await ctx.service.review('root', ctx.ws, 'codex', child, 'reject', 'change the approach')
    await vi.waitFor(async () => {
      const restarted = await ctx.store.readTaskState(child, ctx.ws)
      expect(restarted.status.startsWith('RUNNING')).toBe(true)
      expect(restarted.active_run?.run_id).not.toBe(before.active_run?.run_id)
    })
  })

  it('lets a parent wait while a running child has only submitted a delivery', async () => {
    const ctx = await setup()
    const [child] = await derive(ctx, 'root')
    await ctx.runner.startTask('root', { workspace_key: ctx.ws })
    await ctx.service.submit(child, ctx.ws, 'claude', { version: 'unversioned', artifacts: 'file', verification: 'ok' })
    const statuses: string[] = []
    for (let i = 0; i < 3; i += 1) {
      if (i > 0) await ctx.runner.startTask('root', { workspace_key: ctx.ws })
      const current = await ctx.store.readTaskState('root', ctx.ws)
      await ctx.service.wait('root', ctx.ws)
      await (ctx.runner as unknown as { completeActor: (...args: unknown[]) => Promise<void> }).completeActor(
        'root',
        ctx.ws,
        current.active_run!.actor,
        current.active_run!.run_id,
        '{"type":"chat","content":"wait for child internal review"}',
        [],
        1,
        0
      )
      statuses.push((await ctx.store.readTaskState('root', ctx.ws)).status)
    }
    expect(statuses).toEqual(['WAITING_CHILDREN', 'WAITING_CHILDREN', 'WAITING_CHILDREN'])
    expect((await ctx.store.readTaskState(child, ctx.ws)).status.startsWith('RUNNING')).toBe(true)
  })

  it('refuses to derive from a dirty parent worktree', async () => {
    const path = await gitRepo()
    await writeFile(join(path, 'base.txt'), 'needed working change')
    await writeFile(join(path, 'new-file.txt'), 'uncommitted input')
    const ctx = await setup(path)
    await expect(derive(ctx, 'root')).rejects.toThrow(/未提交/)
    expect((await ctx.store.getTasks()).some(task => task.parent_task_id === 'root')).toBe(false)
    expect(await readFile(join(path, 'base.txt'), 'utf8')).toBe('needed working change')
  })

  it('retries creation after a worktree was left behind by a failed persist', async () => {
    const ctx = await setup(await gitRepo())
    await ctx.service.propose('root', ctx.ws, 'claude', [spec()])
    await ctx.service.decide('root', ctx.ws, 'claude', 'agree', 'yes')
    await ctx.service.decide('root', ctx.ws, 'codex', 'agree', 'yes')
    const original = ctx.store.createTask.bind(ctx.store)
    let fail = true
    ctx.store.createTask = async input => {
      if (input.parent_task_id && fail) {
        fail = false
        throw new Error('simulated interrupted task persistence')
      }
      return original(input)
    }
    await expect(ctx.service.create('root', ctx.ws)).rejects.toThrow(/interrupted/)
    const created = await ctx.service.create('root', ctx.ws)
    expect(created.task_ids).toHaveLength(1)
    const child = await ctx.store.readTaskState(created.task_ids[0], ctx.ws)
    expect(await readFile(join(child.work_dir!, 'base.txt'), 'utf8')).toBe('old')
    expect((await ctx.store.getTasks()).filter(task => task.parent_task_id === 'root')).toHaveLength(1)
  })

  it('keeps an unrecorded worktree that still has uncommitted files', async () => {
    const repo = await gitRepo()
    const ctx = await setup(repo)
    const childId = derivedTaskId('root', 'child')
    const dest = join(ctx.store.dataRoot, 'runtime', 'worktrees', ctx.ws, childId)
    await mkdir(join(ctx.store.dataRoot, 'runtime', 'worktrees', ctx.ws), { recursive: true })
    await git(repo, ['worktree', 'add', '--detach', dest, 'HEAD'])
    await writeFile(join(dest, 'recovery.txt'), 'only copy')
    await expect(derive(ctx, 'root')).rejects.toThrow(/不能删除/)
    expect(await readFile(join(dest, 'recovery.txt'), 'utf8')).toBe('only copy')
    expect((await ctx.store.getTasks()).some(task => task.task_id === childId)).toBe(false)
  })

  it('keeps an unrecorded worktree whose commit is not the parent HEAD', async () => {
    const repo = await gitRepo()
    const ctx = await setup(repo)
    const childId = derivedTaskId('root', 'child')
    const dest = join(ctx.store.dataRoot, 'runtime', 'worktrees', ctx.ws, childId)
    await mkdir(join(ctx.store.dataRoot, 'runtime', 'worktrees', ctx.ws), { recursive: true })
    await git(repo, ['worktree', 'add', '--detach', dest, 'HEAD'])
    await writeFile(join(dest, 'extra.txt'), 'committed only here')
    await git(dest, ['add', 'extra.txt'])
    await git(dest, ['commit', '-m', 'extra'])
    const head = await git(dest, ['rev-parse', 'HEAD'])
    await expect(derive(ctx, 'root')).rejects.toThrow(/不一致/)
    expect(await git(dest, ['rev-parse', 'HEAD'])).toBe(head)
    expect(await readFile(join(dest, 'extra.txt'), 'utf8')).toBe('committed only here')
  })

  it('does not delete child work when the task state cannot be read', async () => {
    const ctx = await setup(await gitRepo())
    const [child] = await derive(ctx, 'root')
    const state = await ctx.store.readTaskState(child, ctx.ws)
    await writeFile(join(state.work_dir!, 'unfinished.txt'), 'keep me')
    await writeFile(join(ctx.store.taskDirectory(child, ctx.ws), 'state.json'), '{broken')
    await ctx.service.propose('root', ctx.ws, 'claude', [spec()])
    await ctx.service.decide('root', ctx.ws, 'claude', 'agree', 'yes')
    await ctx.service.decide('root', ctx.ws, 'codex', 'agree', 'yes')
    await expect(ctx.service.create('root', ctx.ws)).rejects.toThrow(/无法读取/)
    expect(await readFile(join(state.work_dir!, 'unfinished.txt'), 'utf8')).toBe('keep me')
    expect(await readFile(join(ctx.store.taskDirectory(child, ctx.ws), 'state.json'), 'utf8')).toBe('{broken')
  })

  it('creates a child when the proposal file is written where the prompt says', async () => {
    const repo = await gitRepo()
    const ctx = await setup(repo)
    const section = await ctx.service.promptSection('root', ctx.ws)
    const match = section.match(/propose '([^']+)'/)
    expect(match?.[1]).toBe(join(ctx.store.taskDirectory('root', ctx.ws), 'artifacts', 'derivation-spec.json'))
    expect(section).not.toContain('propose spec.json')
    expect(section).toContain('不要把方案文件写进当前工作目录')
    const specPath = match![1]
    await writeFile(specPath, JSON.stringify({ specs: [spec()] }))
    const parsed = JSON.parse(await readFile(specPath, 'utf8')) as { specs: DerivationSpec[] }
    await ctx.service.propose('root', ctx.ws, 'claude', parsed.specs)
    await ctx.service.decide('root', ctx.ws, 'claude', 'agree', 'yes')
    await ctx.service.decide('root', ctx.ws, 'codex', 'agree', 'yes')
    const created = await ctx.service.create('root', ctx.ws)
    expect(created.task_ids).toHaveLength(1)
    expect(await access(join(repo, 'spec.json')).then(() => true, () => false)).toBe(false)
    expect(await git(repo, ['status', '--porcelain'])).toBe('')
  })

  it('keeps sidebar children inside their own project', () => {
    const children = taskChildren([
      { task_id: 'a', parent_task_id: 'same-root', workspace_key: 'project-a' },
      { task_id: 'b', parent_task_id: 'same-root', workspace_key: 'project-b' }
    ] as Task[], 'same-root', 'project-a')
    expect(children.map(item => item.workspace_key)).toEqual(['project-a'])
  })

  it('revives a child cancelled by a mid-creation pause when create is retried, and starts it', async () => {
    const ctx = await setup()
    await ctx.runner.startTask('root', { workspace_key: ctx.ws })
    await ctx.service.propose('root', ctx.ws, 'claude', [spec()])
    await ctx.service.decide('root', ctx.ws, 'claude', 'agree', 'yes')
    await ctx.service.decide('root', ctx.ws, 'codex', 'agree', 'yes')
    const original = ctx.store.createTask.bind(ctx.store)
    let arrived!: () => void
    const blocked = new Promise<void>(resolve => { arrived = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    ctx.store.createTask = async input => {
      if (input.parent_task_id === 'root') {
        arrived()
        await gate
      }
      return original(input)
    }
    const creation = ctx.service.create('root', ctx.ws)
    await blocked
    await ctx.runner.interrupt('root', ctx.ws)
    release()
    await expect(creation).rejects.toThrow(/暂停/)
    const childId = derivedTaskId('root', 'child')
    expect((await ctx.store.readTaskState(childId, ctx.ws)).status).toBe('CANCELLED')

    // 父任务恢复后重试 create：回滚取消的子任务必须复活并被启动，不能停在 CANCELLED。
    await ctx.store.updateTaskState('root', ctx.ws, current => ({
      ...current, status: 'READY', active_run: null, pause_cause: null, pause_resume_status: undefined
    }))
    const started: string[] = []
    const startSpy = vi.spyOn(ctx.runner, 'startTask')
    startSpy.mockImplementation(async (taskId: string, input: { workspace_key: string }) => {
      started.push(taskId)
      await ctx.store.updateTaskState(taskId, input.workspace_key, current => ({ ...current, status: 'RUNNING_CLAUDE' }))
      return { run_id: `run-${taskId}` }
    })
    const retried = await ctx.service.create('root', ctx.ws)
    expect(retried.task_ids).toEqual([childId])
    const revived = await ctx.store.readTaskState(childId, ctx.ws)
    expect(revived.status.startsWith('RUNNING')).toBe(true)
    expect(revived.cancel_cause ?? null).toBeNull()
    expect(started).toContain(childId)
    // 方案落成 created，父任务的 child_task_ids 也已登记。
    const parent = await ctx.store.readTaskState('root', ctx.ws)
    expect(parent.derivation_proposal?.status).toBe('created')
    expect(parent.child_task_ids).toContain(childId)
    startSpy.mockRestore()
  })

  it('does not revive a child the user cancelled themselves', async () => {
    const ctx = await setup()
    const [child] = await derive(ctx, 'root')
    // 用户主动取消：cancelTask 是 runner 的路径，这里直接构造用户取消后的状态。
    await ctx.store.updateTaskState(child, ctx.ws, current => ({
      ...current, status: 'CANCELLED', cancel_cause: 'user', active_run: null
    }))
    // 同一方案再次 create（提案已是 created，走 reused 分支）不能把用户取消的子任务拉起来。
    const result = await ctx.service.create('root', ctx.ws)
    expect(result.task_ids).toEqual([child])
    expect((await ctx.store.readTaskState(child, ctx.ws)).status).toBe('CANCELLED')
    // 用户取消的子任务挡住父任务结束，只能 waive，这与提示语义一致。
    const parent = await ctx.store.readTaskState('root', ctx.ws)
    const snapshots = await (ctx.runner as unknown as { childSnapshots: (state: typeof parent, ws: string) => Promise<{ status: string; waived?: boolean }[]> }).childSnapshots(parent, ctx.ws)
    expect(snapshots[0].status).toBe('CANCELLED')
  })

  it('revives and starts children rolled back after the proposal was already saved as created', async () => {
    const ctx = await setup()
    await ctx.service.propose('root', ctx.ws, 'claude', [spec()])
    await ctx.service.decide('root', ctx.ws, 'claude', 'agree', 'yes')
    await ctx.service.decide('root', ctx.ws, 'codex', 'agree', 'yes')
    const childId = derivedTaskId('root', 'child')

    // 注入点：note(derivation.created) 发生在「方案写成 created」之后、kickAll 之前。
    // 拦截 appendTaskEvent，遇到 derivation.created 时把父任务置 PAUSED，模拟用户暂停赢了。
    // 这样第一次 create 在 kickAll 前被 stopIfParentClosed 打断，回滚取消新子任务，
    // 而方案已经落成 created——正是审查指出的 reused 早退场景。
    const originalAppend = ctx.store.appendTaskEvent.bind(ctx.store)
    const appendSpy = vi.spyOn(ctx.store, 'appendTaskEvent').mockImplementation(async (id: string, key: string, event: { type: string }) => {
      if (id === 'root' && event.type === 'derivation.created') {
        appendSpy.mockRestore()
        await ctx.store.updateTaskState('root', key, s => ({ ...s, status: 'PAUSED', active_run: null }))
      }
      return originalAppend(id, key, event)
    })
    await expect(ctx.service.create('root', ctx.ws)).rejects.toThrow(/暂停/)
    appendSpy.mockRestore()

    const mid = await ctx.store.readTaskState(childId, ctx.ws)
    expect(mid.status).toBe('CANCELLED')
    expect(mid.cancel_cause).toBe('creation_rollback')
    expect((await ctx.store.readTaskState('root', ctx.ws)).derivation_proposal?.status).toBe('created')

    // 父任务恢复后再次 create：走 reused 早退，早退前必须复活并启动子任务。
    await ctx.store.updateTaskState('root', ctx.ws, s => ({ ...s, status: 'READY', pause_cause: null }))
    const started: string[] = []
    const startSpy = vi.spyOn(ctx.runner, 'startTask')
    startSpy.mockImplementation(async (taskId: string, input: { workspace_key: string }) => {
      started.push(taskId)
      await ctx.store.updateTaskState(taskId, input.workspace_key, current => ({ ...current, status: 'RUNNING_CLAUDE' }))
      return { run_id: `run-${taskId}` }
    })
    const result = await ctx.service.create('root', ctx.ws)
    expect(result.reused).toBe(true)
    expect(result.task_ids).toEqual([childId])
    const child = await ctx.store.readTaskState(childId, ctx.ws)
    expect(child.status.startsWith('RUNNING')).toBe(true)
    expect(child.cancel_cause ?? null).toBeNull()
    expect(started).toContain(childId)
    startSpy.mockRestore()
  })

  it('reused create leaves a user-cancelled child alone even after a rollback cancel elsewhere', async () => {
    const ctx = await setup()
    const [child] = await derive(ctx, 'root')
    // 提案已是 created（derive 完成）。用户取消其中一个子任务后再次 create：
    // 早退分支不能把它复活。
    await ctx.store.updateTaskState(child, ctx.ws, current => ({
      ...current, status: 'CANCELLED', cancel_cause: 'user', active_run: null
    }))
    const startSpy = vi.spyOn(ctx.runner, 'startTask')
    startSpy.mockImplementation(async () => ({ run_id: 'should-not-run' }))
    const result = await ctx.service.create('root', ctx.ws)
    expect(result.reused).toBe(true)
    expect((await ctx.store.readTaskState(child, ctx.ws)).status).toBe('CANCELLED')
    expect(startSpy.mock.calls.map(call => String(call[0]))).toEqual([])
    startSpy.mockRestore()
  })

  it('revives a queued child back into the waiting queue so the coordinator can pick it up', async () => {
    const ctx = await setup()
    // 排队执行的父任务：createTask 时 execution_mode=queued，子任务也是 queued。
    await ctx.store.updateTaskState('root', ctx.ws, current => ({ ...current, execution_mode: 'queued' }))
    await ctx.service.propose('root', ctx.ws, 'claude', [spec()])
    await ctx.service.decide('root', ctx.ws, 'claude', 'agree', 'yes')
    await ctx.service.decide('root', ctx.ws, 'codex', 'agree', 'yes')
    const childId = derivedTaskId('root', 'child')

    // 与立即模式用例同一个注入点：方案写成 created 之后、kickAll/terminal 之前，
    // 把父任务置 PAUSED，触发 stopIfParentClosed 回滚取消新建的排队子任务。
    const originalAppend = ctx.store.appendTaskEvent.bind(ctx.store)
    const appendSpy = vi.spyOn(ctx.store, 'appendTaskEvent').mockImplementation(async (id: string, key: string, event: { type: string }) => {
      if (id === 'root' && event.type === 'derivation.created') {
        appendSpy.mockRestore()
        await ctx.store.updateTaskState('root', key, s => ({ ...s, status: 'PAUSED', active_run: null }))
      }
      return originalAppend(id, key, event)
    })
    await expect(ctx.service.create('root', ctx.ws)).rejects.toThrow(/暂停/)
    appendSpy.mockRestore()

    const mid = await ctx.store.readTaskState(childId, ctx.ws)
    expect(mid.status).toBe('CANCELLED')
    expect(mid.cancel_cause).toBe('creation_rollback')
    expect(mid.execution_mode).toBe('queued')

    // 父任务恢复后再次 create：排队子任务必须回到 QUEUED + queue.state=waiting，
    // 不能停在 READY 堵死队列。协调器由此可以选中它。
    // 排队任务的恢复目标是 QUEUED（resume 语义如此），不用 READY。
    await ctx.store.updateTaskState('root', ctx.ws, s => ({ ...s, status: 'QUEUED', pause_cause: null }))
    const startSpy = vi.spyOn(ctx.runner, 'startTask')
    startSpy.mockImplementation(async (taskId: string, input: { workspace_key: string }) => {
      await ctx.store.updateTaskState(taskId, input.workspace_key, s => ({ ...s, status: 'RUNNING_CLAUDE' }))
      return { run_id: `run-${taskId}` }
    })
    let terminalCalls = 0
    const terminalSpy = vi.fn(() => { terminalCalls += 1 })
    ;(ctx.service as unknown as { hooks: { terminal: () => void } }).hooks.terminal = terminalSpy
    const result = await ctx.service.create('root', ctx.ws)
    expect(result.reused).toBe(true)
    const child = await ctx.store.readTaskState(childId, ctx.ws)
    expect(child.status).toBe('QUEUED')
    expect(child.queue?.state).toBe('waiting')
    expect(child.cancel_cause ?? null).toBeNull()
    // 排队复活不直接 kickAll，交给协调器；但必须触发对账让协调器看到它。
    expect(startSpy.mock.calls.map(call => String(call[0]))).toEqual([])
    expect(terminalCalls).toBeGreaterThan(0)
    // 协调器对账后真的选中并启动这个复活的排队子任务。
    const coordinator = new QueueCoordinator({ store: ctx.store, runner: ctx.runner })
    await coordinator.reconcile(ctx.ws)
    expect(startSpy.mock.calls.map(call => String(call[0]))).toContain(childId)
    expect((await ctx.store.readTaskState(childId, ctx.ws)).status.startsWith('RUNNING')).toBe(true)
    startSpy.mockRestore()
  })
})
