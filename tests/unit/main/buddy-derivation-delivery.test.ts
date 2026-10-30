import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BuddyRunner } from '../../../src/main/buddy/runner'
import { BuddyStore } from '../../../src/main/buddy/store'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
  })
}

async function setup(initialCommit = true) {
  const root = await mkdtemp(join(tmpdir(), 'buddy-delivery-')); roots.push(root)
  const repo = join(root, 'repo')
  await mkdir(repo)
  await git(repo, ['init'])
  await git(repo, ['config', 'user.name', 'Buddy Test'])
  await git(repo, ['config', 'user.email', 'buddy@example.invalid'])
  await writeFile(join(repo, 'base.txt'), 'base\n')
  if (initialCommit) {
    await git(repo, ['add', 'base.txt'])
    await git(repo, ['commit', '-m', 'base'])
  }
  const store = new BuddyStore(join(root, 'data'))
  const parent = await store.createTask({ task_id: 'parent', repo_root: repo })
  const ws = parent.workspace_key
  await store.createTask({ task_id: 'child', workspace_key: ws, repo_root: repo, parent_task_id: 'parent' })
  await store.updateTaskState('parent', ws, s => ({ ...s, child_task_ids: ['child'] }))
  await store.updateTaskState('child', ws, s => ({ ...s, work_dir: repo }))
  const runner = new BuddyRunner(store, { executeLaunchers: false })
  return { root, repo, store, ws, runner, service: runner.derivation }
}

async function finishTurn(c: Awaited<ReturnType<typeof setup>>, actor: 'claude' | 'codex') {
  await c.runner.startTask('child', { workspace_key: c.ws, actor })
  const child = await c.store.readTaskState('child', c.ws)
  await (c.runner as any).completeActor('child', c.ws, actor, child.active_run!.run_id,
    '{"type":"break","content":"确认完成。"}', [], 1, 0)
}

