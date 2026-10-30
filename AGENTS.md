# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project

Buddy is a macOS Electron app that orchestrates **dual-AI-agent collaborative coding**. Two AI actors (implementer + reviewer) take turns on a task, with a configurable countdown between rounds for human intervention. The loop ends when both actors confirm "break" (dual-break). Supported actors: Codex, Codex, OpenCode, Kimi.

This is a TypeScript rewrite of a Python predecessor. Data directories (`~/Library/Application Support/buddy/`) are compatible between both versions.

## Commands

```bash
pnpm dev                    # Dev mode with HMR
pnpm build                  # Compile all three targets (main/preload/renderer)
pnpm test                   # Unit tests (vitest run tests/unit)
pnpm vitest run tests/unit/main/buddy-store.test.ts  # Single test file
pnpm test:e2e               # E2E tests (Playwright)
pnpm typecheck              # tsc --noEmit
pnpm dist                   # Local-only adhoc DMG/ZIP; never upload to a GitHub Release
pnpm release:signed         # Build + Apple Development sign + verify (needs CSC_NAME; no notarization)
```

## Release policy

- `pnpm dist` and `pnpm package` are local adhoc build paths. Their artifacts must never be uploaded to a GitHub Release.
- The only official publishing entrypoint is `CSC_NAME='Apple Development: ...' scripts/release.sh vX.Y.Z`.
- Official releases intentionally use the Apple Development identity for Team ID `XLDSS978CT` without notarization.
- Before publishing, `CHANGELOG.md` must contain the Keep a Changelog entry for that version (`## [X.Y.Z] - YYYY-MM-DD` with Added/Changed/Fixed/Removed as needed). `scripts/publish-release.sh` uses that section as GitHub Release notes; placeholder notes like `Release vX.Y.Z` are a release blocker.
- The release script keeps a GitHub Release in Draft while it uploads packages, uploads `latest-mac.yml` last, downloads all five official assets again, and verifies signatures, versions, hashes, and metadata before publication.
- `Signature=adhoc`, `TeamIdentifier=not set`, `skipped macOS application code signing`, a missing asset, missing changelog notes, or a remote verification failure is a release blocker. Do not publish or declare completion.
- Reviewer completion evidence must include remote download and signature verification. Asset names, counts, and sizes alone are insufficient.

## Architecture

**Three-process Electron** (main / preload / renderer), built with electron-vite.

### Main process → Renderer communication

- **Request-response**: `ipcMain.handle('buddy:xxx')` ↔ `ipcRenderer.invoke('buddy:xxx')`. All buddy operations use `buddy:*` channel naming.
- **Push events**: Main pushes to renderer via `webContents.send('buddy:event', ...)`. The `BuddyEventBus` in main publishes; preload subscribes via `ipcRenderer.on`.

### Core: BuddyCoreService → BuddyStore + BuddyRunner + BuddyEventBus

`src/main/buddy/service.ts` composes three modules:
- **Store** (`store.ts`): Filesystem persistence. All JSON writes are atomic (write `.tmp`, then `rename`). Zod validates on read, not write, for forward compatibility.
- **Runner** (`runner.ts`): Spawns actor CLIs, manages the task state machine, parses streaming output.
- **EventBus** (`events.ts`): Pub/sub for task lifecycle events.

### Task state machine

```
READY → RUNNING_{ACTOR} → COUNTDOWN → (READY | PAUSED | DONE)
                                 ↓
                              FAILED (recoverable)
                                 ↓
                              PAUSED
```

- **COUNTDOWN**: Pause between rounds (default 30s) for human review. Renderer-side timer auto-skips when deadline elapses.
- **Dual-break**: Both actors must signal `type=break` for task to reach DONE. Tracked via `pending_break` in state.
- **Recovery**: On app restart, tasks stuck in `RUNNING_*` are reset to `PAUSED`.

### Actor launcher system (`launchers.ts`)

