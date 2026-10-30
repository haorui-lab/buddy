export interface Task {
  task_id: string
  workspace_key: string
  task_dir: string
  status: TaskStatus
  updated_at: string
  repo_root: string
  round?: number
  active_run?: ActiveRun | null
  execution_mode?: ExecutionMode
  queue?: TaskQueueInfo
  created_at?: string
  parent_task_id?: string | null
  root_task_id?: string | null
  derivation_depth?: number
  title?: string
}

export type TaskStatus =
  | 'QUEUED'
  | 'READY'
  | 'RUNNING_CLAUDE'
  | 'RUNNING_CODEX'
  | 'RUNNING_CURSOR'
  | 'RUNNING_AGY'
  | 'RUNNING_OPENCODE'
  | 'RUNNING_KIMI'
  | 'RUNNING_WECODE_CLAUDE'
  | 'RUNNING_WECODE_CODEX'
  | 'RUNNING_WECODE_OPENCODE'
  | 'PINGING'
  | 'COUNTDOWN'
  | 'PAUSED'
  | 'FAILED'
  | 'DONE'
  | 'CANCELLED'
  | 'WAITING_CHILDREN'
  | 'AWAITING_ACCEPTANCE'

/** Per-project FIFO queue metadata attached to queued-execution tasks. */
export interface TaskQueueInfo {
  state: 'waiting' | 'active' | 'superseded'
  enqueued_at: string
  activated_at?: string
  activation_source?: 'automatic' | 'manual'
}

export type ExecutionMode = 'immediate' | 'queued'

export interface TaskDetail {
  task_id: string
  workspace_key: string
  state: TaskState
  settings: TaskSettings
  task_text: string
  context_text: string
  transcript: TranscriptEntry[]
  events: Event[]
  latest_failure: Failure | null
}

export interface InstructionQueueItem {
  id: string
  content: string
  created_at: string
  attachments?: AttachmentMeta[]
}

export interface HealthCheckResult {
  actors: Record<string, 'pending' | 'running' | 'passed' | 'failed'>
  failed_actor?: string
  failed_reason?: string
}

export interface TaskState {
  protocol_version?: string
  task_id?: string
  repo_root?: string
  status: TaskStatus
  round: number
  rounds_in_window?: number
  next_actor: string
  countdown?: Countdown | null
  active_run?: ActiveRun | null
  instruction_queue?: InstructionQueueItem[]
  actor_sessions?: Record<string, string>
  claude_session_id?: string | null
  codex_thread_id?: string | null
  cursor_session_id?: string | null
  agy_session_id?: string | null
  opencode_session_id?: string | null
  kimi_session_id?: string | null
  wecode_claude_session_id?: string | null
  wecode_codex_thread_id?: string | null
  wecode_opencode_session_id?: string | null
  context_hash?: string
  context_sent?: Record<string, boolean>
  event_seq?: number
  transcript_seq?: number
  consecutive_failures?: number
  last_error?: Failure | null
  created_at?: string
  updated_at?: string
  pending_break?: { actor?: string; round?: number } | null
  break_rejected_by?: { actor?: string; round?: number } | null
  latest_failure?: Failure | null
  health_check?: HealthCheckResult | null
  compact_retries?: number
  execution_mode?: ExecutionMode
  queue?: TaskQueueInfo
  service_cleanup_pending?: boolean
  parent_task_id?: string | null
  root_task_id?: string | null
  derivation_depth?: number
  child_task_ids?: string[]
  title?: string
  work_dir?: string
  workspace_mode?: 'shared' | 'isolated'
  spec_key?: string
  depends_on_task_ids?: string[]
  dependency_blocked?: boolean
  pause_cause?: 'user' | 'cascade' | null
  pause_resume_status?: TaskStatus
  /** 只在 status=CANCELLED 时有意义：creation_rollback 是创建中途父任务停止时的系统回滚，重试 create 时可复活；user 是用户主动取消，不能被悄悄拉起。 */
  cancel_cause?: 'user' | 'creation_rollback' | null
  derivation_hold?: 'children' | null
  derivation_wake_pending?: boolean | null
  derivation_proposal?: DerivationProposal | null
  delivery?: TaskDelivery | null
  acceptance?: TaskAcceptance | null
  waiver?: TaskWaiver | null
}

export interface DerivationSpec {
  /** Defaults to shared for new children. Isolation must be explicitly agreed in the proposal. */
  workspace_mode?: 'shared' | 'isolated'
  key: string
  title: string
  goal: string
  scope: string
  context: string
  dependencies: string[]
  deliverables: string
  acceptance: string
}

export interface DerivationDecision {
  actor: string
  decision: 'agree' | 'disagree'
  reason: string
  proposal_hash: string
  at: string
}

export interface DerivationProposal {
  proposal_id: string
  proposal_hash: string
  specs: DerivationSpec[]
  proposed_by: string
  proposed_at: string
  decisions: DerivationDecision[]
  created_task_ids: string[]
  status: 'open' | 'created' | 'rejected'
}

