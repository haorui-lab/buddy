import type { TaskState, TranscriptEntry } from '../../shared/types'

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

export function derivationTimeline(transcript: TranscriptEntry[], state: Pick<TaskState, 'active_run' | 'status'>): TimelineItem[] {
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
