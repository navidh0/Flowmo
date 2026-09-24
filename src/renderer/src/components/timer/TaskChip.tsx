/**
 * What this session is being logged against.
 *
 * The label opens a picker so a session can be pointed at a task without leaving the timer
 * panel for the task list. Today's tasks (overdue + due today, same order as the Today smart
 * view) are listed first since that is what "what should I be doing" usually means; search
 * narrows across everything open. Detaching stays a dedicated button — a one-click action
 * should not require opening the picker just to choose "nothing".
 *
 * Depends on the tasks store (via `useTasksBootstrap`), which is safe here specifically
 * because this component only ever mounts in the main window's timer panel, never the mini
 * widget — the mini widget has its own, separate component tree.
 */

import { useEffect, useRef, useState } from 'react'
import { useTasksBootstrap } from '@renderer/components/tasks/bootstrap'
import { dueTimeLabel, selectToday, type DueTimeParts } from '@renderer/components/tasks/views'
import { PRIORITY_VAR } from '../../lib/format'
import { useTasksStore } from '../../stores/tasks'
import { timerActions } from '../../stores/timer'
import { TargetIcon, XIcon } from './icons'
import { useCurrentTask } from './useCurrentTask'

export function TaskChip(): React.JSX.Element {
  useTasksBootstrap()

  const { taskId, task } = useCurrentTask()
  const attached = taskId != null

  const allOpenTasks = useTasksStore((s) => s.allOpenTasks)
  const todayKey = useTasksStore((s) => s.todayKey)
  const projects = useTasksStore((s) => s.projects)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  function openPicker(): void {
    setQuery('')
    setOpen(true)
  }

  function pick(id: number | null): void {
    timerActions.setTask(id)
    setOpen(false)
  }

  const needle = query.trim().toLowerCase()
  const { overdue, today } = selectToday(allOpenTasks, todayKey)
  const todayIds = new Set([...overdue, ...today].map((t) => t.id))
  const todayTasks = [...overdue, ...today].filter((t) => t.title.toLowerCase().includes(needle))
  const restTasks = allOpenTasks.filter(
    (t) => !todayIds.has(t.id) && t.title.toLowerCase().includes(needle)
  )

  // An ellipsis rather than "Loading…": the fetch resolves in a frame or two and a word that
  // appears and vanishes draws more attention than the title it is standing in for.
  const label = attached ? (task?.title ?? '…') : 'No task'
  const chipDueTime = task ? dueTimeLabel(task) : null

  return (
    <div className="relative" ref={rootRef}>
      <div
        className={`flex h-8 max-w-[320px] items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-raised)] pl-3 text-[12px] ${
          attached ? 'pr-1' : 'pr-3'
        }`}
      >
        <button
          type="button"
          onClick={openPicker}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={attached ? `Change task, currently ${label}` : 'Pick a task to time'}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-full text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-text-muted)]/40"
        >
          {task ? (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: PRIORITY_VAR[task.priority] }}
              aria-hidden="true"
            />
          ) : (
            <TargetIcon className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
          )}

          <span
            className={`truncate ${attached ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`}
            title={
              attached
                ? chipDueTime?.text !== null && chipDueTime?.text !== undefined
                  ? `${task?.title ?? ''} · Due ${chipDueTime.text}`
                  : (task?.title ?? undefined)
                : undefined
            }
          >
            {label}
            {chipDueTime?.compact !== null && chipDueTime?.compact !== undefined ? (
              <span className="ml-1.5 text-[var(--color-text-muted)]">
                · {chipDueTime.compact}
              </span>
            ) : null}
          </span>
        </button>

        {attached && (
          <button
            type="button"
            aria-label="Detach task from timer"
            title="Detach task"
            onClick={() => pick(null)}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[var(--color-text-muted)] outline-none transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--color-danger)_16%,transparent)] hover:text-[var(--color-danger)] focus-visible:ring-2 focus-visible:ring-[var(--color-text-muted)]/40 active:scale-95"
          >
            <XIcon className="h-3 w-3" />
          </button>
        )}
      </div>

      {open ? (
        <>
          {/* Catches the click that dismisses the picker without stealing focus styling. */}
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute top-[calc(100%+8px)] left-0 z-30 w-72 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-2 shadow-2xl shadow-black/50">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search open tasks…"
              aria-label="Search tasks"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-2.5 py-1.5 text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]/70 focus:border-[var(--color-focus)] focus:ring-1 focus:ring-[var(--color-focus)]/40"
            />

            <div role="listbox" aria-label="Tasks" className="mt-2 max-h-64 overflow-y-auto">
              {attached ? (
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => pick(null)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-[var(--color-text-muted)] outline-none hover:bg-[var(--color-surface-sunken)] focus-visible:bg-[var(--color-surface-sunken)]"
                >
                  <XIcon className="h-3 w-3 shrink-0" />
                  No task
                </button>
              ) : null}

              {todayTasks.length > 0 ? (
                <div className="mt-1 px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-text-muted)]">
                  Today
                </div>
              ) : null}
              {todayTasks.map((t) => (
                <TaskOption
                  key={t.id}
                  task={t}
                  project={projects.find((p) => p.id === t.projectId)}
                  active={t.id === taskId}
                  onPick={() => pick(t.id)}
                />
              ))}

              {restTasks.length > 0 ? (
                <div className="mt-1 px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-text-muted)]">
                  All open tasks
                </div>
              ) : null}
              {restTasks.map((t) => (
                <TaskOption
                  key={t.id}
                  task={t}
                  project={projects.find((p) => p.id === t.projectId)}
                  active={t.id === taskId}
                  onPick={() => pick(t.id)}
                />
              ))}

              {todayTasks.length === 0 && restTasks.length === 0 ? (
                <p className="px-2 py-2 text-[12px] text-[var(--color-text-muted)]">
                  {needle ? 'No open tasks match.' : 'No open tasks.'}
                </p>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

function TaskOption({
  task,
  project,
  active,
  onPick
}: {
  task: { id: number; title: string; priority: 1 | 2 | 3 | 4 } & DueTimeParts
  project: { name: string; color: string } | undefined
  active: boolean
  onPick: () => void
}): React.JSX.Element {
  const due = dueTimeLabel(task)
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onPick}
      title={due.text !== null ? `${task.title} · Due ${due.text}` : task.title}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] outline-none focus-visible:bg-[var(--color-surface-sunken)] ${
        active
          ? 'bg-[var(--color-surface-sunken)] text-[var(--color-text)]'
          : 'text-[var(--color-text)] hover:bg-[var(--color-surface-sunken)]'
      }`}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: PRIORITY_VAR[task.priority] }}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
      {due.compact !== null ? (
        <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">
          {due.compact}
        </span>
      ) : null}
      {project ? (
        <span
          className="h-[7px] w-[7px] shrink-0 rounded-full"
          style={{ backgroundColor: project.color }}
          title={project.name}
        />
      ) : null}
    </button>
  )
}