export interface TaskDelivery {
  version: string
  /** Submission count, independent of Git. Shared tasks use delivery-N receipt IDs. */
  revision?: number
  artifacts: string
  verification: string
  open_issues: string
  submitted_at: string
  submitted_by: string
}

export interface TaskAcceptance {
  decision: 'accept' | 'reject'
  comment: string
  at: string
  actor: string
  version?: string
}

/** 父任务明确放弃一个已取消子任务后，该子任务不再挡住父任务结束。 */
export interface TaskWaiver {
  actor: string
  reason: string
  at: string
}

export interface Countdown {
  status: 'running' | 'paused' | 'elapsed' | 'skipped' | 'expired'
  remaining?: number
  started_at?: string
  after_actor?: string
  default_next_actor: string
  deadline?: string
}

export interface ActiveRun {
  run_id?: string
  actor: string
  started_at: string
  status?: 'running'
  session_id_before?: string | null
  session_id_after?: string | null
}

export interface TaskSettings {
  protocol_version: string
  flow_policy: string
  role_mode: string
  launchers: Record<string, Launcher>
  implementer_actor?: string
  reviewer_actor?: string
  max_consecutive_failures?: number
  seed_claude_session_id?: string
  seed_codex_thread_id?: string
  seed_cursor_session_id?: string
  seed_agy_session_id?: string
  seed_opencode_session_id?: string
  seed_kimi_session_id?: string
  seed_wecode_claude_session_id?: string
  seed_wecode_codex_thread_id?: string
  seed_wecode_opencode_session_id?: string
}

export interface Launcher {
  protocol?: 'acp' | 'cli'
  command: string
  args?: string[]
  env: Record<string, string>
  timeout_seconds: number
  /** Per-task ACP model id selected in the create-task modal or composer. */
  model?: string
}

export interface AcpModelInfo {
  id: string
  name: string
}

export interface AcpModelList {
  models: AcpModelInfo[]
  currentModelId?: string
}

export interface AcpPreset {
  id: string
  name: string
  actor: string
  command: string
  args: string[]
  description: string
}

export interface TranscriptEntry {
  role: 'human' | 'claude' | 'codex' | 'cursor' | 'agy' | 'opencode' | 'kimi' | 'wecode_claude' | 'wecode_codex' | 'wecode_opencode' | 'system'
  content: string
  ts: string
  round?: number
  meta?: Record<string, unknown>
}

export interface Event {
  seq: number
  task_id?: string
  type: string
  actor?: string
  ts: string
  run_id?: string
  payload: Record<string, unknown>
}

export interface Failure {
  message: string
  actor?: string
  run_id?: string
  ts?: string
  output_file?: string
  event_file?: string
}

export interface HealthResponse {
  app: string
  version: string
  pid: number
  host: string
  port: number
}

export interface BootstrapResponse {
  version?: string
  repo_root: string
  data_root: string
  home_dir: string
  locale?: string
  workspace_key?: string
  tasks: Task[]
  global_settings?: GlobalSettings
}

export interface GlobalSettings {
  protocol_version?: string
  countdown_seconds?: number
  max_rounds?: number
  max_consecutive_failures?: number
  launchers?: Record<string, Launcher>
  seed_claude_session_id?: string
  seed_codex_thread_id?: string
  seed_cursor_session_id?: string
  seed_agy_session_id?: string
  seed_opencode_session_id?: string
  seed_kimi_session_id?: string
  seed_wecode_claude_session_id?: string
  seed_wecode_codex_thread_id?: string
  seed_wecode_opencode_session_id?: string
  max_compact_retries?: number
  auto_generate_commit_message?: boolean
  system_notifications_enabled?: boolean
  max_upgrade_retries?: number
  custom_prompt?: string
  /** 关闭时只允许根任务派生子任务；开启后子任务可以继续向下派生。 */
  allow_nested_derivation?: boolean
  /** 未设置时使用内置默认派生提示词。 */
  derivation_prompt?: string
}

export interface BuddyError {
  code: string
  message: string
  details?: unknown
  recoverable?: boolean
}

export interface TestLauncherResult {
  actor: string
  success: boolean
  phase: 'tool_check' | 'ping'
  error?: string
  sessionId?: string
  threadId?: string
  responsePreview?: string
  runId?: string
  durationMs?: number
  timedOut?: boolean
  exitCode?: number | null
  signal?: string | null
}

export interface GlobalAcpAdapterItem {
  installed: boolean
  binaryPath: string | null
  installCommand: string
}

export interface GlobalAcpAdaptersStatus {
  claude: GlobalAcpAdapterItem
  codex: GlobalAcpAdapterItem
}

export interface TaskEventEnvelope {
  workspace_key: string
  task_id: string
  event: Event
}

