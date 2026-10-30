import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BuddyRunner } from '../../../src/main/buddy/runner'
import { BuddyStore } from '../../../src/main/buddy/store'
import { proposalHash, validateSpecs } from '../../../src/main/buddy/derivation'
import type { DerivationSpec } from '../../../src/shared/types'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const exec = (command: string, args: string[], cwd: string): Promise<string> => new Promise((resolve, reject) => {
  execFile(command, args, { cwd }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout.trim()))
})
const spec = (key: string): DerivationSpec => ({ key, title: key, goal: `实现 ${key}`, scope: `只修改 ${key}.mjs，父任务和兄弟任务不修改此文件`, context: '父任务的一部分，使用共享工作区', dependencies: [], deliverables: `${key}.mjs`, acceptance: '实际验证后验收' })

async function setup(git = true, subdirectory = false) {
  const root = await mkdtemp(join(tmpdir(), 'buddy-shared-')); roots.push(root)
  const repo = join(root, 'repo'); await mkdir(repo)
  if (git) {
    await exec('git', ['init'], repo)
    await exec('git', ['config', 'user.name', 'Buddy Test'], repo)
    await exec('git', ['config', 'user.email', 'buddy@example.invalid'], repo)
    await writeFile(join(repo, 'existing.txt'), 'base\n')
    await exec('git', ['add', 'existing.txt'], repo)
    await exec('git', ['commit', '-m', 'fixture baseline'], repo)
  }
  const workPath = subdirectory ? join(repo, 'feature') : repo
  await mkdir(workPath, { recursive: true })
  const work = await realpath(workPath)
  const store = new BuddyStore(join(root, 'data'))
  await store.updateGlobalSettings({ ...(await store.readGlobalSettings()), allow_nested_derivation: true })
  const parent = await store.createTask({ task_id: 'root', repo_root: repo })
  if (subdirectory) await store.updateTaskState('root', parent.workspace_key, s => ({ ...s, work_dir: work }))
  const runner = new BuddyRunner(store, { executeLaunchers: false })
  return { root, repo, work, store, runner, ws: parent.workspace_key, service: runner.derivation }
}

async function derive(c: Awaited<ReturnType<typeof setup>>, parent = 'root', specs = [spec('a'), spec('b')]) {
  await c.service.propose(parent, c.ws, 'claude', specs)
  await c.service.decide(parent, c.ws, 'claude', 'agree', '分工明确')
  await c.service.decide(parent, c.ws, 'codex', 'agree', '分工明确')
  return (await c.service.create(parent, c.ws)).task_ids
}

async function confirm(c: Awaited<ReturnType<typeof setup>>, taskId: string) {
  for (const actor of ['claude', 'codex']) {
    let state = await c.store.readTaskState(taskId, c.ws)
    if (!state.active_run) {
      await c.runner.startTask(taskId, { workspace_key: c.ws, actor })
      state = await c.store.readTaskState(taskId, c.ws)
    }
    await (c.runner as any).completeActor(taskId, c.ws, actor, state.active_run!.run_id,
      '{"type":"break","content":"代码与测试已复核。"}', [], 1, 0)
  }
}

