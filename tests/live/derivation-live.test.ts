import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuddyRunner } from '../../src/main/buddy/runner'
import { BuddyStore } from '../../src/main/buddy/store'
import { taskChildren } from '../../src/renderer/lib/taskList'
import type { TaskState } from '../../src/shared/types'

const ROOT = join(tmpdir(), 'buddy-live-derive')
const LOG = join(ROOT, 'progress.log')
const REPORT = join(ROOT, 'report.json')

function log(message: string) {
  const line = `${new Date().toISOString()} ${message}`
  mkdirSync(ROOT, { recursive: true })
  appendFileSync(LOG, line + '\n')
  console.log(line)
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${stderr || stdout || error.message}`))
      else resolve(stdout.trim())
    })
  })
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('live derivation with real actors', () => {
  it('runs the plan flow through BuddyRunner, Claude and Codex', async () => {
    mkdirSync(ROOT, { recursive: true })
    const repo = await mkdtemp(join(ROOT, 'repo-'))
    const dataRoot = await mkdtemp(join(ROOT, 'data-'))
    await git(repo, ['init'])
    await git(repo, ['config', 'user.email', 'buddy-live@example.com'])
    await git(repo, ['config', 'user.name', 'Buddy Live'])
    await writeFile(join(repo, 'README.md'), 'live derivation fixture\n')
    await git(repo, ['add', 'README.md'])
    await git(repo, ['commit', '-m', 'init'])

    const store = new BuddyStore(dataRoot)
    await store.updateGlobalSettings({
      ...(await store.readGlobalSettings()),
      allow_nested_derivation: false,
      system_notifications_enabled: false,
      auto_generate_commit_message: false,
      countdown_seconds: 1
    })
    const created = await store.createTask({
      task_id: 'live-root',
      repo_root: repo,
      task_text: [
        '这是一次 Buddy 派生联调。仓库里只有 README.md。不要改 git config，不要 push，不要改 Buddy 源码。',
        '',
        '严格按顺序做：',
        '1. 先执行派生 status。当前必须允许创建一级子任务。不允许的话就停止说明原因，不要提案。',
        '2. 按派生说明里的 propose 路径，把下面 JSON 原样写到那个文件，再执行那条 propose 命令。不要把方案写进当前工作目录。',
        '{"specs":[{"key":"alpha","workspace_mode":"isolated","title":"写入 alpha.txt","goal":"在当前工作目录新建 alpha.txt，内容只有一行 alpha。然后 git add alpha.txt 并 git commit。不要再派生子任务。必须先 submit，version 等于 git rev-parse HEAD。submit 成功之后，双方才能 type=break。没有 submit 就 break，不会进入验收。","scope":"只改当前工作目录的 alpha.txt","context":"这是一级子任务，不能继续派生。","dependencies":[],"deliverables":"已提交的 alpha.txt","acceptance":"文件内容是 alpha，并且 git status --porcelain 为空"},{"key":"beta","workspace_mode":"isolated","title":"写入 beta.txt","goal":"在当前工作目录新建 beta.txt，内容只有一行 beta。然后 git add beta.txt 并 git commit。不要再派生子任务。必须先 submit，version 等于 git rev-parse HEAD。submit 成功之后，双方才能 type=break。没有 submit 就 break，不会进入验收。","scope":"只改当前工作目录的 beta.txt","context":"这是一级子任务，不能继续派生。","dependencies":[],"deliverables":"已提交的 beta.txt","acceptance":"文件内容是 beta，并且 git status --porcelain 为空"}]}',
        '3. propose 之后只对自己执行 decide agree，理由写同意这一版。不能代替另一位 Actor。',
        '4. 另一位还没同意时不要 create。用 type=chat 说明在等对方。',
        '5. 两位都同意后执行 create，然后执行 wait。',
        '6. 子任务提交交付后，对每个直接子任务执行 review accept，意见写通过。工作区不干净就不要 accept。',
        '7. 两个子任务都验收通过后，再 type=break。'
      ].join('\n')
    })
    const ws = created.workspace_key
    const runner = new BuddyRunner(store)
    log(`start repo=${repo} data=${dataRoot} task=${created.task} ws=${ws}`)

    const parentRun = runner.startTask(created.task, { workspace_key: ws }).then(
      value => {
        log(`parent startTask resolved ${JSON.stringify(value)}`)
        return value
      },
      error => {
        log(`parent startTask rejected ${error instanceof Error ? error.message : error}`)
        throw error
      }
    )

    let nestedError = ''
    let nestedChecked = false
    let parallelAt = ''
    const seen = new Map<string, string>()
    const deadline = Date.now() + 25 * 60 * 1000
    let finalTasks: Array<{ task_id: string; title?: string; status: string; parent_task_id?: string | null }> = []

    while (Date.now() < deadline) {
      const tasks = await store.getTasks()
      const rows: string[] = []
      const live: Array<{ task_id: string; title?: string; status: string; parent_task_id?: string | null; work_dir?: string }> = []
      for (const task of tasks) {
        const state = await store.readTaskState(task.task_id, ws).catch(() => null)
        if (!state) continue
        live.push({
          task_id: task.task_id,
          title: state.title,
          status: state.status,
          parent_task_id: state.parent_task_id,
          work_dir: state.work_dir
        })
        const key = `${state.status}|${state.delivery?.version ?? ''}|${state.acceptance?.decision ?? ''}|${state.derivation_proposal?.status ?? ''}`
        rows.push(`${task.task_id} ${state.status} parent=${state.parent_task_id ?? '-'} proposal=${state.derivation_proposal?.status ?? '-'} children=${(state.child_task_ids ?? []).length}`)
        if (seen.get(task.task_id) !== key) {
          seen.set(task.task_id, key)
          log(`state ${task.task_id} ${key} title=${state.title ?? ''}`)
        }
      }
      const children = live.filter(task => task.parent_task_id === created.task)
      const activeChildren = children.filter(task => task.status === 'PINGING' || task.status.startsWith('RUNNING'))
      if (!parallelAt && activeChildren.length >= 2) {
        parallelAt = new Date().toISOString()
        log(`parallel children ${activeChildren.map(task => `${task.task_id}:${task.status}`).join(' ')}`)
      }
      if (!nestedChecked && children.length > 0) {
        nestedChecked = true
        const child = children[0]
        const section = await runner.derivation.promptSection(child.task_id, ws)
        log(`child prompt permission line: ${section.split('\n').find(line => line.startsWith('当前派生权限')) ?? 'missing'}`)
        try {
          await runner.derivation.propose(child.task_id, ws, 'claude', [{
            key: 'nested',
            title: '不应该出现',
            goal: '二级派生应被拒绝',
            scope: '无',
            context: '无',
            dependencies: [],
            deliverables: '无',
            acceptance: '无'
          }])
          nestedError = 'UNEXPECTED: nested propose succeeded'
        } catch (error) {
          nestedError = error instanceof Error ? error.message : String(error)
        }
        log(`nested propose result: ${nestedError}`)
      }
      finalTasks = live
      const parent = live.find(task => task.task_id === created.task)
      const childrenDone = children.length >= 2 && children.every(task => task.status === 'DONE' || task.status === 'AWAITING_ACCEPTANCE')
      if (parent?.status === 'DONE' || (parent?.status === 'FAILED' && children.length === 0 && seen.get(created.task)?.includes('FAILED'))) {
        if (parent.status === 'DONE' || !parent.status.startsWith('RUNNING')) {
          if (parent.status === 'DONE' || parent.status === 'FAILED' || parent.status === 'PAUSED') {
            log(`stop loop because parent is ${parent.status}`)
            break
          }
        }
      }
      if (parent?.status === 'DONE') break
      if (childrenDone && (parent?.status === 'DONE' || parent?.status === 'WAITING_CHILDREN' || parent?.status === 'READY')) {
        // Keep waiting so the parent can accept and break, unless it already failed closed.
      }
      if (parentRun) {
        // touch the promise so a rejection is noticed by the log handler
      }
      await sleep(4000)
      if (rows.length === 0) log('no tasks yet')
    }

    const snapshots: TaskState[] = []
    for (const task of await store.getTasks()) {
      snapshots.push(await store.readTaskState(task.task_id, ws))
    }
    const tree = taskChildren(await store.getTasks(), created.task, ws).map(task => ({
      task_id: task.task_id,
      title: task.title,
      status: task.status,
      parent_task_id: task.parent_task_id
    }))
    const report = {
      repo,
      dataRoot,
      workspace: ws,
      parallelAt,
      nestedError,
      tree,
      tasks: snapshots.map(state => ({
        task_id: state.task_id,
        title: state.title,
        status: state.status,
        parent_task_id: state.parent_task_id,
        derivation_depth: state.derivation_depth,
        work_dir: state.work_dir,
        child_task_ids: state.child_task_ids,
        proposal: state.derivation_proposal?.status,
        decisions: state.derivation_proposal?.decisions?.map(item => `${item.actor}:${item.decision}`),
        delivery: state.delivery?.version,
        acceptance: state.acceptance?.decision,
        latest_failure: state.latest_failure?.message
      }))
    }
    await writeFile(REPORT, JSON.stringify(report, null, 2))
    log(`report written ${REPORT}`)
    await runner.cancelTask(created.task, ws).catch(error => {
      log(`cancel failed ${error instanceof Error ? error.message : error}`)
    })
    await Promise.race([parentRun.catch(() => undefined), sleep(5000)])

    expect(report.tasks.length).toBeGreaterThan(0)
    expect(nestedError).toMatch(/不能继续派生|全局开关/)
    expect(report.tasks.filter(task => task.parent_task_id === created.task).length).toBe(2)
    expect(parallelAt).not.toBe('')
  }, 28 * 60 * 1000)
})
