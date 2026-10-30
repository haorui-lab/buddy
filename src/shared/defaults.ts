import type { AcpPreset, GlobalSettings, Launcher } from './types'

export const DEFAULT_LAUNCHER_ORDER = [
  'claude',
  'codex',
  'cursor',
  'agy',
  'opencode',
  'kimi',
  'wecode_claude',
  'wecode_codex',
  'wecode_opencode'
] as const

export const DEFAULT_LAUNCHER_TIMEOUT_SECONDS = 7200

export const KNOWN_ACP_PRESETS: AcpPreset[] = [
  {
    id: 'opencode-acp',
    name: 'OpenCode ACP',
    actor: 'opencode',
    command: 'opencode',
    args: ['acp'],
    description: 'OpenCode CLI with native ACP server'
  },
  {
    id: 'wecode-opencode-acp',
    name: 'WeCode OpenCode ACP',
    actor: 'wecode_opencode',
    command: 'wecode',
    args: ['opencode', 'acp'],
    description: 'WeCode OpenCode native ACP server'
  },
  {
    id: 'codex-acp',
    name: 'Codex ACP',
    actor: 'codex',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp'],
    description: 'Codex ACP adapter'
  },
  {
    id: 'claude-acp',
    name: 'Claude ACP',
    actor: 'claude',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    description: 'Claude Agent ACP adapter'
  },
  {
    id: 'cursor-acp',
    name: 'Cursor ACP',
    actor: 'cursor',
    command: 'cursor-agent',
    args: ['acp'],
    description: 'Cursor Agent native ACP mode'
  },
  {
    id: 'wecode-claude-acp',
    name: 'WeCode Claude ACP',
    actor: 'wecode_claude',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    description: 'WeCode Claude via ACP adapter'
  },
  {
    id: 'wecode-codex-acp',
    name: 'WeCode Codex ACP',
    actor: 'wecode_codex',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp'],
    description: 'WeCode Codex via ACP adapter'
  }
]

const DEFAULT_LAUNCHER_COMMANDS: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor-agent',
  agy: 'agy',
  opencode: 'opencode',
  kimi: 'kimi',
  wecode_claude: 'wecode',
  wecode_codex: 'wecode codex',
  wecode_opencode: 'wecode opencode'
}

export function defaultLauncherFor(actor: string): Launcher {
  return {
    command: DEFAULT_LAUNCHER_COMMANDS[actor] ?? actor,
    env: {},
    timeout_seconds: DEFAULT_LAUNCHER_TIMEOUT_SECONDS
  }
}

export function normalizeLauncher(actor: string, launcher?: Partial<Launcher> | null): Launcher {
  const fallback = defaultLauncherFor(actor)
  let command = typeof launcher?.command === 'string' && launcher.command.trim() !== '' ? launcher.command : fallback.command
  if (launcher?.protocol !== 'acp' && command === 'npx') {
    command = fallback.command
  }
  const result: Launcher = {
    command,
    env: launcher?.env ? { ...launcher.env } : { ...fallback.env },
    timeout_seconds:
      typeof launcher?.timeout_seconds === 'number'
        ? launcher.timeout_seconds
        : fallback.timeout_seconds
  }
  if (launcher?.protocol === 'acp') {
    result.protocol = 'acp'
    if (Array.isArray(launcher.args)) {
      result.args = [...launcher.args]
    }
  }
  const model = typeof launcher?.model === 'string' ? launcher.model.trim() : ''
  if (model) {
    result.model = model
  }
  return result
}

export function normalizeLaunchers(
  launchers?: Record<string, Partial<Launcher>> | null
): Record<string, Launcher> {
  const normalized: Record<string, Launcher> = {}

  for (const actor of DEFAULT_LAUNCHER_ORDER) {
    normalized[actor] = normalizeLauncher(actor, launchers?.[actor])
  }

  for (const [actor, launcher] of Object.entries(launchers ?? {})) {
    if (!normalized[actor]) {
      normalized[actor] = normalizeLauncher(actor, launcher)
    }
  }

  return normalized
}