describe('shared parent and child workspace', () => {
  it.each([false, true])('defaults to the same parent directory (Git=%s) and propagates live edits across three levels', async git => {
    const c = await setup(git)
    await writeFile(join(c.repo, 'existing.txt'), '父任务未提交的改动\n')
    await writeFile(join(c.repo, 'parent-only.txt'), '父任务新文件\n')
    const [a, b] = await derive(c)
    const [grand] = await derive(c, a, [spec('grand')])
    for (const id of [a, b, grand]) {
      const state = await c.store.readTaskState(id, c.ws)
      expect(state.work_dir).toBe(c.work)
      expect(state.workspace_mode).toBe('shared')
      expect(state.status.startsWith('RUNNING')).toBe(true)
      expect(await readFile(join(state.work_dir!, 'existing.txt'), 'utf8')).toContain('未提交')
    }
    await writeFile(join(c.work, 'grand.mjs'), 'export const value = 1\n')
    expect(await readFile(join((await c.store.readTaskState(a, c.ws)).work_dir!, 'grand.mjs'), 'utf8')).toContain('value = 1')
    await writeFile(join(c.work, 'parent-only.txt'), '父任务继续推进\n')
    expect(await readFile(join((await c.store.readTaskState(grand, c.ws)).work_dir!, 'parent-only.txt'), 'utf8')).toContain('继续推进')
    if (git) expect((await exec('git', ['worktree', 'list', '--porcelain'], c.repo)).match(/^worktree /gm)).toHaveLength(1)
  })

  it('uses the parent task subdirectory, without falling back to the repository root', async () => {
    const c = await setup(true, true)
    const [a] = await derive(c, 'root', [spec('a')])
    const [grand] = await derive(c, a, [spec('grand')])
    expect((await c.store.readTaskState(a, c.ws)).work_dir).toBe(c.work)
    expect((await c.store.readTaskState(grand, c.ws)).work_dir).toBe(c.work)
    const prompt = await c.service.promptSection(a, c.ws)
    expect(prompt).toContain('共享工作区')
    expect(prompt).toContain('父任务与兄弟任务不要同时修改已委派的范围')
    expect(prompt).toContain('不需要为了交付创建 commit')
    expect((await c.store.getTaskDetail(a, c.ws)).task_text).toContain('只修改 a.mjs')
  })

  it('accepts a shared delivery with staged, untracked and unrelated parent edits, without touching Git history or index', async () => {
    const c = await setup()
    await writeFile(join(c.repo, 'existing.txt'), 'staged parent work\n')
    await exec('git', ['add', 'existing.txt'], c.repo)
    const head = await exec('git', ['rev-parse', 'HEAD'], c.repo)
    const index = await readFile(join(c.repo, '.git/index'))
    const [a, b] = await derive(c)
    await writeFile(join(c.work, 'a.mjs'), 'export const a = 1\n')
    const first = await c.service.submit(a, c.ws, 'claude', { version: '1', artifacts: 'a.mjs', verification: '已验证当前代码' })
    expect(first.version).toBe('delivery-1')
    await confirm(c, a)
    await writeFile(join(c.work, 'b.mjs'), 'export const b = 2\n')
    await writeFile(join(c.work, 'parent.txt'), '父任务继续修改其他文件\n')
    await c.service.review('root', c.ws, 'codex', a, 'accept', '复核共享目录中的当前产物及测试，通过')
    expect((await c.store.readTaskState(a, c.ws)).status).toBe('DONE')
    expect((await c.store.readTaskState(b, c.ws)).status.startsWith('RUNNING')).toBe(true)
    expect(await exec('git', ['rev-parse', 'HEAD'], c.repo)).toBe(head)
    expect(await readFile(join(c.repo, '.git/index'))).toEqual(index)
  })

  it('preserves shared files and sibling execution on rejection, cancellation and task deletion', async () => {
    const c = await setup()
    const [a, b] = await derive(c)
    await writeFile(join(c.work, 'a.mjs'), 'first\n')
    await writeFile(join(c.work, 'b.mjs'), 'keep sibling\n')
    await c.service.submit(a, c.ws, 'claude', { artifacts: 'a.mjs' })
    await confirm(c, a)
    await c.service.review('root', c.ws, 'codex', a, 'reject', '请在当前文件补充边界处理')
    await vi.waitFor(async () => expect((await c.store.readTaskState(a, c.ws)).status.startsWith('RUNNING')).toBe(true))
    expect((await c.store.readTaskState(a, c.ws)).work_dir).toBe(c.work)
    await writeFile(join(c.work, 'a.mjs'), 'fixed\n')
    expect((await c.service.submit(a, c.ws, 'claude', { artifacts: 'a.mjs' })).version).toBe('delivery-2')
    await c.runner.cancelTask(a, c.ws)
    await c.store.deleteTask(a, c.ws)
    expect(await readFile(join(c.work, 'a.mjs'), 'utf8')).toBe('fixed\n')
    expect(await readFile(join(c.work, 'b.mjs'), 'utf8')).toBe('keep sibling\n')
    expect((await c.store.readTaskState(b, c.ws)).status.startsWith('RUNNING')).toBe(true)
  })

  it('keeps isolation as an explicit proposal decision and preserves its version checks', async () => {
    const c = await setup()
    const ordinary = [spec('a')]
    const isolated = [{ ...spec('a'), workspace_mode: 'isolated' as const }]
    expect(proposalHash(ordinary)).not.toBe(proposalHash(isolated))
    expect(validateSpecs(isolated)[0].workspace_mode).toBe('isolated')
    expect(() => validateSpecs([{ ...spec('a'), workspace_mode: 'unknown' }])).toThrow(/workspace_mode/)
    const [a] = await derive(c, 'root', isolated)
    const child = await c.store.readTaskState(a, c.ws)
    expect(child.work_dir).not.toBe(c.work)
    expect(child.workspace_mode).toBe('isolated')
    await expect(c.service.submit(a, c.ws, 'claude', { version: '1' })).rejects.toThrow(/不一致/)
  })

  it('does not silently reuse an existing child when the proposal explicitly changes workspace mode', async () => {
    const c = await setup()
    const [a] = await derive(c, 'root', [{ ...spec('a'), workspace_mode: 'isolated' }])
    const previous = await c.store.readTaskState(a, c.ws)
    await expect(derive(c, 'root', [{ ...spec('a'), workspace_mode: 'shared' }])).rejects.toThrow(/不同工作区模式/)
    expect((await c.store.readTaskState(a, c.ws)).work_dir).toBe(previous.work_dir)
    expect((await c.store.readTaskState(a, c.ws)).workspace_mode).toBe('isolated')
  })

  it('runs the four-task label demo in a dirty Git project without commits, copies or cherry-picks', async () => {
    const c = await setup()
    await writeFile(join(c.repo, 'existing.txt'), '父任务进行中的改动\n')
    const head = await exec('git', ['rev-parse', 'HEAD'], c.repo)
    const [a, b] = await derive(c)
    const [grand] = await derive(c, a, [spec('clean-tags')])
    await writeFile(join(c.work, 'summarize-tags.mjs'), "export const summarizeTags = tags => ({ count: tags.length, text: tags.join(' / ') });\n")
    await c.service.submit(b, c.ws, 'claude', { artifacts: 'summarize-tags.mjs', verification: '独立汇总验证通过' })
    await confirm(c, b)
    await writeFile(join(c.work, 'clean-tags.mjs'), "export const cleanTags = tags => tags.map(t => t.trim()).filter(Boolean);\n")
    await c.service.submit(grand, c.ws, 'claude', { artifacts: 'clean-tags.mjs', verification: '清理逻辑验证通过' })
    await confirm(c, grand)
    await c.service.review(a, c.ws, 'codex', grand, 'accept', '清理字符串范围已验收')
    await writeFile(join(c.work, 'normalize-tags.mjs'), "import {cleanTags} from './clean-tags.mjs'; export function normalizeTags(tags) { const seen = new Set(); return cleanTags(tags).filter(t => { const k=t.toLowerCase(); if(seen.has(k)) return false; seen.add(k); return true; }); }\n")
    await c.service.submit(a, c.ws, 'claude', { artifacts: 'clean-tags.mjs, normalize-tags.mjs', verification: '规范化验证通过' })
    await confirm(c, a)
    await writeFile(join(c.work, 'index.mjs'), "import {normalizeTags} from './normalize-tags.mjs'; import {summarizeTags} from './summarize-tags.mjs'; export const analyzeTags = tags => summarizeTags(normalizeTags(tags));\n")
    await writeFile(join(c.work, 'index.test.mjs'), `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {analyzeTags} from './index.mjs';
test('example',()=>assert.deepEqual(analyzeTags([' AI ','ai','','Buddy',' buddy ']),{count:2,text:'AI / Buddy'}));
test('empty',()=>assert.deepEqual(analyzeTags([]),{count:0,text:''}));
test('whitespace',()=>assert.deepEqual(analyzeTags([' ','\\t']),{count:0,text:''}));
test('case',()=>assert.deepEqual(analyzeTags(['b','B']),{count:1,text:'b'}));
test('order',()=>assert.deepEqual(analyzeTags(['b','a','B']),{count:2,text:'b / a'}));
test('pure',()=>{const a=[' a ','A'];analyzeTags(a);assert.deepEqual(a,[' a ','A']);});\n`)
    const result = await exec(process.execPath, ['--test', 'index.test.mjs'], c.work)
    expect(result).toMatch(/(?:pass 6|"passed":6)/)
    await c.service.review('root', c.ws, 'codex', a, 'accept', '实际 node:test 六项通过')
    await c.service.review('root', c.ws, 'codex', b, 'accept', '实际 node:test 六项通过')
    await confirm(c, 'root')
    for (const id of ['root', a, b, grand]) expect((await c.store.readTaskState(id, c.ws)).status).toBe('DONE')
    expect(await exec('git', ['rev-parse', 'HEAD'], c.repo)).toBe(head)
    expect(await readFile(join(c.repo, 'existing.txt'), 'utf8')).toContain('进行中的改动')
  })
})