Detects whether a command is a "native" CLI (Codex/codex/opencode/kimi) or a generic "contract" command. Native launchers use CLI-specific flags (e.g., `Codex -p --output-format stream-json`). Contract launchers pass `BUDDY_ACTOR`, `BUDDY_MODE` env vars. Session resumption uses `--resume` (Codex), `resume` (Codex), `--session` (OpenCode/Kimi).

### Data model (filesystem, no database)

- Workspaces keyed by repo path hash
- Per-task directory: `state.json`, `settings.json`, `task.md`, `context.md`, `events.jsonl`, `transcript.jsonl`, `artifacts/`, `rounds/`
- Global settings: `dataRoot/global/settings.json`

### Renderer

- React 18 + TanStack React Query 5. Components in `src/renderer/components/`, hooks in `hooks/`.
- Preload exposes `window.api` (system ops) and `window.buddy` (all buddy operations) via contextBridge.
- 23 preset themes (CSS custom properties), i18n (zh-CN/zh-TW/en with CJK auto-detect).
- `@` alias maps to `src/renderer` (renderer only; main process uses relative paths).

### Task derivation presentation

- `derivationTimeline.ts` projects the stored transcript for display: group actor-issued derivation receipts after the actor conclusion, defer receipts from the active run, and flush on human instructions, round boundaries, pause or failure. Incoming child results and errors remain immediate. Never reorder persisted transcripts.
- `DerivationNotice` reuses the existing system notice label and theme classes. Show short localized outcomes and actor display names; preserve complete original reasons and IDs in native expandable details. Event payloads enrich legacy transcript entries that only have `meta.kind`.
- Child artifact submission emits `derivation.child_submitted` (internal review pending); only completed dual confirmation emits `derivation.child_delivered` (ready for parent acceptance). Both remain immediate incoming notices. `derivationEventType` classifies historical `child_delivered` submission messages for notification and process-event labels without rewriting stored records; preserve task links, timestamps and full details. A submitting actor's own receipt must also describe pending internal review, not parent acceptance.
- Each delivery has an optional backward-compatible `revision` submission count. Shared tasks use `delivery-N` receipt IDs in `version`; isolated tasks retain Git commit IDs. Submission and readiness receipts carry `delivery_revision` and `version`; show resubmission wording and a short version with the full value available. Infer historical revisions only from preceding submission events for the same child, and match repeated identical messages by timestamp/event sequence rather than the first content match.
- At actor completion, snapshot the actual state of children whose results arrived during that run into transcript `meta.child_updates`. Keep the actor's original words intact. `derivationTimeline` places an end-of-turn status check after the conclusion; for historical transcripts, infer the last status notification within the matching `actor.started`/`actor.completed` sequence. Never use later events or today's task status to rewrite historical results, and never infer a completed snapshot for partial/interrupted runs.
- Legacy completion-blocked round notices use the existing error notice style and a short summary with original IDs/instructions in details. `derivation.start_failed` may be emitted when a long-running `startTask` promise rejects, so label it as an execution error rather than assuming the failure happened during startup.
- `DerivationTaskBar` keeps parent/child navigation outside the scrolling transcript, scoped by workspace. Preserve live child statuses, titles, and keyboard-accessible buttons. Show a persistent completion-blocked hint only from `task.completion_blocked` evidence; remove resolved children after acceptance/waiver or DONE, and hide the hint for terminal parents.
- Relevant regression tests: `derivation-timeline.test.ts` and `derivation-notice.test.tsx`; manual checks must cover the running Electron app without restarting or cancelling active tasks.

### Derivation reliability and ACP failures

