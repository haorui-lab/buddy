// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DerivationNotice } from '../../../src/renderer/components/DerivationNotice'
import { DerivationTaskBar } from '../../../src/renderer/components/DerivationTaskBar'
import { eventTypeLabel } from '../../../src/renderer/lib/format'
import type { Event, Task, TaskDetail, TranscriptEntry } from '../../../src/shared/types'

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => key === 'buddy.language' ? 'zh-CN' : null }
  })
})
afterEach(cleanup)
const child = { task_id: 'child-1', workspace_key: 'ws', parent_task_id: 'parent', title: '修复派生缺陷', status: 'RUNNING_CURSOR' } as Task
const notice = (kind: string, content: string): TranscriptEntry => ({ role: 'system', ts: '2026-10-29T11:10:00Z', content, meta: { kind: `derivation.${kind}` } })

describe('derivation notices', () => {
  it('uses existing system notice styling, display names and collapsed full reasons', () => {
    const original = 'wecode_claude 同意派生方案。核实了所有状态写入路径。'
    const { container } = render(<DerivationNotice entries={[notice('decided', original)]} events={[]} tasks={[]} workspaceKey="ws" />)
    expect(screen.getByText('系统通知')).toBeVisible()
    expect(screen.getByText('WeCode Claude 同意派生方案。')).toBeVisible()
    expect(screen.getByText(original)).not.toBeVisible()
    expect(container.querySelector('.round-notice')).toBeInTheDocument()
    fireEvent.click(screen.getByText('派生详情'))
    expect(screen.getByText(original)).toBeVisible()
    fireEvent.click(screen.getByText('派生详情'))
    expect(screen.getByText(original)).not.toBeVisible()
  })

  it('resolves old created messages to titled clickable tasks', () => {
    const select = vi.fn()
    render(<DerivationNotice entries={[notice('created', '已创建子任务：child-1。')]} events={[]} tasks={[child]} workspaceKey="ws" onSelectTask={select} />)
    expect(screen.getByText('已创建 1 个子任务。')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '修复派生缺陷' }))
    expect(select).toHaveBeenCalledWith('child-1', 'ws')
  })

  it('retains failure diagnostics in accessible details with error styling', () => {
    const { container } = render(<DerivationNotice entries={[notice('child_failed', 'ACP Error -32603: Stream ended without receiving any events')]} events={[]} tasks={[]} workspaceKey="ws" />)
    expect(container.querySelector('.health-check-failed')).toBeInTheDocument()
    expect(screen.getByText('子任务执行失败，已通知父任务处理。')).toBeVisible()
    fireEvent.click(screen.getByText('派生详情'))
    expect(screen.getByText(/ACP Error/)).toBeVisible()
  })

  it('does not imply an execution promise rejection necessarily happened during startup', () => {
    render(<DerivationNotice entries={[notice('start_failed', '重新启动失败：ACP stream ended')]} events={[]} tasks={[]} workspaceKey="ws" />)
    expect(screen.getByText('子任务执行异常，请展开详情查看原因。')).toBeVisible()
    expect(eventTypeLabel('derivation.start_failed', 'zh-CN')).toBe('子任务执行异常')
  })

  it('does not show a task from a different workspace as a navigation target', () => {
    render(<DerivationNotice entries={[notice('created', '已创建子任务：child-1。')]} events={[]} tasks={[{ ...child, workspace_key: 'other' }]} workspaceKey="ws" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('localizes derivation process events', () => {
    expect(eventTypeLabel('derivation.created', 'zh-CN')).toBe('创建子任务')
    expect(eventTypeLabel('derivation.child_failed', 'en')).toBe('Subtask failed')
  })

  it('does not interpret quoted decision words in a reason as the outcome', () => {
    render(<DerivationNotice entries={[
      notice('decided', 'cursor 同意派生方案。上次 不同意的意见均已解决。'),
      notice('reviewed', '父任务 退回修改。当前不满足验收通过条件。')
    ]} events={[]} tasks={[]} workspaceKey="ws" />)
    expect(screen.getByText('Cursor 同意派生方案。')).toBeVisible()
    expect(screen.getByText('子任务已退回修改。')).toBeVisible()
  })
})

describe('persistent derivation navigation', () => {
  const blockedEvent = { type: 'task.completion_blocked', payload: { child_task_ids: ['child-1'] } } as Event

  it('keeps a completion-blocked hint visible and marks a failed child status red', () => {
    const task = { task_id: 'parent', workspace_key: 'ws', state: { status: 'RUNNING_CURSOR' }, events: [blockedEvent] } as TaskDetail
    render(<DerivationTaskBar task={task} tasks={[{ ...child, status: 'FAILED' }]} />)
    expect(screen.getByRole('status')).toHaveTextContent('父任务暂不能完成')
    expect(screen.getByText('失败')).toHaveClass('text-danger')
  })

  it.each(['derivation.waived', 'derivation.reviewed'])('clears a resolved blockage after %s', type => {
    const task = { task_id: 'parent', workspace_key: 'ws', state: { status: 'RUNNING_CURSOR' }, events: [blockedEvent, { type, payload: { child_task_id: 'child-1', decision: 'accept' } }] } as TaskDetail
    render(<DerivationTaskBar task={task} tasks={[child]} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('does not infer completion blockage from a failed child alone', () => {
    const task = { task_id: 'parent', workspace_key: 'ws', state: { status: 'RUNNING_CURSOR' }, events: [] } as unknown as TaskDetail
    render(<DerivationTaskBar task={task} tasks={[{ ...child, status: 'FAILED' }]} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it.each(['DONE', 'CANCELLED'] as const)('hides old blockage after the parent is %s', status => {
    const task = { task_id: 'parent', workspace_key: 'ws', state: { status }, events: [blockedEvent] } as TaskDetail
    render(<DerivationTaskBar task={task} tasks={[child]} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows live status and scopes children to the selected workspace', () => {
    const select = vi.fn()
    const task = { task_id: 'parent', workspace_key: 'ws', state: {} } as TaskDetail
    render(<DerivationTaskBar task={task} tasks={[child, { ...child, workspace_key: 'other', title: 'Other workspace' }]} onSelectTask={select} />)
    expect(screen.getByRole('navigation', { name: '父子任务导航' })).toBeVisible()
    expect(screen.getByText('Cursor 运行中')).toBeVisible()
    expect(screen.queryByText('Other workspace')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(select).toHaveBeenCalledWith('child-1', 'ws')
  })

  it('returns from a child to its parent even if the parent is absent from the list', () => {
    const select = vi.fn()
    const task = { task_id: 'child-1', workspace_key: 'ws', state: { parent_task_id: 'parent' } } as TaskDetail
    render(<DerivationTaskBar task={task} tasks={[]} onSelectTask={select} />)
    fireEvent.click(screen.getByRole('button', { name: '返回父任务' }))
    expect(select).toHaveBeenCalledWith('parent', 'ws')
  })
})
