import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import clientSource from './derivation-client.cjs?raw'
import type {
  DerivationProposal,
  DerivationSpec,
  GlobalSettings,
  TaskDelivery,
  TaskSettings,
  TaskState,
  TaskStatus
} from '../../shared/types'
import { DEFAULT_DERIVATION_PROMPT, normalizeGlobalSettings } from '../../shared/defaults'
import { implementerActor, reviewerActor } from './prompts'
import type { BuddyEventBus } from './events'
import type { BuddyStore } from './store'

const KEY_PATTERN = /^[a-zA-Z0-9._-]{1,40}$/

export interface ChildSnapshot {
  task_id: string
  status: TaskStatus
  waived?: boolean
}

export interface DerivationHooks {
  startTask: (taskId: string, workspaceKey: string) => Promise<unknown>
  terminal: (workspaceKey: string) => void
  cleanup: (taskId: string, workspaceKey: string) => Promise<boolean>
  events?: BuddyEventBus
}

export interface DerivationSession {
  env: Record<string, string>
  close: () => void
}

export function derivationPermission(input: {
  depth: number
  status: TaskStatus
  allowNested: boolean
}): { allowed: boolean; reason: string } {
  if (input.status === 'CANCELLED') return { allowed: false, reason: '任务已取消，不能派生' }
  if (input.status === 'DONE') return { allowed: false, reason: '任务已结束，不能派生' }
  if (input.status === 'AWAITING_ACCEPTANCE') return { allowed: false, reason: '当前任务正在等待父任务验收，不能再派生' }
  if (input.depth >= 1 && !input.allowNested) {
    return { allowed: false, reason: '全局开关关闭，子任务不能继续派生' }
  }
  return { allowed: true, reason: input.depth >= 1 ? '允许继续向下派生' : '允许创建一级子任务' }
}

export function proposalHash(specs: DerivationSpec[]): string {
  return createHash('sha256').update(JSON.stringify(specs.map(canonicalSpec))).digest('hex')
}

export function derivedTaskId(parentId: string, specKey: string): string {
  const digest = createHash('sha256').update(`${parentId}\n${specKey}`).digest('hex').slice(0, 10)
  const slug = specKey.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'sub'
  const id = `${slug}-${digest}`
  return [...id].length > 64 ? digest : id
}

export function validateSpecs(input: unknown): DerivationSpec[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('派生方案至少要包含一个子任务')
  if (input.length > 20) throw new Error('一次最多提出 20 个子任务')
  const specs = input.map(readSpec)
  const keys = new Set<string>()
  for (const spec of specs) {
    if (keys.has(spec.key)) throw new Error(`子任务标识重复：${spec.key}`)
    keys.add(spec.key)
  }
  const color = new Map<string, number>()
  const byKey = new Map(specs.map(spec => [spec.key, spec]))
  const visit = (key: string): void => {
    const state = color.get(key) ?? 0
    if (state === 1) throw new Error(`子任务依赖成环：${key}`)
    if (state === 2) return
    color.set(key, 1)
    for (const dep of byKey.get(key)?.dependencies ?? []) {
      if (!keys.has(dep)) throw new Error(`依赖的子任务不在本次方案中：${dep}`)
      visit(dep)
    }
    color.set(key, 2)
  }
  for (const spec of specs) visit(spec.key)
  return specs
}

export function latestDecisions(proposal: DerivationProposal): Map<string, DerivationProposal['decisions'][number]> {
  const map = new Map<string, DerivationProposal['decisions'][number]>()
  for (const decision of proposal.decisions) {
    if (decision.proposal_hash !== proposal.proposal_hash) continue
    map.set(decision.actor, decision)
  }
  return map
}

export function bothAgreed(proposal: DerivationProposal, actors: [string, string]): boolean {
  const decisions = latestDecisions(proposal)
  return actors.every(actor => decisions.get(actor)?.decision === 'agree')
}

/** 已完成，或已取消且父任务明确解除必要性的子任务，不再挡住父任务。 */
export function blocksParentCompletion(child: { status: TaskStatus; waived?: boolean }): boolean {
  if (child.status === 'DONE') return false
  if (child.status === 'CANCELLED' && child.waived) return false
  return true
}

/** 父任务必须亲自处理的结果。交付了但子任务还在跑，只是内部确认还没结束，不算。 */
export function childResultNeedsParent(child: { status: TaskStatus; last_error?: unknown; latest_failure?: unknown }): boolean {
  return child.status === 'AWAITING_ACCEPTANCE' || child.status === 'FAILED' || child.status === 'CANCELLED'
    || (child.status === 'PAUSED' && Boolean(child.last_error || child.latest_failure))
}

/** 必要子任务未验收通过时，父任务不能结束。子任务要先提交交付，双方确认后才进入待验收。 */
export function resolveBreakOutcome(
  state: { parent_task_id?: string | null; delivery?: { version?: string } | null },
  children: ChildSnapshot[]
): 'done' | 'await_parent' | 'blocked' | 'needs_delivery' {
  if (children.some(child => blocksParentCompletion(child))) return 'blocked'
  if (state.parent_task_id) {
    if (!state.delivery?.version) return 'needs_delivery'
    return 'await_parent'
  }
  return 'done'
}

export function shouldEnterChildWait(
  state: { derivation_hold?: 'children' | null },
  breakConfirmed: boolean,
  breakPending: boolean
): boolean {
  return state.derivation_hold === 'children' && !breakConfirmed && !breakPending
}

