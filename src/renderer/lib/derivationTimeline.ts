import type { Event, TaskState, TranscriptEntry } from '../../shared/types'
import { derivationEventDetails, derivationEventType } from './format'

export type TimelineItem = { key: number; entries: TranscriptEntry[]; derivation: boolean }

export function isDerivationNotice(entry: TranscriptEntry): boolean {
  return entry.role === 'system' && typeof entry.meta?.kind === 'string' && entry.meta.kind.startsWith('derivation.')
}

// Only operations performed by this task's actor wait for its conclusion.
// Child results and errors remain at their original position and surface immediately.
const deferredKinds = new Set([
  'derivation.proposed', 'derivation.decided', 'derivation.created',
  'derivation.submitted'
])

function waitsForConclusion(entry: TranscriptEntry): boolean {
  const kind = String(entry.meta?.kind)
  return deferredKinds.has(kind)
    || (kind === 'derivation.reviewed' && entry.content.startsWith('子任务 '))
    || (kind === 'derivation.waived' && entry.content.startsWith('已解除子任务 '))
    || (kind === 'derivation.restarted' && entry.content.startsWith('重新启动子任务 '))
}

function historicalUpdates(events: Event[]): Map<string, Record<string, unknown>[]> {
  const details = derivationEventDetails(events)
  const result = new Map<string, Record<string, unknown>[]>()
  let active = ''
  const pending = new Map<string, Record<string, unknown>>()
  for (const event of events) {
    const runId = String(event.run_id ?? event.payload.run_id ?? '')
    if (event.type === 'actor.started') {
      active = runId
      pending.clear()
    } else if (event.type === 'actor.completed' && active && runId === active) {
      result.set(active, [...pending.values()])
      active = ''
      pending.clear()
    } else if (['actor.interrupted', 'actor.failed'].includes(event.type)) {
      active = ''
      pending.clear()
    } else if (active && typeof event.payload.child_task_id === 'string') {
      const kind = derivationEventType(event.type, event.payload.message)
      const childId = event.payload.child_task_id
      const payload = details.get(event.seq) ?? event.payload
      if (['derivation.child_submitted', 'derivation.child_delivered', 'derivation.child_failed'].includes(kind)) {
        if (payload.child_status !== undefined) pending.set(childId, payload)
        else pending.delete(childId)
      } else if (kind === 'derivation.reviewed' && pending.has(childId)) {
        pending.set(childId, { ...pending.get(childId), child_status: payload.decision === 'accept' ? 'DONE' : 'READY' })
      }
    }
  }
  return result
}

export function derivationTimeline(transcript: TranscriptEntry[], state: Pick<TaskState, 'active_run' | 'status'>, events: Event[] = []): TimelineItem[] {
  const updatesByRun = historicalUpdates(events)
  const items: TimelineItem[] = []
  let pending: TimelineItem | undefined
  const flush = () => {
    if (pending) items.push(pending)
    pending = undefined
  }
  transcript.forEach((entry, index) => {
    if (isDerivationNotice(entry) && waitsForConclusion(entry)) {
      if (!pending) pending = { key: index, entries: [], derivation: true }
      pending.entries.push(entry)
    } else if (entry.role !== 'system' && entry.role !== 'human') {
      items.push({ key: index, entries: [entry], derivation: false })
      flush()
      const savedSnapshot = Array.isArray(entry.meta?.child_updates)
      const updates: unknown[] = savedSnapshot ? entry.meta!.child_updates as unknown[]
        : updatesByRun.get(String(entry.meta?.run_id)) ?? []
      if (entry.meta?.partial !== true && updates.length) {
        const entries = updates.flatMap(update => {
          if (!update || typeof update !== 'object') return []
          const payload = update as Record<string, unknown>
          if (typeof payload.child_task_id !== 'string') return []
          return [{
            role: 'system' as const, ts: entry.ts,
            content: `本轮结束时复核：子任务 ${payload.title || payload.child_task_id} 状态 ${payload.child_status ?? '无法读取'}；交付版本 ${payload.version ?? '无'}。`,
            meta: { ...payload, kind: 'derivation.child_status_refreshed', source_run_id: entry.meta?.run_id, inferred: !savedSnapshot }
          }]
        })
        if (entries.length) items.push({ key: -index - 1, entries, derivation: true })
      }
    } else {
      // Do not move notices across a human instruction, failure, or round boundary.
      flush()
      items.push({ key: index, entries: [entry], derivation: isDerivationNotice(entry) })
    }
  })
  const running = state.status.startsWith('RUNNING_') && state.active_run
  const inCurrentRun = running && pending?.entries.every(entry => entry.ts >= running.started_at)
  // The actor is still speaking. Keep its receipts out of the completed timeline.
  // On failure/pause the pending receipts become visible even without a conclusion.
  if (!inCurrentRun) flush()
  return items
}
