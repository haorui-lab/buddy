import { ArrowUpLeft, GitBranch, ChevronRight, TriangleAlert } from 'lucide-react'
import type { Task, TaskDetail } from '../../shared/types'
import { useT } from '../hooks/useI18n'
import { TaskStatusIcon } from './TaskStatusIcon'

export function DerivationTaskBar({ task, tasks, onSelectTask }: {
  task: TaskDetail; tasks: Task[]; onSelectTask?: (taskId: string, workspaceKey: string) => void
}) {
  const t = useT()
  const children = tasks.filter(item => item.parent_task_id === task.task_id && item.workspace_key === task.workspace_key)
  const parent = tasks.find(item => item.task_id === task.state.parent_task_id && item.workspace_key === task.workspace_key)
  const blocked = new Set<string>()
  for (const event of task.events ?? []) {
    if (event.type === 'task.completion_blocked' && Array.isArray(event.payload.child_task_ids)) {
      blocked.clear()
      event.payload.child_task_ids.forEach(id => { if (typeof id === 'string') blocked.add(id) })
    } else if (event.type === 'derivation.waived' || (event.type === 'derivation.reviewed' && event.payload.decision === 'accept')) {
      if (typeof event.payload.child_task_id === 'string') blocked.delete(event.payload.child_task_id)
    }
  }
  children.forEach(child => { if (child.status === 'DONE') blocked.delete(child.task_id) })
  const completionBlocked = blocked.size > 0 && !['DONE', 'CANCELLED'].includes(task.state.status)
  if (!task.state.parent_task_id && children.length === 0) return null
  return (
    <nav aria-label={t('derivation.navigation')} className="shrink-0 border-b border-border px-6 py-2 bg-bg-elevated max-h-36 overflow-y-auto text-xs space-y-1">
      {task.state.parent_task_id && (
        <button type="button" disabled={!onSelectTask} onClick={() => onSelectTask?.(task.state.parent_task_id!, task.workspace_key)} className="flex items-center gap-1.5 text-fg-secondary hover:text-fg disabled:opacity-50 w-full min-w-0 py-1 text-left">
          <ArrowUpLeft size={14} className="shrink-0" />
          <span className="shrink-0">{t('derivation.backToParent')}</span>
          {parent && <span className="truncate">· {parent.title || parent.task_id}</span>}
        </button>
      )}
      {children.length > 0 && (
        <div className="flex gap-2 items-start">
          <span className="inline-flex items-center gap-1.5 text-fg-muted shrink-0 py-1"><GitBranch size={14} />{t('derivation.children')} · {children.length}</span>
          <div className="flex-1 min-w-0">
            {children.map(child => (
              <button key={child.task_id} type="button" disabled={!onSelectTask} onClick={() => onSelectTask?.(child.task_id, child.workspace_key)} title={child.title || child.task_id} className="flex items-center gap-1.5 w-full min-w-0 text-left py-1 text-fg-secondary hover:text-fg disabled:opacity-50">
                <TaskStatusIcon status={child.status} />
                <span className="truncate flex-1">{child.title || child.task_id}</span>
                <span className={`shrink-0 ${child.status === 'FAILED' ? 'text-danger' : ''}`}>{child.status === 'COUNTDOWN' ? t('derivation.betweenRounds') : t(`status.${child.status}`)}</span>
                <ChevronRight size={12} className="shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}
      {completionBlocked && (
        <div role="status" className="flex items-start gap-1.5 py-1 text-danger">
          <TriangleAlert size={14} className="shrink-0 mt-px" />
          <span>{t(task.state.status === 'PAUSED' ? 'derivation.completionPaused' : 'derivation.completionBlocked')}</span>
        </div>
      )}
    </nav>
  )
}