export function formatDerivationSection(input: {
  allowed: boolean
  reason: string
  prompt: string
  proposal: DerivationProposal | null
  actors: { implementer: string; reviewer: string }
  children: Array<{
    task_id: string
    title?: string
    status: string
    unreadable?: boolean
    work_dir?: string
    delivery?: TaskState['delivery']
    acceptance?: TaskState['acceptance']
    waived?: boolean
  }>
  workDir?: string
  session?: Record<string, string>
  specFile: string
}): string {
  const lines = [
    input.prompt.trim(),
    '',
    `当前派生权限：${input.allowed ? '允许' : '不允许'}。${input.reason}`,
    input.workDir ? `当前任务工作目录：${input.workDir}` : '',
    '',
    '已有子任务：'
  ]
  if (input.children.length === 0) lines.push('- 无')
  for (const child of input.children) {
    const review = child.acceptance
      ? `；验收 ${child.acceptance.decision === 'accept' ? '通过' : '退回'}：${child.acceptance.comment}`
      : ''
    const waived = child.waived ? '；已解除必要性' : ''
    const version = child.delivery?.version ? `；交付版本 ${child.delivery.version}` : ''
    lines.push(`- ${child.task_id} ${child.title || ''} 状态 ${child.unreadable ? '损坏（无法读取状态）' : child.status}${child.work_dir ? `；目录 ${child.work_dir}` : ''}${version}${review}${waived}`)
  }
  lines.push('', '当前方案确认进度：')
  if (!input.proposal || input.proposal.status === 'rejected') {
    lines.push('- 没有待确认方案')
  } else {
    const decisions = latestDecisions(input.proposal)
    lines.push(`- 方案 ${input.proposal.proposal_id} 版本 ${input.proposal.proposal_hash.slice(0, 12)} 状态 ${input.proposal.status}`)
    for (const actor of [input.actors.implementer, input.actors.reviewer]) {
      const decision = decisions.get(actor)
      lines.push(`- ${actor}：${decision ? `${decision.decision === 'agree' ? '同意' : '不同意'} ${decision.reason}` : '未表态'}`)
    }
    if (input.proposal.created_task_ids.length > 0) {
      lines.push(`- 已创建：${input.proposal.created_task_ids.join(', ')}`)
    }
  }
  const command = (args: string) => derivationCommand(input.session, args)
  lines.push(
    '',
    '派生操作（只记录你自己的决定，不能代替另一位 Actor）：',
    '有些 Actor 的登录 shell 不会继承环境变量。请原样执行下面的命令，不要改成只依赖 $BUDDY_DERIVATION_NODE。',
    command('status'),
    command(`propose ${shellQuote(input.specFile)}`),
    command('decide agree 理由'),
    command('decide disagree 理由'),
    command('create'),
    command('wait'),
    command('submit --version VERSION --artifacts PATHS --verification RESULT --issues TEXT'),
    command('review CHILD_TASK_ID accept 意见'),
    command('review CHILD_TASK_ID reject 意见'),
    command('waive CHILD_TASK_ID 原因'),
    command('restart CHILD_TASK_ID'),
    '',
    `方案写到 ${input.specFile}。不要把方案文件写进当前工作目录，未跟踪文件会让创建被拒绝。`,
    '文件内容形如 {"specs":[{"key":"api","title":"标题","goal":"目标","scope":"范围","context":"上下文","dependencies":[],"deliverables":"交付物","acceptance":"验收条件"}]}。',
    '独立子任务会真正并行启动。修改方案后必须双方重新确认。重复创建不会产生第二份任务。',
    '已取消的子任务会挡住父任务结束，除非父任务用 waive 写明原因并解除必要性。失败的子任务用 restart 重新启动；要放弃它，先取消再用 waive。',
    '子任务必须先 submit，再由双方确认结束。没有交付记录时，不会进入父任务验收。'
  )
  return lines.filter(line => line !== undefined).join('\n')
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** 把本回合的 socket 和 token 写进命令。Codex 的登录 shell 不会继承父进程环境变量。 */
export function derivationCommand(session: Record<string, string> | undefined, args: string): string {
  const node = session?.BUDDY_DERIVATION_NODE
  const cli = session?.BUDDY_DERIVATION_CLI
  const socket = session?.BUDDY_DERIVATION_SOCKET
  const token = session?.BUDDY_DERIVATION_TOKEN
  if (!node || !cli || !socket || !token) {
    return `ELECTRON_RUN_AS_NODE=1 "$BUDDY_DERIVATION_NODE" "$BUDDY_DERIVATION_CLI" ${args}`
  }
  return `BUDDY_DERIVATION_SOCKET=${shellQuote(socket)} BUDDY_DERIVATION_TOKEN=${shellQuote(token)} ELECTRON_RUN_AS_NODE=1 ${shellQuote(node)} ${shellQuote(cli)} ${args}`
}

function canonicalSpec(spec: DerivationSpec): DerivationSpec {
  return {
    key: spec.key,
    title: spec.title,
    goal: spec.goal,
    scope: spec.scope,
    context: spec.context,
    dependencies: [...spec.dependencies],
    deliverables: spec.deliverables,
    acceptance: spec.acceptance
  }
}

function readSpec(value: unknown): DerivationSpec {
  if (!value || typeof value !== 'object') throw new Error('子任务方案格式不正确')
  const raw = value as Record<string, unknown>
  const key = typeof raw.key === 'string' ? raw.key.trim() : ''
  if (!KEY_PATTERN.test(key)) throw new Error('子任务 key 只能使用字母、数字、点、下划线和短横线，最长 40 字符')
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!title) throw new Error(`子任务 ${key} 缺少标题`)
  const text = (field: string, limit = 8000) => {
    const item = raw[field]
    const valueText = typeof item === 'string' ? item.trim() : ''
    if ([...valueText].length > limit) throw new Error(`子任务 ${key} 的 ${field} 过长`)
    return valueText
  }
  const dependencies = Array.isArray(raw.dependencies)
    ? raw.dependencies.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
    : []
  return {
    key,
    title,
    goal: text('goal'),
    scope: text('scope'),
    context: text('context'),
    dependencies,
    deliverables: text('deliverables'),
    acceptance: text('acceptance')
  }
}

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function actorsOf(settings: TaskSettings): [string, string] {
  return [implementerActor(settings), reviewerActor(settings)]
}

function taskTextOf(spec: DerivationSpec, parentId: string): string {
  return [
    `# ${spec.title}`,
    '',
    `父任务：${parentId}`,
    '',
    '## 目标',
    spec.goal || '（未填写）',
    '',
    '## 工作范围',
    spec.scope || '（未填写）',
    '',
    '## 必要上下文',
    spec.context || '（未填写）',
    '',
    '## 依赖',
    spec.dependencies.length ? spec.dependencies.join(', ') : '无',
    '',
    '## 交付物',
    spec.deliverables || '（未填写）',
    '',
    '## 验收条件',
    spec.acceptance || '（未填写）'
  ].join('\n')
}

function childSettings(parent: TaskSettings): Record<string, unknown> {
  return {
    ...parent,
    seed_claude_session_id: '',
    seed_codex_thread_id: '',
    seed_cursor_session_id: '',
    seed_agy_session_id: '',
    seed_opencode_session_id: '',
    seed_kimi_session_id: '',
    seed_wecode_claude_session_id: '',
    seed_wecode_codex_thread_id: '',
    seed_wecode_opencode_session_id: ''
  }
}

async function runGit(repo: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile('git', ['-C', repo, ...args], { timeout: 20000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: `${stdout || ''}`.trim(),
        stderr: `${stderr || ''}`.trim()
      })
    })
  })
}

export class DerivationService {
  private readonly tails = new Map<string, Promise<unknown>>()
  private clientPath: Promise<string> | null = null

  constructor(
    private readonly store: BuddyStore,
    private readonly hooks: DerivationHooks
  ) {}