export function normalizeGlobalSettings(settings?: GlobalSettings | null): GlobalSettings {
  return {
    protocol_version: settings?.protocol_version ?? '1',
    countdown_seconds: settings?.countdown_seconds ?? 30,
    max_rounds: settings?.max_rounds ?? 9999,
    max_consecutive_failures: settings?.max_consecutive_failures ?? 10,
    launchers: normalizeLaunchers(settings?.launchers),
    seed_claude_session_id: settings?.seed_claude_session_id ?? '',
    seed_codex_thread_id: settings?.seed_codex_thread_id ?? '',
    seed_cursor_session_id: settings?.seed_cursor_session_id ?? '',
    seed_agy_session_id: settings?.seed_agy_session_id ?? '',
    seed_opencode_session_id: settings?.seed_opencode_session_id ?? '',
    seed_kimi_session_id: settings?.seed_kimi_session_id ?? '',
    seed_wecode_claude_session_id: settings?.seed_wecode_claude_session_id ?? '',
    seed_wecode_codex_thread_id: settings?.seed_wecode_codex_thread_id ?? '',
    seed_wecode_opencode_session_id: settings?.seed_wecode_opencode_session_id ?? '',
    max_compact_retries: settings?.max_compact_retries ?? 3,
    auto_generate_commit_message: settings?.auto_generate_commit_message ?? true,
    system_notifications_enabled: settings?.system_notifications_enabled ?? true,
    max_upgrade_retries: settings?.max_upgrade_retries ?? 3,
    custom_prompt: settings?.custom_prompt ?? undefined,
    allow_nested_derivation: settings?.allow_nested_derivation ?? false,
    derivation_prompt: settings?.derivation_prompt?.trim() || undefined
  }
}

/** 两个 Actor 共用的默认派生提示词。权限、子任务状态和确认进度由 Buddy 另外提供。 */
export const DEFAULT_DERIVATION_PROMPT = `你正在 Buddy 中与另一位 Actor 协作完成当前任务。根据实际需要使用子任务，始终对当前任务的完整目标负责。

1. 先确认能否派生
以 Buddy 提供的当前任务派生权限为准；权限不明确时先查询。不允许时，不提出派生方案、不进入确认流程，也不尝试绕过限制。

2. 按需提出方案
只有权限允许，且工作能划分出目标清楚、可单独交付和验收的部分时，才考虑派生。子任务是父任务的一部分，默认在同一工作目录协作，已有改动彼此可见。先查看已有子任务，避免重复委派；写清各自负责的文件/模块、接口、依赖、交付物和验收条件。父任务不要同时修改已委派的范围，兄弟任务写入范围重叠时先协调或串行执行。

3. 双方确认同一方案
审阅方案后，通过 Buddy 提供的操作明确记录自己的同意或不同意及理由。当前任务的两个 Actor 必须分别同意同一版本的方案；不能代替另一方确认，也不能把沉默当作同意。方案修改后，双方需要重新确认。

4. 创建与等待
只有 Buddy 确认双方均已同意，并在创建前复核仍允许派生后，才能通过 Buddy 创建已确认的子任务。独立任务可并行，依赖未就绪的任务等待。需要等待子任务时使用 Buddy 的等待机制；不反复询问、不重复创建，也不把派生成功当作任务完成。

5. 汇报与验收
收到子任务交付后，检查共享目录当前产物和实际验证结果；交付编号记录交付轮次，不要求子任务提交 Git。Git 提交由根任务按用户要求统一安排，不为派生或交付清理、回退他人的改动。证据不足或未通过时，说明问题并退回原子任务。必要子任务未通过或整体结果尚未验证时，不宣布完成。如果当前任务有父任务，完成后 submit 记录产物、实际验证结果和遗留问题，再由双方确认完成，等待父任务验收。`
