import type { Event, Task, TranscriptEntry } from '../../shared/types'
import { useLanguage, useT } from '../hooks/useI18n'
import { actorText, derivationEventDetails, derivationEventType, formatTimeWithRelativeDate } from '../lib/format'
import { translate, type TranslationKey } from '../lib/i18n'
import { renderMarkdown } from '../lib/markdown'

interface Props {
  entries: TranscriptEntry[]
  events: Event[]
  tasks: Task[]
  workspaceKey: string
  onSelectTask?: (taskId: string, workspaceKey: string) => void
}

export function DerivationNotice({ entries, events, tasks, workspaceKey, onSelectTask }: Props) {
  const t = useT()
  const lang = useLanguage()
  const eventDetails = derivationEventDetails(events)
  const failed = entries.some(entry => /\.(child_failed|start_failed)$/.test(String(entry.meta?.kind)))
  return (
    <div className="flex mb-3 justify-start">
      <div className={`message msg-system ${failed ? 'health-check-failed' : 'round-notice'} w-full`}>
        <div className="message-head">
          <span className="role">{t('actor.systemNotice')}</span>
          <span>{formatTimeWithRelativeDate(entries[entries.length - 1].ts, lang)}</span>
        </div>
        <div className="message-body space-y-1">
          {entries.map((entry, index) => {
            const storedKind = String(entry.meta?.kind)
            // Legacy transcripts only saved kind; their matching event retains payload.
            const matching = events.filter(event => event.type === storedKind && event.payload.message === entry.content && event.ts <= entry.ts)
            const event = typeof entry.meta?.event_seq === 'number'
              ? events.find(event => event.seq === entry.meta!.event_seq) : matching[matching.length - 1]
            const payload = { ...entry.meta, ...(event ? eventDetails.get(event.seq) : {}) }
            const kind = derivationEventType(storedKind, entry.content)
            const revision = typeof payload.delivery_revision === 'number' ? payload.delivery_revision : 1
            const resubmitted = revision > 1
            const version = typeof payload.version === 'string' ? payload.version : null
            const actor = actorText(entry.content.split(' ')[0], lang)
            const ids = Array.isArray(payload.task_ids) ? payload.task_ids.filter((id): id is string => typeof id === 'string')
              : typeof payload.child_task_id === 'string' ? [payload.child_task_id]
              : kind === 'derivation.created' ? (entry.content.match(/已创建子任务：(.+?)。?$/)?.[1] ?? '').replace(/。$/, '').split(', ').filter(Boolean) : []
            let summary: string
            switch (kind) {
              case 'derivation.proposed': summary = t('derivation.notice.proposed', { actor, count: entry.content.match(/共 (\d+) 个/)?.[1] ?? '?' }); break
              case 'derivation.decided': summary = t(/^\S+ 不同意派生方案。/.test(entry.content) ? 'derivation.notice.disagreed' : 'derivation.notice.agreed', { actor }); break
              case 'derivation.created': summary = t('derivation.notice.created', { count: ids.length }); break
              case 'derivation.submitted': summary = t(resubmitted ? 'derivation.notice.resubmitted' : 'derivation.notice.submitted', { actor, revision }); break
              case 'derivation.waiting': summary = t('derivation.notice.waiting'); break
              case 'derivation.child_failed': summary = t('derivation.notice.childFailed'); break
              case 'derivation.start_failed': summary = t('derivation.notice.startFailed'); break
              case 'derivation.child_submitted': summary = t(resubmitted ? 'derivation.notice.childResubmitted' : 'derivation.notice.childSubmitted', { revision }); break
              case 'derivation.child_delivered': summary = t(resubmitted ? 'derivation.notice.redelivered' : 'derivation.notice.delivered', { revision }); break
              case 'derivation.child_status_refreshed': summary = t(payload.inferred ? 'derivation.notice.statusFromHistory' : 'derivation.notice.statusRefreshed', {
                status: typeof payload.child_status === 'string'
                  ? translate(lang, `status.${payload.child_status}` as TranslationKey) : t('derivation.notice.statusUnreadable')
              }); break
              case 'derivation.restarted': summary = t('derivation.notice.restarted'); break
              case 'derivation.reviewed': summary = t((payload.decision ? payload.decision === 'accept' : entry.content.split('。')[0].endsWith('验收通过')) ? 'derivation.notice.accepted' : 'derivation.notice.rejected'); break
              case 'derivation.waived': summary = t('derivation.notice.waived'); break
              default: summary = entry.content.length > 100 ? `${entry.content.slice(0, 100)}…` : entry.content
            }
            return (
              <div key={index}>
                <span>{summary}</span>
                {version ? <span className="ml-2 text-xs text-fg-secondary" title={version}>{t('derivation.notice.version', { version: version.length > 12 ? version.slice(0, 12) : version })}</span> : null}
                {ids.map(id => {
                  const task = tasks.find(item => item.task_id === id && item.workspace_key === workspaceKey)
                  return task && onSelectTask ? (
                    <button key={id} type="button" onClick={() => onSelectTask(id, workspaceKey)} className="ml-2 text-accent hover:underline text-left break-words">
                      {task.title || id}
                    </button>
                  ) : null
                })}
              </div>
            )
          })}
        </div>
        <details className="mt-2 text-xs text-fg-secondary">
          <summary className="cursor-pointer w-fit hover:text-fg">{t('derivation.notice.details')}</summary>
          <div className="mt-2 space-y-3">
            {entries.map((entry, index) => (
              <div key={index}>
                <div className="text-fg-muted mb-1">{formatTimeWithRelativeDate(entry.ts, lang)}</div>
                <div className="message-body break-words" dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.content) }} />
              </div>
            ))}
          </div>
        </details>
      </div>
    </div>
  )
}