  async promptSection(taskId: string, workspaceKey: string, globalSettings?: GlobalSettings, session?: Record<string, string>): Promise<string> {
    const state = await this.store.readTaskState(taskId, workspaceKey)
    const settings = await this.store.readTaskSettings(taskId, workspaceKey)
    const global = normalizeGlobalSettings(globalSettings ?? await this.store.readGlobalSettings())
    const permission = derivationPermission({
      depth: state.derivation_depth ?? (state.parent_task_id ? 1 : 0),
      status: state.status,
      allowNested: global.allow_nested_derivation ?? false
    })
    const children = []
    for (const childId of state.child_task_ids ?? []) {
      try {
        const child = await this.store.readTaskState(childId, workspaceKey)
        children.push({
          task_id: childId,
          title: child.title,
          status: child.status,
          work_dir: child.work_dir,
          delivery: child.delivery,
          acceptance: child.acceptance,
          waived: Boolean(child.waiver?.reason)
        })
      } catch {
        children.push({ task_id: childId, status: 'FAILED', unreadable: true })
      }
    }
    return formatDerivationSection({
      allowed: permission.allowed,
      reason: permission.reason,
      prompt: global.derivation_prompt?.trim() || DEFAULT_DERIVATION_PROMPT,
      proposal: state.derivation_proposal ?? null,
      actors: { implementer: implementerActor(settings), reviewer: reviewerActor(settings) },
      children,
      workDir: state.work_dir,
      session,
      specFile: join(this.store.taskDirectory(taskId, workspaceKey), 'artifacts', 'derivation-spec.json')
    })
  }

  async status(taskId: string, workspaceKey: string) {
    const state = await this.store.readTaskState(taskId, workspaceKey)
    const settings = await this.store.readTaskSettings(taskId, workspaceKey)
    const global = normalizeGlobalSettings(await this.store.readGlobalSettings())
    const permission = derivationPermission({
      depth: state.derivation_depth ?? (state.parent_task_id ? 1 : 0),
      status: state.status,
      allowNested: global.allow_nested_derivation ?? false
    })
    return {
      allowed: permission.allowed,
      reason: permission.reason,
      actors: actorsOf(settings),
      children: state.child_task_ids ?? [],
      proposal: state.derivation_proposal ?? null,
      delivery: state.delivery ?? null,
      acceptance: state.acceptance ?? null,
      work_dir: state.work_dir ?? null
    }
  }

  propose(taskId: string, workspaceKey: string, actor: string, specsInput: unknown): Promise<DerivationProposal> {
    return this.lock(`${workspaceKey}:${taskId}`, async () => {
      const state = await this.store.readTaskState(taskId, workspaceKey)
      this.assertMutable(state)
      const permission = await this.permissionFor(state)
      if (!permission.allowed) throw new Error(permission.reason)
      const specs = validateSpecs(specsInput)
      const hash = proposalHash(specs)
      const current = state.derivation_proposal
      if (current && current.status === 'open' && current.proposal_hash === hash) return current
      const proposal: DerivationProposal = {
        proposal_id: randomUUID(),
        proposal_hash: hash,
        specs,
        proposed_by: actor,
        proposed_at: utcNow(),
        decisions: [],
        created_task_ids: [],
        status: 'open'
      }
      await this.store.updateTaskState(taskId, workspaceKey, currentState => ({
        ...currentState,
        derivation_proposal: proposal,
        updated_at: utcNow()
      }))
      await this.note(taskId, workspaceKey, 'derivation.proposed', `${actor} 提出了派生方案 ${proposal.proposal_id}，共 ${specs.length} 个子任务。双方需要分别确认这一版。`, { proposal_id: proposal.proposal_id, proposal_hash: hash })
      return proposal
    })
  }

  decide(
    taskId: string,
    workspaceKey: string,
    actor: string,
    decision: 'agree' | 'disagree',
    reason: string
  ): Promise<DerivationProposal> {
    return this.lock(`${workspaceKey}:${taskId}`, async () => {
      const state = await this.store.readTaskState(taskId, workspaceKey)
      this.assertMutable(state)
      const settings = await this.store.readTaskSettings(taskId, workspaceKey)
      const actors = actorsOf(settings)
      if (!actors.includes(actor)) throw new Error('只有当前任务的两位 Actor 可以确认派生方案')
      const permission = await this.permissionFor(state)
      if (!permission.allowed) throw new Error(permission.reason)
      const proposal = state.derivation_proposal
      if (!proposal || proposal.status !== 'open') throw new Error('当前没有等待确认的派生方案')
      const next: DerivationProposal = {
        ...proposal,
        decisions: [
          ...proposal.decisions,
          { actor, decision, reason: reason.trim(), proposal_hash: proposal.proposal_hash, at: utcNow() }
        ]
      }
      await this.store.updateTaskState(taskId, workspaceKey, current => ({
        ...current,
        derivation_proposal: next,
        updated_at: utcNow()
      }))
      await this.note(taskId, workspaceKey, 'derivation.decided', `${actor} ${decision === 'agree' ? '同意' : '不同意'}派生方案。${reason.trim()}`, {
        actor,
        decision,
        proposal_hash: proposal.proposal_hash
      })
      return next
    })
  }

