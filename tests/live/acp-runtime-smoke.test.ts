import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuddyRunner } from '../../src/main/buddy/runner'
import { BuddyStore } from '../../src/main/buddy/store'

// Opt-in: uses the locally installed WeCode ACP adapter and account. Everything
// written by the actor stays in a fresh temporary fixture, never the user's repo.
describe.skipIf(process.env.RUN_LIVE_ACP !== '1')('real WeCode ACP execution', () => {
  it('reads, runs a shell command, writes a file and preserves inspectable results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-acp-live-runner-'))
    const repo = join(root, 'repo'); await mkdir(repo)
    const marker = `buddy-verified-${Date.now()}\n`
    await writeFile(join(repo, 'input.txt'), marker)
    const store = new BuddyStore(join(root, 'data'))
    await store.updateGlobalSettings({ ...(await store.readGlobalSettings()), max_rounds: 1 })
    const task = await store.createTask({
      task_id: 'acp-runtime-smoke', repo_root: repo,
      task_text: '隔离联调：必须实际用工具读取 input.txt，执行 shell 命令 printf buddy-shell-ok，再写 output.txt 内容严格等于 input.txt。只修改 output.txt，不要联网，不要派生子任务，不要改配置或提交。完成后按 Buddy 协议回复 type=chat，content=文件已核验。',
      settings: { implementer_actor: 'wecode_claude', reviewer_actor: 'cursor', launchers: {
        wecode_claude: { protocol: 'acp', command: 'claude-agent-acp', env: {}, timeout_seconds: 120 }
      } }
    })
    const runner = new BuddyRunner(store)
    try {
      await runner.startTask(task.task, { workspace_key: task.workspace_key, actor: 'wecode_claude' })
      const detail = await store.getTaskDetail(task.task, task.workspace_key)
      expect(await readFile(join(repo, 'output.txt'), 'utf8')).toBe(marker)
      expect(detail.state.status).toBe('PAUSED')
      expect(detail.state.active_run).toBeNull()
      expect(detail.state.wecode_claude_session_id).toBeTruthy()
      const runId = detail.events.find(event => event.type === 'actor.started')!.run_id!
      const round = await store.getRoundEvents(task.task, runId, task.workspace_key, 'wecode_claude')
      expect(round!.events.some(event => event.type === 'tool_use' && Object.keys(event.toolInput ?? {}).length > 0)).toBe(true)
      expect(round!.events.some(event => event.type === 'tool_result' && !event.isError)).toBe(true)
      expect(round!.events.some(event => event.type === 'tool_result' && event.toolResultPreview?.includes('buddy-shell-ok'))).toBe(true)
      await writeFile('/tmp/buddy-acp-runtime-smoke-report.json', JSON.stringify({ root, status: detail.state.status, round: detail.state.round, fileMatches: true, toolCalls: round!.events.filter(e => e.type === 'tool_use').length, toolResults: round!.events.filter(e => e.type === 'tool_result').length }, null, 2))
    } finally {
      const state = await store.readTaskState(task.task, task.workspace_key)
      if (state.active_run) await runner.interrupt(task.task, task.workspace_key)
    }
  }, 150000)
})