describe('Git-backed delivery validation', () => {
  it('counts resubmissions separately even when the Git version is unchanged', async () => {
    const c = await setup()
    const first = await c.service.submit('child', c.ws, 'claude', { artifacts: 'base.txt' })
    const second = await c.service.submit('child', c.ws, 'claude', { artifacts: 'base.txt', verification: 'updated verification' })
    expect(first.revision).toBe(1)
    expect(second.revision).toBe(2)
    expect(second.version).toBe(first.version)
    expect((await c.store.readTaskState('child', c.ws)).delivery?.revision).toBe(2)
    const parent = await c.store.getTaskDetail('parent', c.ws)
    const submitted = parent.events.filter(e => e.type === 'derivation.child_submitted')
    expect(submitted.map(e => e.payload.delivery_revision)).toEqual([1, 2])
    expect(submitted[1].payload.version).toBe(second.version)
    expect(submitted[1].payload.message).toContain('已重新提交交付')
    await finishTurn(c, 'claude')
    await finishTurn(c, 'codex')
    const ready = (await c.store.getTaskDetail('parent', c.ws)).events.find(e => e.type === 'derivation.child_delivered')!
    expect(ready.payload).toMatchObject({ version: second.version, delivery_revision: 2 })
  })

  it('automatically records the full HEAD through the real CLI without a version flag', async () => {
    const c = await setup()
    await c.runner.startTask('child', { workspace_key: c.ws, actor: 'claude' })
    const child = await c.store.readTaskState('child', c.ws)
    const session = await c.service.openRun('child', c.ws, 'claude', child.active_run!.run_id)
    try {
      const result = await new Promise<{ version: string }>((resolve, reject) => {
        execFile(process.execPath, [session.env.BUDDY_DERIVATION_CLI, 'submit', '--artifacts', 'base.txt', '--verification', 'checked'], {
          env: { ...process.env, ...session.env }
        }, (error, stdout) => {
          if (error) reject(error)
          else { try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) } }
        })
      })
      expect(result.version).toBe(await git(c.repo, ['rev-parse', 'HEAD']))
      expect((await c.store.readTaskState('child', c.ws)).delivery?.version).toBe(result.version)
    } finally { session.close() }
    const prompt = await c.service.promptSection('child', c.ws)
    expect(prompt).not.toContain('submit --version VERSION')
    expect(prompt).toContain('自动读取')
    expect(prompt).toContain('提交编号')
  })

  it('rejects version=1 at submission without overwriting a previous delivery or acceptance', async () => {
    const c = await setup()
    const delivery = await c.service.submit('child', c.ws, 'claude', { verification: 'checked' })
    await c.store.updateTaskState('child', c.ws, s => ({
      ...s,
      acceptance: { actor: 'codex', at: new Date().toISOString(), decision: 'reject', comment: '补充验证', version: delivery.version },
      pending_break: { actor: 'claude', round: 1 }
    }))
    const before = await c.store.getTaskDetail('child', c.ws)
    const parentBefore = await c.store.getTaskDetail('parent', c.ws)
    await expect(c.service.submit('child', c.ws, 'claude', { version: '1' })).rejects.toThrow(/版本.*不一致/)
    expect(await c.store.getTaskDetail('child', c.ws)).toEqual(before)
    expect(await c.store.getTaskDetail('parent', c.ws)).toEqual(parentBefore)
  })

  it.each(['unstaged', 'staged', 'untracked'])('rejects %s changes without committing them', async kind => {
    const c = await setup()
    const head = await git(c.repo, ['rev-parse', 'HEAD'])
    await writeFile(join(c.repo, kind === 'untracked' ? 'new.txt' : 'base.txt'), 'changed\n')
    if (kind === 'staged') await git(c.repo, ['add', 'base.txt'])
    const before = await c.store.getTaskDetail('child', c.ws)
    await expect(c.service.submit('child', c.ws, 'claude', {})).rejects.toThrow(/未提交/)
    expect(await c.store.getTaskDetail('child', c.ws)).toEqual(before)
    expect(await git(c.repo, ['rev-parse', 'HEAD'])).toBe(head)
    expect(await git(c.repo, ['status', '--porcelain'])).not.toBe('')
  })

  it('refuses a Git repository with no commit instead of falling back to unversioned', async () => {
    const c = await setup(false)
    await expect(c.service.submit('child', c.ws, 'claude', {})).rejects.toThrow(/HEAD|提交编号/)
    expect((await c.store.readTaskState('child', c.ws)).delivery ?? null).toBeNull()
  })

  it.each(['new commit', 'dirty files', 'legacy version'])('blocks stale %s before notifying the parent to accept', async change => {
    const c = await setup()
    await c.service.submit('child', c.ws, 'claude', { artifacts: 'base.txt', verification: 'checked' })
    await finishTurn(c, 'claude')
    if (change === 'legacy version') {
      await c.store.updateTaskState('child', c.ws, s => ({ ...s, delivery: { ...s.delivery!, version: '1' } }))
    } else {
      await writeFile(join(c.repo, 'base.txt'), 'changed\n')
      if (change === 'new commit') {
        await git(c.repo, ['add', 'base.txt'])
        await git(c.repo, ['commit', '-m', 'changed after submission'])
      }
    }
    await finishTurn(c, 'codex')
    const child = await c.store.getTaskDetail('child', c.ws)
    expect(child.state.status).toBe('READY')
    expect(child.state.pending_break).toBeNull()
    expect(child.events.some(e => e.type === 'task.awaiting_acceptance')).toBe(false)
    expect(child.events.find(e => e.type === 'task.delivery_required')?.payload.reason).toMatch(/不一致|未提交/)
    const parent = await c.store.getTaskDetail('parent', c.ws)
    expect(parent.events.some(e => e.type === 'derivation.child_delivered')).toBe(false)
    if (change === 'new commit') {
      await c.service.submit('child', c.ws, 'claude', { artifacts: 'base.txt', verification: 'rechecked' })
      await finishTurn(c, 'claude')
      await finishTurn(c, 'codex')
      expect((await c.store.readTaskState('child', c.ws)).status).toBe('AWAITING_ACCEPTANCE')
      await c.service.review('parent', c.ws, 'claude', 'child', 'accept', 'rechecked')
      expect((await c.store.readTaskState('child', c.ws)).status).toBe('DONE')
    }
  })

  it('requires both actors to confirm again after a new submission', async () => {
    const c = await setup()
    await c.service.submit('child', c.ws, 'claude', {})
    await finishTurn(c, 'claude')
    await c.service.submit('child', c.ws, 'claude', {})
    expect((await c.store.readTaskState('child', c.ws)).pending_break).toBeNull()
    await finishTurn(c, 'codex')
    expect((await c.store.readTaskState('child', c.ws)).status).toBe('READY')
    await finishTurn(c, 'claude')
    expect((await c.store.readTaskState('child', c.ws)).status).toBe('AWAITING_ACCEPTANCE')
  })
})