  create(taskId: string, workspaceKey: string): Promise<{ task_ids: string[]; reused: boolean }> {
    return this.lock(`${workspaceKey}:${taskId}`, async () => {
      const state = await this.store.readTaskState(taskId, workspaceKey)
      const settings = await this.store.readTaskSettings(taskId, workspaceKey)
      this.assertMutable(state)
      const proposal = state.derivation_proposal
      if (!proposal || proposal.status === 'rejected') throw new Error('没有可创建的派生方案')
      if (proposal.status === 'created' && proposal.created_task_ids.length > 0) {
        // 方案写成 created 之后、kickAll 之前，父任务仍可能被暂停并触发创建回滚，
        // 把这批新子任务取消。早退前必须逐个检查：有 creation_rollback 的先复活再返回，
        // 否则 reused 会交回一批永远不启动的 CANCELLED，挡死父任务结束。
        await this.reviveRolledBackChildren(proposal.created_task_ids, taskId, workspaceKey, state)
        return { task_ids: proposal.created_task_ids, reused: true }
      }
      // 这一次创建在开始时已经通过权限复核，中途关掉嵌套开关不打断它。
      // 开关只拦住下一次创建请求。暂停、取消、结束会在下面的检查点停掉本次创建。
      const permission = await this.permissionFor(state)
      if (!permission.allowed) throw new Error(`创建前复核未通过：${permission.reason}`)
      const actors = actorsOf(settings)
      if (!bothAgreed(proposal, actors)) throw new Error('同一方案还没有得到两位 Actor 的明确同意')
      const idByKey = new Map(proposal.specs.map(spec => [spec.key, derivedTaskId(taskId, spec.key)]))
      const created: string[] = []
      const fresh: string[] = []
      const parentStopped = async (): Promise<string | null> => {
        const live = await this.store.readTaskState(taskId, workspaceKey)
        if (live.status === 'CANCELLED') return '父任务已取消，不再创建或启动子任务'
        if (live.status === 'DONE' || live.status === 'AWAITING_ACCEPTANCE') return '父任务已结束，不再创建或启动子任务'
        if (live.status === 'PAUSED') return '父任务已暂停，不再创建或启动子任务'
        if (live.status === 'FAILED') return '父任务已失败，不再创建或启动子任务'
        return null
      }
      const stopIfParentClosed = async (): Promise<void> => {
        const reason = await parentStopped()
        if (!reason) return
        await this.cancelFreshChildren(fresh, workspaceKey)
        throw new Error(reason)
      }
      for (const spec of proposal.specs) {
        await stopIfParentClosed()
        const childId = idByKey.get(spec.key)!
        const dependsOn = spec.dependencies.map(key => idByKey.get(key)!).filter(Boolean)
        const record = await this.readChildRecord(childId, workspaceKey)
        if (record.kind === 'unreadable') {
          throw new Error(`子任务 ${childId} 的状态无法读取，工作目录已保留。请先修好状态文件，再继续。`)
        }
        const existing = record.kind === 'present' ? record.state : null
        if (existing) {
          if (existing.parent_task_id !== taskId || existing.spec_key !== spec.key) {
            throw new Error(`子任务标识已被占用：${childId}`)
          }
          const detail = await this.store.getTaskDetail(childId, workspaceKey)
          if (detail.task_text.trim() !== taskTextOf(spec, taskId).trim()) {
            throw new Error(`子任务标识 ${spec.key} 已有不同内容的任务，新方案不能沿用旧任务`)
          }
          if (existing.status === 'CANCELLED') {
            // 创建中途父任务停止时被系统回滚取消的子任务，重试时复活。
            // 用户主动取消的不能被这次重试悄悄拉起。
            if (existing.cancel_cause !== 'creation_rollback') {
              throw new Error(`子任务 ${childId} 已被用户取消，不能通过重新创建拉起。需要放弃的话请用 waive ${childId} 写明原因解除必要性`)
            }
            await this.reviveRolledBackChildren([childId], taskId, workspaceKey, state)
          }
          created.push(childId)
          continue
        }
        const workDir = await this.allocateWorkDir(state, workspaceKey, childId)
        await stopIfParentClosed()
        await this.store.createTask({
          task_id: childId,
          repo_root: state.repo_root,
          workspace_key: workspaceKey,
          task_text: taskTextOf(spec, taskId),
          context_text: spec.context,
          settings: childSettings(settings),
          execution_mode: state.execution_mode ?? 'immediate',
          parent_task_id: taskId,
          root_task_id: state.root_task_id || state.task_id || taskId,
          derivation_depth: (state.derivation_depth ?? 0) + 1,
          title: spec.title,
          work_dir: workDir,
          spec_key: spec.key,
          depends_on_task_ids: dependsOn,
          dependency_blocked: dependsOn.length > 0
        })
        fresh.push(childId)
        created.push(childId)
        await stopIfParentClosed()
      }
      await stopIfParentClosed()
      const saved: DerivationProposal = { ...proposal, status: 'created', created_task_ids: created }
      await this.store.updateTaskState(taskId, workspaceKey, current => ({
        ...current,
        derivation_proposal: saved,
        child_task_ids: [...new Set([...(current.child_task_ids ?? []), ...created])],
        updated_at: utcNow()
      }))
      await this.note(taskId, workspaceKey, 'derivation.created', `已创建子任务：${created.join(', ')}。`, { task_ids: created })
      const ready = []
      for (const childId of created) {
        const child = await this.store.readTaskState(childId, workspaceKey)
        if (!child.dependency_blocked && child.status !== 'DONE' && child.status !== 'CANCELLED' && !child.status.startsWith('RUNNING')) {
          ready.push(childId)
        }
      }
      // kickAll 只负责启动 READY 的子任务。复活后立即被并发暂停（PAUSED）的子任务
      // 留给用户显式恢复，kickAll 轮询到 PAUSED 即视为已处理，不会误报失败。
      await stopIfParentClosed()
      if ((state.execution_mode ?? 'immediate') === 'queued') {
        this.hooks.terminal(workspaceKey)
      } else {
        await this.kickAll(ready, workspaceKey)
      }
      return { task_ids: created, reused: false }
    })
  }

  async wait(taskId: string, workspaceKey: string): Promise<{ waiting: boolean; deferred: boolean }> {
    return this.lock(`${workspaceKey}:${taskId}`, () => this.enterWait(taskId, workspaceKey))
  }

  submit(taskId: string, workspaceKey: string, actor: string, input: {
    version?: string
    artifacts?: string
    verification?: string
    open_issues?: string
  }): Promise<TaskDelivery> {
    return this.lock(`${workspaceKey}:${taskId}`, async () => {
      const state = await this.store.readTaskState(taskId, workspaceKey)
      this.assertMutable(state)
      if (!state.parent_task_id) throw new Error('只有子任务需要向父任务提交交付')
      const version = (input.version || '').trim() || await this.headVersion(state.work_dir) || 'unversioned'
      const delivery: TaskDelivery = {
        version,
        artifacts: input.artifacts?.trim() || '',
        verification: input.verification?.trim() || '',
        open_issues: input.open_issues?.trim() || '',
        submitted_at: utcNow(),
        submitted_by: actor
      }
      await this.store.updateTaskState(taskId, workspaceKey, current => {
        this.assertMutable(current)
        return { ...current, delivery, acceptance: null, updated_at: utcNow() }
      })
      await this.note(taskId, workspaceKey, 'derivation.submitted', `${actor} 提交了交付，版本 ${version}。`, { version })
      await this.notifyParent(taskId, workspaceKey, `子任务 ${state.title || taskId} 已提交交付。版本 ${version}。验证：${delivery.verification || '未填写'}。未解决问题：${delivery.open_issues || '无'}。`, false)
      return delivery
    })
  }

