/**
 * Editor for the task open in the detail panel.
 *
 * Text fields keep a local draft and commit on blur or Enter; everything else commits on
 * click. The drafts are re-seeded from the task's id, deliberately not from its title or
 * notes: every mutation in this store triggers a refresh, and re-seeding on value would
 * let an unrelated background refresh overwrite half-typed text.
 *
 * The due date is edited through a native date input, whose value is already a
 * 'YYYY-MM-DD' local calendar string — the same shape the column stores. Nothing here
 * turns a due date into an instant, which is what would shift it a day for anyone east or
 * west of UTC.
 */

import { useEffect, useState } from 'react'
import type { Priority, TaskWithStats } from '@shared/types'
import { Button, IconButton } from '@renderer/components/timer/Button'
import { TargetIcon, XIcon } from '@renderer/components/timer/icons'
import {
  PRIORITY_LABEL,
  PRIORITY_VAR,
  formatDuration,
  toLocalDateKey
} from '@renderer/lib/format'
import { useTasksStore } from '@renderer/stores/tasks'
import { ClockIcon, TrashIcon } from './icons'
import { SubtaskList } from './SubtaskList'
import { FIELD, InlineConfirm, SectionLabel } from './ui'

const PRIORITIES: Priority[] = [1, 2, 3, 4]

/**
 * Calendar arithmetic, not millisecond arithmetic: midnight + 24h lands on the same day
 * again when the clocks go back, which would make "Tomorrow" mean today twice a year.
 */
function dayKeyOffset(days: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + days)
  return toLocalDateKey(d.getTime())
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1.5">
        <SectionLabel>{label}</SectionLabel>
      </div>
      {children}
    </div>
  )
}