- New children default to `workspace_mode=shared`: the parent task's current `work_dir` (or `repo_root`) is authoritative, and siblings/grandchildren share it. Existing dirty/staged/untracked files are visible immediately; creation performs no Git operations and allocates no worktree. The confirmed scope must name files/modules and interfaces, parents must avoid delegated writes, and overlapping sibling work must be coordinated or sequenced through dependencies. Shared delivery creates a task-local `delivery-N` receipt and acceptance reviews current shared code/tests; neither step requires Git commits or a clean repository. Git operations are coordinated by the root task under the user's policy. Explicitly changing an existing child's workspace mode must fail rather than silently reuse or move it. Cancel/delete/rollback only changes task records and task-owned services, never shared source files. Targeted regressions: `buddy-derivation-shared`.
- Isolation is opt-in via proposal `workspace_mode=isolated`, participates in the proposal hash and must be agreed by both actors. Children without the new state field are legacy isolated tasks and keep their old directories/validation; they are never silently moved. For isolated Git deliveries only, `submit` automatically reads the full HEAD and enforces clean worktree/version consistency at submission, completion and acceptance. Non-Git isolated tasks retain the old version/unversioned contract. All new submissions clear stale acceptance and pending break agreement. Targeted regressions: `buddy-derivation-delivery` and explicit isolated fixtures in `buddy-derivation-regressions`.
- `wait` inside an active actor turn only records a deferred hold. Its `next_action=finish_turn` and message must instruct the actor to return a final `type=chat` immediately, without sleeping or polling. These protocol instructions also apply with a saved custom derivation prompt. A later `status` repeats the finish-turn instruction while the hold is active; actual wait/wake transitions remain owned by the runner after turn completion.
- Derivation `status` preserves the legacy `children` ID list and current-task `delivery`/`acceptance`/`work_dir`; use `child_details` for each child's status, worktree, delivery and acceptance. Child artifact paths are relative to that child's `work_dir`. Prompts and status share the same child reader; missing/corrupt children report `unreadable=true` with `status=null`, never an invented persisted status. Regression coverage in `buddy-derivation-reliability` includes the real CLI/socket boundary and delivery both before and after the waiting turn ends.
- All state read/modify/write entry points in `BuddyStore` share a per-task lock, including event/transcript appends and instruction draining. Lock order is derivation lock, then state lock; state callbacks must not reenter either layer. `writeTaskState` is an unlocked primitive used only by those entry points.
- Recheck current status/active run inside state callbacks for wait, wake, completion and failure. Automatic starts require READY; PAUSED tasks need explicit resume. Double-break with unfinished required children pauses the parent and releases its execution slot, never starts an empty approval loop or bypasses acceptance.
- Missing/corrupt child state requires parent attention and blocks completion/acceptance. Render it as corruption in prompts without persisting a fake task status. New submissions clear stale acceptance and cannot change DONE/CANCELLED tasks.
- Parent pause preserves FAILED children. Startup/resume repairs legacy cascade-paused FAILED children without executing them. Actor-requested child restarts preserve consecutive failures and respect the configured ceiling; a successful actor turn clears the failure count.
- ACP advertises host filesystem/terminal capabilities as false until those RPCs are implemented. Merge `tool_call_update` inputs by ID, recognize `failed` results, and ignore updates from other sessions. These are observation updates, not instructions to execute tools again.
- Persist established ACP sessions before prompting; keep partial output and ordered event artifacts on failure. Failed turns appear as interrupted/unfinished with inspectable round details. Empty initial tool inputs are not proof of execution failure: inspect refinements/results or the original provider session before diagnosing the provider.
- Targeted regressions: `buddy-store-concurrency`, `buddy-derivation-reliability`, `buddy-acp`, `buddy-runner-acp`, `buddy-recovery`. `RUN_LIVE_ACP=1 pnpm vitest run tests/live/acp-runtime-smoke.test.ts` performs real tools in a temporary fixture; it does not prove a provider will never drop a long request.

## Conventions

- **Icons**: Use lucide-react. Do not introduce other icon libraries or custom SVGs.
- **Atomic writes**: Always write JSON via `.tmp` → `rename`, never direct write.
- **Zod schemas**: Define in `src/main/buddy/schemas.ts`. Validate on read, not write.
- **Sensitive data**: API keys are automatically redacted from event logs by `redact.ts`.
- **i18n**: UI text goes through `useI18n` hook. Prompt builder detects human language and instructs actors to reply in the same language.