  review(
    parentId: string,
    workspaceKey: string,
    actor: string,
    childId: string,
    decision: 'accept' | 'reject',
    comment: string
  ): Promise<void> {
    return this.lock(`${workspaceKey}:${parentId}`, async () => {
      const parent = await this.store.readTaskState(parentId, workspaceKey)
      this.assertMutable(parent)
      if (!(parent.child_task_ids ?? []).includes(childId)) throw new Error('这不是当前任务的直接子任务')
      const child = await this.store.readTaskState(childId, workspaceKey)
      if (child.parent_task_id !== parentId) throw new Error('子任务的父任务不匹配')
      if (child.status === 'CANCELLED') throw new Error('子任务已取消，不能验收')
      const text = comment.trim()
      if (decision === 'reject' && !text) throw new Error('退回时必须说明问题')
      if (decision === 'reject') {
        if (child.status !== 'AWAITING_ACCEPTANCE') throw new Error('子任务还没有完成内部确认，不能退回')
        if (child.active_run) throw new Error('子任务仍在运行，不能退回')
      }
      if (decision === 'accept') {
        if (child.status !== 'AWAITING_ACCEPTANCE') throw new Error('子任务还没有完成内部确认，不能验收')
        if (child.active_run) throw new Error('子任务仍在运行，不能验收')
        if (!child.delivery) throw new Error('子任务还没有提交交付')
        const unfinished = await this.unfinishedDescendants(childId, workspaceKey)
        if (unfinished.length > 0) {
          throw new Error(`子任务还有未完成的下级，不能验收：${unfinished.join(', ')}`)
        }
        const dirty = await this.dirtyWorktree(child.work_dir)
        if (dirty) {
          throw new Error(`子任务工作区还有未提交的改动，不能验收通过：${dirty.slice(0, 300)}`)
        }
        const head = await this.headVersion(child.work_dir)
        if (head && child.delivery.version && head !== child.delivery.version) {
          throw new Error(`工作区版本 ${head} 与交付版本 ${child.delivery.version} 不一致，不能沿用这次通过结论`)
        }
        const cleaned = await this.hooks.cleanup(childId, workspaceKey)
        if (!cleaned) throw new Error('子任务后台服务还没清理完，先不要标成已验收')
      }
      const acceptance = {
        decision,
        comment: text,
        at: utcNow(),
        actor,
        version: child.delivery?.version
      }
      await this.store.updateTaskState(childId, workspaceKey, current => {
        if (decision === 'accept' && (current.status !== 'AWAITING_ACCEPTANCE' || current.active_run || !current.delivery)) {
          throw new Error('子任务状态已经变化，不能验收')
        }
        if (decision === 'reject' && (current.status !== 'AWAITING_ACCEPTANCE' || current.active_run)) {
          throw new Error('子任务状态已经变化，不能退回')
        }
        return {
          ...current,
          status: decision === 'accept' ? 'DONE' : 'READY',
          acceptance,
          pending_break: null,
          break_rejected_by: null,
          active_run: null,
          countdown: null,
          updated_at: utcNow()
        }
      })
      const verb = decision === 'accept' ? '验收通过' : '退回修改'
      await this.note(childId, workspaceKey, 'derivation.reviewed', `父任务 ${verb}。${text}`, { decision, version: child.delivery?.version ?? '' })
      await this.note(parentId, workspaceKey, 'derivation.reviewed', `子任务 ${child.title || childId} ${verb}。${text}`, { child_task_id: childId, decision })
      if (decision === 'reject') {
        void this.hooks.startTask(childId, workspaceKey).catch(error => {
          void this.note(childId, workspaceKey, 'derivation.start_failed', `退回后重新启动失败：${error instanceof Error ? error.message : error}`, {})
        })
      } else {
        await this.kickUnblocked(workspaceKey, childId)
      }
      this.hooks.terminal(workspaceKey)
    })
  }

  /** 父任务写明原因后，已取消的子任务不再挡住父任务结束。未取消的子任务不能这样放过。 */
  waive(parentId: string, workspaceKey: string, actor: string, childId: string, reason: string): Promise<void> {
    return this.lock(`${workspaceKey}:${parentId}`, async () => {
      const parent = await this.store.readTaskState(parentId, workspaceKey)
      this.assertMutable(parent)
      if (!(parent.child_task_ids ?? []).includes(childId)) throw new Error('这不是当前任务的直接子任务')
      const text = reason.trim()
      if (!text) throw new Error('解除必要性时必须说明原因')
      const child = await this.store.readTaskState(childId, workspaceKey)
      if (child.parent_task_id !== parentId) throw new Error('子任务的父任务不匹配')
      if (child.status !== 'CANCELLED') throw new Error('只有已取消的子任务可以解除必要性。失败的子任务请用 restart；要放弃它，先取消再用 waive')
      if (child.waiver?.reason) return
      await this.store.updateTaskState(childId, workspaceKey, current => ({
        ...current,
        waiver: { actor, reason: text, at: utcNow() },
        updated_at: utcNow()
      }))
      await this.note(childId, workspaceKey, 'derivation.waived', `父任务解除了这个子任务的必要性：${text}`, { actor })
      await this.note(parentId, workspaceKey, 'derivation.waived', `已解除子任务 ${child.title || childId} 的必要性：${text}`, { child_task_id: childId })
    })
  }

  /** 父任务重新启动失败的直接子任务。已取消的子任务不能被重新拉起。 */
  restart(parentId: string, workspaceKey: string, actor: string, childId: string): Promise<void> {
    return this.lock(`${workspaceKey}:${parentId}`, async () => {
      const parent = await this.store.readTaskState(parentId, workspaceKey)
      this.assertMutable(parent)
      if (!(parent.child_task_ids ?? []).includes(childId)) throw new Error('这不是当前任务的直接子任务')
      const child = await this.store.readTaskState(childId, workspaceKey)
      if (child.parent_task_id !== parentId) throw new Error('子任务的父任务不匹配')
      if (child.status === 'CANCELLED') throw new Error('子任务已取消，不能重启')
      if (child.status !== 'FAILED') throw new Error('只有失败的子任务可以重启')
      const global = await this.store.readGlobalSettings()
      const maximum = global.max_consecutive_failures ?? 10
      if ((child.consecutive_failures ?? 0) >= maximum) throw new Error(`子任务连续失败已达到上限 (${maximum})，请先处理执行器问题`)

      let restarted = false
      await this.store.updateTaskState(childId, workspaceKey, current => {
        // 锁外读到的 FAILED 只是快照。子任务自己的启动不拿父任务的派生锁，
        // 回调里必须复核：已经变化的状态不能被这次重启覆盖。
        // 判据是「不再是 FAILED」：迟到的启动可能已经写了 active_run 而状态仍是 FAILED，
        // 那是启动流程中途的落盘顺序，同样不该被重启打断。
        if (current.status !== 'FAILED') return current
        restarted = true
        return {
          ...current,
          status: 'READY',
          active_run: null,
          pending_break: null,
          break_rejected_by: null,
          countdown: null,
          pause_cause: null,
          updated_at: utcNow()
        }
      })
      if (!restarted) {
        throw new Error('子任务状态在重启前发生了变化，没有执行重启')
      }
      await this.note(childId, workspaceKey, 'derivation.restarted', `${actor} 重新启动了失败的子任务。`, { actor })
      await this.note(parentId, workspaceKey, 'derivation.restarted', `重新启动子任务 ${child.title || childId}。`, { child_task_id: childId })
      void this.hooks.startTask(childId, workspaceKey).catch(error => {
        void this.note(childId, workspaceKey, 'derivation.start_failed', `重新启动失败：${error instanceof Error ? error.message : error}`, {})
      })
      this.hooks.terminal(workspaceKey)
    })
  }