export interface CreateTaskInput {
  task_id: string
  repo_root?: string
  task_text?: string
  context_text?: string
  settings?: Record<string, unknown>
  execution_mode?: ExecutionMode
  workspace_key?: string
  parent_task_id?: string
  root_task_id?: string
  derivation_depth?: number
  title?: string
  work_dir?: string
  workspace_mode?: 'shared' | 'isolated'
  spec_key?: string
  depends_on_task_ids?: string[]
  dependency_blocked?: boolean
}

export interface CreateTaskResult {
  task: string
  path: string
  workspace_key: string
}

export interface StartTaskInput {
  actor?: string
  message?: string
  workspace_key?: string
}

export interface Attachment {
  id: string
  name: string
  category: 'image' | 'file'
  mimeType: string
  size: number
  previewUrl?: string
  bufferBase64?: string
  filePath?: string
}

export interface AttachmentMeta {
  path: string
  name: string
  mimeType: string
  size: number
}

export interface SendMessageInput {
  actor?: string
  message?: string
  workspace_key?: string
  attachments?: Attachment[]
  attachmentMeta?: AttachmentMeta[]
}

export interface CountdownInput {
  next_actor?: string
  workspace_key?: string
}

export interface RoundEventEntry {
  type: 'thinking' | 'text' | 'tool_use' | 'tool_result' | 'result'
  thinkingLength?: number
  text?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResultPreview?: string
  isError?: boolean
  durationMs?: number
  costUsd?: number
  model?: string
}

export interface RoundEventSummary {
  runId: string
  events: RoundEventEntry[]
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  durationMs?: number
  costUsd?: number
  model?: string
}

export interface TaskActorStats {
  actor: string
  model?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  durationMs: number
  costUsd?: number
  rounds: number
}

export interface TaskStats {
  actors: TaskActorStats[]
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalDurationMs: number
  totalCostUsd?: number
  totalRounds: number
}

export type GitFileStatusCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?'

export interface GitFileStatus {
  path: string
  status: GitFileStatusCode
  insertions: number
  deletions: number
}

export interface GitDiffStats {
  filesChanged: number
  insertions: number
  deletions: number
  summary: string
  files?: GitFileStatus[]
}

export interface GitRemote {
  name: string
  url: string
}

/** 当前本地分支的默认跟踪目标 (remote + 目标分支), 不含 refs/heads/ 前缀。 */
export interface GitUpstream {
  remote: string
  branch: string
}

export interface GitStatusResult {
  branch: string
  diff: GitDiffStats | null
  staged: GitDiffStats | null
  untracked: number
  files: GitFileStatus[]
  remotes: GitRemote[]
  /** 当前分支的 Git upstream; 无当前分支、分离 HEAD 或未配置时为 null。 */
  upstream: GitUpstream | null
}

export type GitPushStatus = 'not_requested' | 'pushed' | 'failed'

export interface GitCommitPushResult {
  commitHash: string
  pushStatus: GitPushStatus
  remote: string | null
  upstreamCreated: boolean
  pushError: string | null
}

/**
 * 独立“推送已有提交”入口的远端可推性状态。
 * - ahead: 本地领先, 远端未领先
 * - up_to_date: 本地与远端同步
 * - behind: 仅落后
 * - diverged: 双方都有各自提交
 * - new_branch: 远端尚无目标分支, 首次推送
 * - unavailable: 无有效 HEAD / 分离 HEAD 等不可推送情形
 *
 * 注意: fetch 本身失败不映射为某个 state, 而是让查询抛错,
 * 由调用方呈现“检查远端状态失败”而非伪装成可推送或已同步。
 */
export type GitPushAvailabilityState =
  | 'ahead'
  | 'up_to_date'
  | 'behind'
  | 'diverged'
  | 'new_branch'
  | 'unavailable'

/** 一条尚未推送的本地提交: 7 位短 SHA 与完整标题 (subject)。 */
export interface GitPendingCommit {
  hash: string
  subject: string
}

export interface GitPushAvailability {
  state: GitPushAvailabilityState
  remote: string
  branch: string
  ahead: number
  behind: number
  /**
   * 仅 ahead 时为 `<remote-ref>..HEAD` 范围内、从旧到新的本地独有提交;
   * 其余状态 (含 new_branch/同步/落后/分叉/不可用) 一律为 []。
   * 解析失败时让 getGitPushAvailability() 抛错, 不返回部分列表。
   */
  pendingCommits: GitPendingCommit[]
  /** 本次推送是否会在成功后建立 upstream (仅无 upstream 的非分离 HEAD 首次推送为 true)。 */
  upstreamCreatedOnPush: boolean
}

/** 独立推送结果: 只推当前 HEAD, 不产生新提交、不改动工作区。 */
export interface GitPushResult {
  pushStatus: 'pushed' | 'failed'
  remote: string
  upstreamCreated: boolean
  pushError: string | null
}
