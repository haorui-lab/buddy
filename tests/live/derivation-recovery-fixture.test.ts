import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuddyRunner } from '../../src/main/buddy/runner'
import { BuddyStore } from '../../src/main/buddy/store'

// Creates only disposable fixture data, ready to open in a real Electron build.
describe.skipIf(process.env.CREATE_BUDDY_UI_FIXTURE !== '1')('derivation recovery UI fixture', () => {
  it('stops a real actor handoff at blocked completion and retains a failed ACP round', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-recovery-ui-'))
    const store = new BuddyStore(join(root, 'data'))
    const actor = join(root, 'break.cjs')
    await writeFile(actor, `console.log(JSON.stringify({type:'break',content:'隔离验收：双方请求结束，但失败子任务尚未处理。'}))`)
    const launcher = { command: `${process.execPath} ${actor}`, env: {}, timeout_seconds: 5 }
    const parent = await store.createTask({ task_id: '派生阻塞验收', repo_root: root, task_text: '隔离验收：两个 Actor 请求结束后，因必要子任务未完成而自动暂停。', settings: { launchers: { claude: launcher, codex: launcher } } })
    await store.createTask({ task_id: '失败子任务验收', repo_root: root, workspace_key: parent.workspace_key, parent_task_id: parent.task })
    await store.updateTaskState('失败子任务验收', parent.workspace_key, s => ({ ...s, status: 'FAILED', last_error: { message: '隔离样本：模拟执行失败，非新的真实故障' } }))
    await store.updateTaskState(parent.task, parent.workspace_key, s => ({ ...s, child_task_ids: ['失败子任务验收'] }))
    const runner = new BuddyRunner(store)
    await runner.startTask(parent.task, { workspace_key: parent.workspace_key, actor: 'claude' })
    const state = await store.readTaskState(parent.task, parent.workspace_key)
    expect(state.status).toBe('PAUSED'); expect(state.round).toBe(2); expect(state.active_run).toBeNull()

    const acp = join(root, 'failed-acp.cjs')
    await writeFile(acp, `
      const rl=require('readline').createInterface({input:process.stdin});
      const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
      rl.on('line',line=>{const r=JSON.parse(line);
        if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1}});
        else if(r.method==='session/new')send({id:r.id,result:{sessionId:'fixture-partial-session'}});
        else if(r.method==='session/prompt'){
          const update=u=>send({method:'session/update',params:{sessionId:'fixture-partial-session',update:u}});
          update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'已读取输入文件，但模型连接中断。这是隔离验收样本，未生成最终结论。'}});
          update({sessionUpdate:'tool_call',toolCallId:'t1',title:'Read',rawInput:{}});
          update({sessionUpdate:'tool_call_update',toolCallId:'t1',rawInput:{file_path:'input.txt'}});
          update({sessionUpdate:'tool_call_update',toolCallId:'t1',status:'completed',rawOutput:'fixture input verified'});
          send({id:r.id,error:{code:-32603,message:'隔离样本：Stream ended without receiving any events'}});
        }
      });
    `)
    const partial = await store.createTask({ task_id: '执行中断记录验收', repo_root: root, workspace_key: parent.workspace_key, settings: { launchers: { opencode: { protocol: 'acp', command: process.execPath, args: [acp], env: {}, timeout_seconds: 5 } } } })
    await expect(runner.startTask(partial.task, { workspace_key: partial.workspace_key, actor: 'opencode' })).rejects.toThrow(/隔离样本/)
    const detail = await store.getTaskDetail(partial.task, partial.workspace_key)
    expect(detail.state.actor_sessions?.opencode).toBe('fixture-partial-session')
    expect(detail.transcript.some(row => row.meta?.partial)).toBe(true)
    const run = detail.events.find(e => e.type === 'actor.started')!.run_id!
    const events = await store.getRoundEvents(partial.task, run, partial.workspace_key)
    expect(events!.events.find(e => e.type === 'tool_use')!.toolInput).toEqual({ file_path: 'input.txt' })
    await writeFile('/tmp/buddy-recovery-ui-fixture.json', JSON.stringify({ root, dataRoot: store.dataRoot, workspaceKey: parent.workspace_key, parent: parent.task, child: '失败子任务验收', partial: partial.task }, null, 2))
    expect(await readFile('/tmp/buddy-recovery-ui-fixture.json', 'utf8')).toContain(store.dataRoot)
  }, 15000)
})