  async notifyParent(childId: string, workspaceKey: string, message: string, failure: boolean): Promise<void> {
    const child = await this.store.readTaskState(childId, workspaceKey)
    if (!child.parent_task_id) return
    const parentId = child.parent_task_id
    await this.lock(`${workspaceKey}:${parentId}`, async () => {
      const parent = await this.store.readTaskState(parentId, workspaceKey).catch(() => null)
      if (!parent || parent.status === 'CANCELLED' || parent.status === 'DONE') return
      await this.note(parentId, workspaceKey, failure ? 'derivation.child_failed' : 'derivation.child_delivered', message, { child_task_id: childId })
      if (!childResultNeedsParent(child)) return
      if (parent.pause_cause === 'user') return
      let wake = false
      await this.store.updateTaskState(parentId, workspaceKey, current => {
        if (['DONE', 'CANCELLED', 'AWAITING_ACCEPTANCE'].includes(current.status) || current.pause_cause === 'user') return current
        if (current.status === 'WAITING_CHILDREN' && !current.active_run) {
          wake = true
          return { ...current, status: 'READY', derivation_hold: null, derivation_wake_pending: null, updated_at: utcNow() }
        }
        return { ...current, derivation_wake_pending: true, updated_at: utcNow() }
      })
      if (wake) {
        void this.hooks.startTask(parentId, workspaceKey).catch(() => {})
        this.hooks.terminal(workspaceKey)
      }
    })
  }

  async childrenNeedParent(taskId: string, workspaceKey: string): Promise<boolean> {
    const state = await this.store.readTaskState(taskId, workspaceKey)
    for (const childId of state.child_task_ids ?? []) {
      const child = await this.store.readTaskState(childId, workspaceKey).catch(() => null)
      if (!child || childResultNeedsParent(child)) return true
    }
    return false
  }

  /** 父任务刚进入等待时，把等待前已经到达的结果补上。用户暂停的不自动拉起。 */
  async releaseWaitIfChildrenReady(taskId: string, workspaceKey: string): Promise<boolean> {
    return this.lock(`${workspaceKey}:${taskId}`, async () => {
      const state = await this.store.readTaskState(taskId, workspaceKey)
      if (state.status !== 'WAITING_CHILDREN' || state.pause_cause === 'user') return false
      const ready = Boolean(state.derivation_wake_pending) || await this.childrenNeedParent(taskId, workspaceKey)
      if (!ready) return false
      let released = false
      await this.store.updateTaskState(taskId, workspaceKey, current => {
        if (current.status !== 'WAITING_CHILDREN' || current.pause_cause === 'user' || current.active_run) return current
        released = true
        return { ...current, status: 'READY', derivation_hold: null, derivation_wake_pending: null, updated_at: utcNow() }
      })
      return released
    })
  }