export function TaskDetail(): React.JSX.Element | null {
  const selectedTaskId = useTasksStore((s) => s.selectedTaskId)
  const tasks = useTasksStore((s) => s.tasks)
  const completedTasks = useTasksStore((s) => s.completedTasks)
  const projects = useTasksStore((s) => s.projects)
  const focusTaskId = useTasksStore((s) => s.focusTaskId)

  const selectTask = useTasksStore((s) => s.selectTask)
  const updateTask = useTasksStore((s) => s.updateTask)
  const deleteTask = useTasksStore((s) => s.deleteTask)
  const setTaskCompleted = useTasksStore((s) => s.setTaskCompleted)
  const setFocusTask = useTasksStore((s) => s.setFocusTask)

  const task: TaskWithStats | undefined =
    tasks.find((t) => t.id === selectedTaskId) ??
    completedTasks.find((t) => t.id === selectedTaskId)

  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [estimate, setEstimate] = useState('')
  const [confirming, setConfirming] = useState(false)

  const taskId = task?.id ?? null

  useEffect(() => {
    const current = useTasksStore.getState()
    const row =
      current.tasks.find((t) => t.id === taskId) ??
      current.completedTasks.find((t) => t.id === taskId)
    setTitle(row?.title ?? '')
    setNotes(row?.notes ?? '')
    setEstimate(row?.estimatedPomodoros === null ? '' : String(row?.estimatedPomodoros ?? ''))
    setConfirming(false)
  }, [taskId])

  if (selectedTaskId === null) return null
  // The selection can outlive its row for a frame — after a delete, or a project switch
  // whose refresh has not landed yet.
  if (!task) return null

  const project = projects.find((p) => p.id === task.projectId)
  const isFocused = focusTaskId === task.id
  const completed = task.completedAt !== null

  function commitTitle(): void {
    const next = title.trim()
    if (!task) return
    if (!next) {
      setTitle(task.title)
      return
    }
    if (next !== task.title) void updateTask(task.id, { title: next })
  }

  function commitNotes(): void {
    if (!task) return
    const next = notes.trim()
    const current = task.notes ?? ''
    if (next !== current) void updateTask(task.id, { notes: next === '' ? null : next })
  }

  function commitEstimate(raw: string): void {
    if (!task) return
    const trimmed = raw.trim()
    if (trimmed === '') {
      setEstimate('')
      if (task.estimatedPomodoros !== null) void updateTask(task.id, { estimatedPomodoros: null })
      return
    }
    const parsed = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(parsed)) {
      setEstimate(task.estimatedPomodoros === null ? '' : String(task.estimatedPomodoros))
      return
    }
    const clamped = Math.min(99, Math.max(1, parsed))
    setEstimate(String(clamped))
    if (clamped !== task.estimatedPomodoros) {
      void updateTask(task.id, { estimatedPomodoros: clamped })
    }
  }

  function stepEstimate(delta: number): void {
    if (!task) return
    const base = task.estimatedPomodoros ?? 0
    const next = base + delta
    if (next <= 0) {
      setEstimate('')
      void updateTask(task.id, { estimatedPomodoros: null })
      return
    }
    commitEstimate(String(next))
  }

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-l border-[var(--color-border)] bg-[var(--color-surface-raised)]">
      <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
        {project ? (
          <span className="flex min-w-0 items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: project.color }}
            />
            <span className="truncate">{project.name}</span>
          </span>
        ) : null}
        {completed ? (
          <span className="shrink-0 rounded-full border border-[var(--color-border)] px-1.5 py-px text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
            Done
          </span>
        ) : null}
        <IconButton
          variant="ghost"
          aria-label="Close details"
          title="Close"
          className="ml-auto h-6 w-6 shrink-0"
          onClick={() => void selectTask(null)}
        >
          <XIcon />
        </IconButton>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
        <textarea
          rows={2}
          value={title}
          aria-label="Task title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            }
            if (e.key === 'Escape') setTitle(task.title)
          }}
          className={`${FIELD} resize-none text-[14px] font-medium leading-5`}
        />

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant={isFocused ? 'primary' : 'secondary'}
            accent="var(--color-focus)"
            icon={<TargetIcon className="h-3.5 w-3.5" />}
            onClick={() => void setFocusTask(isFocused ? null : task.id)}
            title="Point the timer at this task"
          >
            {isFocused ? 'Timing this' : 'Time this'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void setTaskCompleted(task.id, !completed)}
          >
            {completed ? 'Reopen' : 'Complete'}
          </Button>
        </div>

        <Field label="Priority">
          <div className="grid grid-cols-4 gap-1">
            {PRIORITIES.map((level) => {
              const active = task.priority === level
              return (
                <button
                  key={level}
                  type="button"
                  aria-pressed={active}
                  onClick={() => void updateTask(task.id, { priority: level })}
                  className={`flex items-center justify-center gap-1.5 rounded-md border px-1 py-1.5 text-[11px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-[var(--color-focus)]/60 ${
                    active
                      ? 'text-[var(--color-text)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[#39414f] hover:text-[var(--color-text)]'
                  }`}
                  style={
                    active
                      ? {
                          borderColor: PRIORITY_VAR[level],
                          backgroundColor: `color-mix(in srgb, ${PRIORITY_VAR[level]} 16%, transparent)`
                        }
                      : undefined
                  }
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: PRIORITY_VAR[level] }}
                  />
                  {PRIORITY_LABEL[level]}
                </button>
              )
            })}
          </div>
        </Field>

        <Field label="Due date">
          <input
            type="date"
            value={task.dueDate ?? ''}
            aria-label="Due date"
            onChange={(e) => void updateTask(task.id, { dueDate: e.target.value || null })}
            className={`${FIELD} [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:[filter:invert(0.75)]`}
          />
          <div className="mt-1.5 flex gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="px-2"
              onClick={() => void updateTask(task.id, { dueDate: dayKeyOffset(0) })}
            >
              Today
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="px-2"
              onClick={() => void updateTask(task.id, { dueDate: dayKeyOffset(1) })}
            >
              Tomorrow
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="px-2"
              disabled={task.dueDate === null}
              onClick={() => void updateTask(task.id, { dueDate: null })}
            >
              Clear
            </Button>
          </div>
        </Field>

        <Field label="Estimated pomodoros">
          <div className="flex items-center gap-1.5">
            <IconButton
              variant="secondary"
              aria-label="One fewer pomodoro"
              disabled={task.estimatedPomodoros === null}
              onClick={() => stepEstimate(-1)}
            >
              <span className="text-[15px] leading-none">−</span>
            </IconButton>
            <input
              inputMode="numeric"
              value={estimate}
              aria-label="Estimated pomodoros"
              placeholder="—"
              onChange={(e) => setEstimate(e.target.value.replace(/[^0-9]/g, ''))}
              onBlur={(e) => commitEstimate(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              className={`${FIELD} tabular w-14 text-center`}
            />
            <IconButton
              variant="secondary"
              aria-label="One more pomodoro"
              onClick={() => stepEstimate(1)}
            >
              <span className="text-[15px] leading-none">+</span>
            </IconButton>
          </div>
        </Field>

        {/* The two numbers count different things on purpose; say so, once, here. */}
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-2.5">
          <div className="flex items-baseline gap-5">
            <span className="inline-flex items-baseline gap-1.5">
              <TargetIcon className="h-3.5 w-3.5 translate-y-[2px] text-[var(--color-text-muted)]" />
              <span className="tabular text-[15px] font-semibold">
                {task.actualPomodoros}
                {task.estimatedPomodoros !== null ? `/${task.estimatedPomodoros}` : ''}
              </span>
              <span className="text-[11px] text-[var(--color-text-muted)]">done</span>
            </span>
            <span className="inline-flex items-baseline gap-1.5">
              <ClockIcon className="h-3.5 w-3.5 translate-y-[2px] text-[var(--color-text-muted)]" />
              <span className="tabular text-[15px] font-semibold">
                {formatDuration(task.focusMs)}
              </span>
              <span className="text-[11px] text-[var(--color-text-muted)]">focused</span>
            </span>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            Only finished pomodoros count on the left. The time on the right is every focus
            session logged against this task, including ones you stopped early.
          </p>
        </div>

        <Field label="Notes">
          <textarea
            rows={5}
            value={notes}
            aria-label="Notes"
            placeholder="Anything you need next to the timer."
            onChange={(e) => setNotes(e.target.value)}
            onBlur={commitNotes}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setNotes(task.notes ?? '')
            }}
            className={`${FIELD} resize-none leading-relaxed`}
          />
        </Field>

        <SubtaskList taskId={task.id} done={task.subtaskDone} total={task.subtaskTotal} />
      </div>

      <footer className="border-t border-[var(--color-border)] p-2.5">
        {confirming ? (
          <InlineConfirm
            confirmLabel="Delete task"
            onCancel={() => setConfirming(false)}
            onConfirm={() => {
              setConfirming(false)
              void deleteTask(task.id)
            }}
            message={
              <>
                Delete <strong className="font-semibold">{task.title}</strong>
                {task.subtaskTotal > 0 ? (
                  <>
                    {' '}
                    and its <span className="tabular">{task.subtaskTotal}</span> subtask
                    {task.subtaskTotal === 1 ? '' : 's'}
                  </>
                ) : null}
                ? Focus time you already logged stays in your stats. This cannot be undone.
              </>
            }
          />
        ) : (
          <Button
            variant="danger"
            size="sm"
            className="w-full"
            icon={<TrashIcon />}
            onClick={() => setConfirming(true)}
          >
            Delete task
          </Button>
        )}
      </footer>
    </aside>
  )
}