  async openRun(taskId: string, workspaceKey: string, actor: string, runId: string): Promise<DerivationSession> {
    const state = await this.store.readTaskState(taskId, workspaceKey)
    if (state.status === 'CANCELLED') throw new Error('任务已取消')
    if (state.active_run?.run_id !== runId) throw new Error('Actor run is no longer active')
    const token = randomBytes(32).toString('hex')
    const socketDir = await mkdtemp(join(tmpdir(), 'buddy-derive-'))
    const socket = join(socketDir, 's')
    const client = await this.clientFile()
    let closed = false
    const server = createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      try {
        const live = await this.store.readTaskState(taskId, workspaceKey)
        if (live.status === 'CANCELLED' || live.active_run?.run_id !== runId) {
          throw new Error('这一轮已经结束或任务已取消，不能再操作派生')
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
        const value = await this.handle(taskId, workspaceKey, actor, body)
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value ?? { ok: true }))
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
          error: error instanceof Error ? error.message : String(error)
        }))
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, resolve)
    })
    server.unref()
    return {
      env: {
        BUDDY_DERIVATION_SOCKET: socket,
        BUDDY_DERIVATION_TOKEN: token,
        BUDDY_DERIVATION_NODE: process.execPath,
        BUDDY_DERIVATION_CLI: client
      },
      close: () => {
        if (closed) return
        closed = true
        server.close(() => { void rm(socketDir, { recursive: true, force: true }) })
      }
    }
  }

  private async handle(taskId: string, workspaceKey: string, actor: string, body: Record<string, unknown>) {
    const action = body.action
    if (action === 'status') return this.status(taskId, workspaceKey)
    if (action === 'propose') return this.propose(taskId, workspaceKey, actor, body.specs)
    if (action === 'decide') {
      if (body.decision !== 'agree' && body.decision !== 'disagree') throw new Error('decide 需要 agree 或 disagree')
      return this.decide(taskId, workspaceKey, actor, body.decision, typeof body.reason === 'string' ? body.reason : '')
    }
    if (action === 'create') return this.create(taskId, workspaceKey)
    if (action === 'wait') return this.wait(taskId, workspaceKey)
    if (action === 'submit') {
      return this.submit(taskId, workspaceKey, actor, {
        version: typeof body.version === 'string' ? body.version : '',
        artifacts: typeof body.artifacts === 'string' ? body.artifacts : '',
        verification: typeof body.verification === 'string' ? body.verification : '',
        open_issues: typeof body.open_issues === 'string' ? body.open_issues : ''
      })
    }
    if (action === 'review') {
      if (typeof body.child_task_id !== 'string') throw new Error('review 需要子任务 ID')
      if (body.decision !== 'accept' && body.decision !== 'reject') throw new Error('review 需要 accept 或 reject')
      await this.review(taskId, workspaceKey, actor, body.child_task_id, body.decision, typeof body.comment === 'string' ? body.comment : '')
      return { ok: true }
    }
    if (action === 'waive' || action === 'restart') {
      if (typeof body.child_task_id !== 'string') throw new Error(`${action} 需要子任务 ID`)
      if (action === 'waive') {
        await this.waive(taskId, workspaceKey, actor, body.child_task_id, typeof body.reason === 'string' ? body.reason : '')
      } else {
        await this.restart(taskId, workspaceKey, actor, body.child_task_id)
      }
      return { ok: true }
    }
    throw new Error('未知的派生操作')
  }

  private async permissionFor(state: TaskState) {
    const global = normalizeGlobalSettings(await this.store.readGlobalSettings())
    return derivationPermission({
      depth: state.derivation_depth ?? (state.parent_task_id ? 1 : 0),
      status: state.status,
      allowNested: global.allow_nested_derivation ?? false
    })
  }

  private assertMutable(state: TaskState): void {
    if (state.status === 'CANCELLED') throw new Error('任务已取消')
    if (state.status === 'DONE') throw new Error('任务已结束')
  }

  /** Called only under the derivation lock; the state callback checks the latest snapshot. */
  private async enterWait(taskId: string, workspaceKey: string): Promise<{ waiting: boolean; deferred: boolean }> {
    const ready = await this.childrenNeedParent(taskId, workspaceKey)
    let deferred = false
    let wake = false
    await this.store.updateTaskState(taskId, workspaceKey, current => {
      this.assertMutable(current)
      if (current.status === 'AWAITING_ACCEPTANCE') throw new Error('任务正在等待验收，不能等待子任务')
      if (current.status === 'PAUSED' && current.pause_cause === 'user') throw new Error('任务已由用户暂停')
      if (!(current.child_task_ids ?? []).length) throw new Error('当前任务还没有子任务，不能等待')
      if (current.active_run) {
        deferred = true
        return { ...current, derivation_hold: 'children', updated_at: utcNow() }
      }
      wake = ready || Boolean(current.derivation_wake_pending)
      return {
        ...current, status: wake ? 'READY' : 'WAITING_CHILDREN',
        derivation_hold: null, derivation_wake_pending: null, countdown: null, updated_at: utcNow()
      }
    })
    if (deferred) return { waiting: false, deferred: true }
    if (wake) {
      void this.hooks.startTask(taskId, workspaceKey).catch(() => {})
    } else {
      await this.note(taskId, workspaceKey, 'derivation.waiting', '父任务开始等待子任务，不再占用执行名额。', {})
    }
    this.hooks.terminal(workspaceKey)
    return { waiting: !wake, deferred: false }
  }

  private async kickAll(taskIds: string[], workspaceKey: string): Promise<void> {
    const runs = taskIds.map(taskId => {
      let failure: unknown
      const promise = this.hooks.startTask(taskId, workspaceKey).then(
        () => undefined,
        error => { failure = error }
      )
      return { taskId, promise, failed: () => failure }
    })
    await Promise.all(runs.map(async run => {
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        if (run.failed()) throw run.failed()
        const state = await this.store.readTaskState(run.taskId, workspaceKey).catch(() => null)
        if (state && (state.status.startsWith('RUNNING') || state.status === 'PINGING' || state.status === 'FAILED' || state.status === 'PAUSED' || state.status === 'COUNTDOWN')) {
          return
        }
        await delay(15)
      }
      throw new Error(`子任务 ${run.taskId} 没有真正启动`)
    }))
  }

  private async kickUnblocked(workspaceKey: string, finishedId: string): Promise<void> {
    const tasks = await this.store.getTasks()
    const ready: string[] = []
    for (const task of tasks) {
      if (task.workspace_key !== workspaceKey) continue
      const state = await this.store.readTaskState(task.task_id, workspaceKey).catch(() => null)
      if (!state?.dependency_blocked) continue
      const deps = state.depends_on_task_ids ?? []
      if (!deps.includes(finishedId)) continue
      const statuses = await Promise.all(deps.map(async id => {
        const dep = await this.store.readTaskState(id, workspaceKey).catch(() => null)
        return dep?.status
      }))
      if (statuses.some(status => status !== 'DONE')) continue
      await this.store.updateTaskState(task.task_id, workspaceKey, current => ({
        ...current,
        dependency_blocked: false,
        status: current.execution_mode === 'queued' ? 'QUEUED' : 'READY',
        updated_at: utcNow()
      }))
      if ((state.execution_mode ?? 'immediate') !== 'queued') ready.push(task.task_id)
    }
    if (ready.length) await this.kickAll(ready, workspaceKey)
  }

  private async readChildRecord(
    taskId: string,
    workspaceKey: string
  ): Promise<{ kind: 'missing' } | { kind: 'unreadable' } | { kind: 'present'; state: TaskState }> {
    try {
      return { kind: 'present', state: await this.store.readTaskState(taskId, workspaceKey) }
    } catch (error) {
      if (isEnoent(error)) return { kind: 'missing' }
      return { kind: 'unreadable' }
    }
  }

  /**
   * 复活被创建回滚取消的子任务：回调内复核最新快照，仍在 CANCELLED + creation_rollback
   * 才按子任务自己的执行模式复活——queued（或有依赖）回 QUEUED + queue.state=waiting，
   * 交给排队协调器按顺序拉起；immediate 回 READY 并立即 kickAll。
   * 用户取消、或状态已被并发改动的子任务不在本方法职责内：调用方已先行校验。
   * 只在派生锁内调用；这里不拿任何子任务自己的派生锁，也不会重入状态锁以外的公共写方法。
   */
  private async reviveRolledBackChildren(
    childIds: string[],
    parentId: string,
    workspaceKey: string,
    parentState: Pick<TaskState, 'execution_mode'>
  ): Promise<void> {
    const revived: string[] = []
    for (const childId of childIds) {
      const child = await this.store.readTaskState(childId, workspaceKey).catch(() => null)
      if (!child || child.status !== 'CANCELLED' || child.cancel_cause !== 'creation_rollback') continue
      let restored = false
      let queuedRevive = false
      await this.store.updateTaskState(childId, workspaceKey, current => {
        if (current.status !== 'CANCELLED' || current.cancel_cause !== 'creation_rollback') return current
        restored = true
        // 复活目标按子任务自己的执行模式选：排队任务回 QUEUED（协调器只挑
        // QUEUED + queue.state=waiting 的任务），立即任务回 READY 由 kickAll 启动。
        // 有依赖的两种模式都先回 QUEUED，等依赖完成后由 kickUnblocked 按模式分流。
        // queue 记录在取消时可能被弄丢，复活时补回 waiting，否则协调器永远挑不到它。
        if ((current.execution_mode ?? 'immediate') === 'queued' || current.dependency_blocked) {
          queuedRevive = true
          return {
            ...current,
            status: 'QUEUED',
            queue: { ...(current.queue ?? { state: 'waiting' as const, enqueued_at: utcNow() }), state: 'waiting' },
            cancel_cause: null,
            active_run: null,
            countdown: null,
            pause_cause: null,
            pause_resume_status: undefined,
            updated_at: utcNow()
          }
        }
        return {
          ...current,
          status: 'READY',
          cancel_cause: null,
          active_run: null,
          countdown: null,
          pause_cause: null,
          pause_resume_status: undefined,
          updated_at: utcNow()
        }
      })
      if (!restored) {
        // 并发改动赢了对账：不算错误，但要让调用方知道没有复活成功。
        throw new Error(`子任务 ${childId} 的状态在复活前发生了变化，请重试创建`)
      }
      await this.note(childId, workspaceKey, 'derivation.revived', `父任务重试创建，恢复了创建中途被回滚的子任务。`, {})
      if (!queuedRevive) revived.push(childId)
    }
    // 排队复活的子任务交给协调器：terminal() 触发一次对账，协调器按队列顺序
    // 挑 QUEUED + waiting 的任务启动，不会插队。立即复活的走 kickAll。
    if (revived.length === 0) {
      if (childIds.length > 0 && await this.anyRevivedQueued(childIds, workspaceKey)) this.hooks.terminal(workspaceKey)
      return
    }
    if ((parentState.execution_mode ?? 'immediate') === 'queued') {
      this.hooks.terminal(workspaceKey)
      return
    }
    const ready: string[] = []
    for (const childId of revived) {
      const child = await this.store.readTaskState(childId, workspaceKey).catch(() => null)
      if (child && !child.dependency_blocked && child.status !== 'DONE' && child.status !== 'CANCELLED' && !child.status.startsWith('RUNNING')) {
        ready.push(childId)
      }
    }
    if (ready.length > 0) await this.kickAll(ready, workspaceKey)
  }

  /** 复活后是否有任务进了排队队列需要协调器对账。 */
  private async anyRevivedQueued(childIds: string[], workspaceKey: string): Promise<boolean> {
    for (const childId of childIds) {
      const child = await this.store.readTaskState(childId, workspaceKey).catch(() => null)
      if (child?.status === 'QUEUED' && child.queue?.state === 'waiting') return true
    }
    return false
  }

  /**
   * 只有「没有任务记录、工作区干净、提交就是父任务 HEAD」的目录才能回收。
   * 状态损坏、未提交文件、或另有提交，都保留目录。不用 --force。
   */
  private async reclaimOrphanWorktree(
    base: string,
    dir: string,
    taskId: string,
    workspaceKey: string
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const record = await this.readChildRecord(taskId, workspaceKey)
    if (record.kind === 'unreadable') {
      return { ok: false, reason: `子任务 ${taskId} 的状态无法读取，工作目录已保留：${dir}` }
    }
    if (record.kind === 'present') {
      return { ok: false, reason: `无法从父任务工作版本创建工作目录：${dir} 已有任务记录` }
    }
    const status = await runGit(dir, ['status', '--porcelain'])
    if (!status.ok) {
      return { ok: false, reason: `无法从父任务工作版本创建工作目录，也不能确认已有目录可以删除：${dir}` }
    }
    if (status.stdout.trim()) {
      return { ok: false, reason: `已有工作目录里还有未提交的内容，不能删除：${dir}：${status.stdout.trim().slice(0, 300)}` }
    }
    const baseHead = await runGit(base, ['rev-parse', 'HEAD'])
    const dirHead = await runGit(dir, ['rev-parse', 'HEAD'])
    if (!baseHead.ok || !dirHead.ok || baseHead.stdout !== dirHead.stdout) {
      return { ok: false, reason: `已有工作目录的提交和父任务不一致，目录已保留：${dir}` }
    }
    const removed = await runGit(base, ['worktree', 'remove', dir])
    if (!removed.ok) {
      return { ok: false, reason: `无法回收已有工作目录，目录已保留：${dir}：${removed.stderr || removed.stdout}` }
    }
    return { ok: true }
  }

  private async allocateWorkDir(
    parent: { repo_root?: string; work_dir?: string },
    workspaceKey: string,
    taskId: string
  ): Promise<string> {
    const dir = join(this.store.dataRoot, 'runtime', 'worktrees', workspaceKey, taskId)
    await mkdir(join(this.store.dataRoot, 'runtime', 'worktrees', workspaceKey), { recursive: true })
    const base = await this.gitWorkBase(parent.work_dir) ?? await this.gitWorkBase(parent.repo_root)
    if (base) {
      const dirty = await this.dirtyWorktree(base)
      if (dirty) {
        throw new Error(`父任务工作区还有未提交的改动，不能从这里派生：${dirty.slice(0, 300)}`)
      }
      let added = await runGit(base, ['worktree', 'add', '--detach', dir, 'HEAD'])
      const occupied = `${added.stderr}\n${added.stdout}`
      if (!added.ok && /already exists|already used|file exists/i.test(occupied)) {
        const reclaimed = await this.reclaimOrphanWorktree(base, dir, taskId, workspaceKey)
        if (!reclaimed.ok) throw new Error(reclaimed.reason)
        added = await runGit(base, ['worktree', 'add', '--detach', dir, 'HEAD'])
      }
      if (!added.ok) {
        throw new Error(`无法从父任务工作版本创建工作目录：${added.stderr || added.stdout || 'git worktree add 失败'}`)
      }
      return dir
    }
    await mkdir(dir, { recursive: true })
    return dir
  }

  private async gitWorkBase(path?: string): Promise<string | null> {
    if (!path) return null
    const git = await runGit(path, ['rev-parse', '--is-inside-work-tree'])
    return git.ok && git.stdout === 'true' ? path : null
  }

  private async unfinishedDescendants(taskId: string, workspaceKey: string, seen = new Set<string>()): Promise<string[]> {
    const state = await this.store.readTaskState(taskId, workspaceKey).catch(() => null)
    if (!state) return [taskId]
    const blocked: string[] = []
    for (const childId of state.child_task_ids ?? []) {
      if (seen.has(childId)) continue
      seen.add(childId)
      const child = await this.store.readTaskState(childId, workspaceKey).catch(() => null)
      if (!child || blocksParentCompletion({ status: child.status, waived: Boolean(child.waiver) })) {
        blocked.push(childId)
        continue
      }
      blocked.push(...await this.unfinishedDescendants(childId, workspaceKey, seen))
    }
    return blocked
  }

  private async cancelFreshChildren(childIds: string[], workspaceKey: string): Promise<void> {
    for (const childId of childIds) {
      await this.store.updateTaskState(childId, workspaceKey, current => {
        if (current.status === 'DONE' || current.status === 'CANCELLED') return current
        return {
          ...current,
          status: 'CANCELLED',
          // 标明这是创建中途父任务停止时的系统回滚，不是用户取消。
          // 父任务恢复后重试 create 时，这类子任务可以复活；用户取消的不能。
          cancel_cause: 'creation_rollback',
          active_run: null,
          countdown: null,
          updated_at: utcNow()
        }
      }).catch(() => undefined)
    }
  }

  private async headVersion(workDir?: string): Promise<string | null> {
    if (!workDir) return null
    const result = await runGit(workDir, ['rev-parse', 'HEAD'])
    return result.ok && result.stdout ? result.stdout : null
  }

  /** 只看子任务自己的工作目录。未跟踪文件也算脏。不是 git 仓库时不拦截。 */
  private async dirtyWorktree(workDir?: string): Promise<string | null> {
    if (!workDir) return null
    const result = await runGit(workDir, ['status', '--porcelain'])
    if (!result.ok) return null
    const text = result.stdout.trim()
    return text || null
  }

  private async note(taskId: string, workspaceKey: string, type: string, message: string, payload: Record<string, unknown>): Promise<void> {
    const event = await this.store.appendTaskEvent(taskId, workspaceKey, { type, payload: { message, ...payload } })
    await this.store.appendTranscript(taskId, workspaceKey, 'system', message, { kind: type })
    this.hooks.events?.publish({ workspace_key: workspaceKey, task_id: taskId, event })
  }

  private clientFile(): Promise<string> {
    if (!this.clientPath) {
      this.clientPath = (async () => {
        const digest = createHash('sha256').update(clientSource).digest('hex').slice(0, 16)
        const path = join(this.store.dataRoot, 'runtime', 'derivation', `client-${digest}.cjs`)
        await mkdir(join(this.store.dataRoot, 'runtime', 'derivation'), { recursive: true })
        await writeFile(path, clientSource, { mode: 0o600 })
        return path
      })()
    }
    return this.clientPath
  }

  private lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    this.tails.set(key, run.then(() => undefined, () => undefined))
    return run
  }
}
