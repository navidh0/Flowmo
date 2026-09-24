/**
 * One task line — the most-read row in the app.
 *
 * Colour is load-bearing and used for nothing else:
 *  - the checkbox ring is the priority (`PRIORITY_VAR`, 1 = highest),
 *  - the left edge bar and target glyph mean "the timer is counting time against this",
 *  - danger text means overdue,
 *  - a dot means project, and only appears in the cross-project view where the row's
 *    project is otherwise unknowable.
 *
 * Every number rendered here arrives derived from main. `actualPomodoros` and `focusMs`
 * are shown side by side rather than reconciled, because they answer different questions:
 * the first counts pomodoros you finished, the second counts minutes you actually spent,
 * including sessions you stopped early. "2/5 · 1h 10m" is not a contradiction, it is the
 * useful part.
 */

import type { DragEvent } from 'react'
import type { Project, TaskWithStats } from '@shared/types'
import { TargetIcon, WarningIcon } from '@renderer/components/timer/icons'
import { PRIORITY_LABEL, PRIORITY_VAR, formatDueDate, formatDuration } from '@renderer/lib/format'
import {
  CalendarIcon,
  CheckIcon,
  ChecklistIcon,
  ClockIcon,
  GripIcon,
  RepeatIcon,
  TodoistIcon
} from './icons'
import { HOVER_ACTION } from './ui'

export interface RowDrag {
  dragging: boolean
  /** True while the pointer is over the top half of this row, i.e. drop lands above it. */
  dropAbove: boolean
  /** Only for the last row: the drop lands past the end of the list. */
  dropBelow: boolean
  onDragStart: (event: DragEvent<HTMLElement>) => void
  onDragOver: (event: DragEvent<HTMLElement>) => void
  onDrop: (event: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
}

export interface TaskRowProps {
  task: TaskWithStats
  /** Open in the detail panel. */
  selected: boolean
  /** The timer's current target. */
  focused: boolean
  /** Supplied only in the cross-project view. */
  project?: Project | undefined
  /** Rendered as history: struck through, muted, not draggable. */
  completed?: boolean
  /** Local day key, passed in so a list of 200 rows does not each read the clock. */
  todayKey: string
  onSelect: () => void
  onToggleComplete: () => void
  /** Alt+Arrow reorder. Absent for the completed list, which has no order to change. */
  onMove?: (delta: number) => void
  drag?: RowDrag | undefined
}

function Meta({
  icon,
  text,
  title,
  tone = 'muted'
}: {
  icon: React.JSX.Element
  text: string
  title: string
  tone?: 'muted' | 'danger' | 'plain'
}): React.JSX.Element {
  const color =
    tone === 'danger'
      ? 'text-[var(--color-danger)]'
      : tone === 'plain'
        ? 'text-[var(--color-text)]'
        : 'text-[var(--color-text-muted)]'
  return (
    <span className={`inline-flex items-center gap-1 ${color}`} title={title}>
      {icon}
      <span className="tabular">{text}</span>
    </span>
  )
}

export function TaskRow({
  task,
  selected,
  focused,
  project,
  completed = false,
  todayKey,
  onSelect,
  onToggleComplete,
  onMove,
  drag
}: TaskRowProps): React.JSX.Element {
  const due = formatDueDate(task.dueDate)
  // Both sides are 'YYYY-MM-DD' local keys, so a lexical compare is a calendar compare —
  // and never round-trips the date through an instant, which would shift the day.
  const overdue = !completed && task.dueDate !== null && task.dueDate < todayKey
  const dueToday = task.dueDate === todayKey

  const hasEstimate = task.estimatedPomodoros !== null
  const showPomodoros = hasEstimate || task.actualPomodoros > 0

  const synced = task.source === 'todoist'
  const deletedUpstream = task.remoteDeletedAt !== null
  const completeTitle = deletedUpstream
    ? 'Deleted in Todoist — open it to decide what happens next'
    : completed
      ? 'Move back to open'
      : task.recurring
        ? `Complete · advances to the next occurrence · ${PRIORITY_LABEL[task.priority]}`
        : `Complete · ${PRIORITY_LABEL[task.priority]}`

  return (
    <li
      className={`group relative flex items-start gap-2.5 rounded-lg border px-2.5 py-2 transition-colors ${
        drag?.dragging ? 'opacity-40' : ''
      } ${
        selected
          ? 'border-[var(--color-focus)]/55 bg-[var(--color-surface-raised)]'
          : 'border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-surface-raised)]/70'
      } ${focused && !selected ? 'bg-[color-mix(in_srgb,var(--color-focus)_10%,transparent)]' : ''} ${
        deletedUpstream ? 'opacity-70' : ''
      }`}
      draggable={drag !== undefined}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
    >
      {drag?.dropAbove ? (
        <span className="pointer-events-none absolute -top-px left-1 right-1 h-[2px] rounded-full bg-[var(--color-focus)]" />
      ) : null}
      {drag?.dropBelow ? (
        <span className="pointer-events-none absolute -bottom-px left-1 right-1 h-[2px] rounded-full bg-[var(--color-focus)]" />
      ) : null}

      {focused ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-[var(--color-focus)]"
        />
      ) : null}

      <button
        type="button"
        role="checkbox"
        aria-checked={completed}
        title={completeTitle}
        aria-label={
          completed
            ? `Reopen ${task.title}`
            : task.recurring
              ? `Complete ${task.title} — advances to the next occurrence`
              : `Complete ${task.title}, ${PRIORITY_LABEL[task.priority]}`
        }
        onClick={onToggleComplete}
        className="mt-[2px] grid h-[17px] w-[17px] shrink-0 place-items-center rounded-full border-[1.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]/45"
        style={{
          borderColor: completed ? 'var(--color-text-muted)' : PRIORITY_VAR[task.priority],
          backgroundColor: completed
            ? 'color-mix(in srgb, var(--color-text-muted) 22%, transparent)'
            : undefined
        }}
      >
        <CheckIcon
          className={`h-2.5 w-2.5 transition-opacity ${
            completed ? 'text-[var(--color-text-muted)] opacity-100' : 'opacity-0 group-hover:opacity-45'
          }`}
        />
      </button>

      <button
        type="button"
        data-task-row={task.id}
        aria-current={focused}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (onMove && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault()
            event.stopPropagation()
            onMove(event.key === 'ArrowUp' ? -1 : 1)
          }
        }}
        className="min-w-0 flex-1 rounded text-left outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-focus)]/60"
      >
        <div className="flex items-center gap-1.5">
          {focused ? (
            <TargetIcon className="h-3 w-3 shrink-0 text-[var(--color-focus)]" />
          ) : null}
          <span
            className={`min-w-0 truncate text-[13px] leading-5 ${
              completed
                ? 'text-[var(--color-text-muted)] line-through decoration-[var(--color-text-muted)]/60'
                : 'text-[var(--color-text)]'
            }`}
          >
            {task.title}
          </span>
          {synced ? (
            <span
              className="shrink-0 text-[var(--color-text-muted)]"
              title="Synced from Todoist"
            >
              <TodoistIcon />
            </span>
          ) : null}
          {task.recurring ? (
            <span
              className="shrink-0 text-[var(--color-text-muted)]"
              title="Recurring — completing it advances to the next occurrence instead of closing it for good"
            >
              <RepeatIcon className="h-3 w-3" />
            </span>
          ) : null}
        </div>

        {deletedUpstream ? (
          <div
            className="mt-[3px] inline-flex items-center gap-1 text-[11px] leading-4 text-[var(--color-danger)]"
            title="This task was deleted in Todoist. Open it to keep it as a local task or delete it here."
          >
            <WarningIcon className="h-3 w-3" />
            <span>Deleted in Todoist</span>
          </div>
        ) : null}

        {due !== null || showPomodoros || task.focusMs > 0 || task.subtaskTotal > 0 || project ? (
          <div className="mt-[3px] flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-4">
            {project ? (
              <span
                className="inline-flex items-center gap-1.5 text-[var(--color-text-muted)]"
                title={`Project: ${project.name}`}
              >
                <span
                  className="h-[7px] w-[7px] rounded-full"
                  style={{ backgroundColor: project.color }}
                />
                <span className="max-w-28 truncate">{project.name}</span>
              </span>
            ) : null}

            {due !== null ? (
              <Meta
                icon={
                  overdue ? <WarningIcon className="h-3 w-3" /> : <CalendarIcon className="h-3 w-3" />
                }
                text={due}
                title={`Due ${task.dueDate}`}
                tone={overdue ? 'danger' : dueToday ? 'plain' : 'muted'}
              />
            ) : null}

            {showPomodoros ? (
              <Meta
                icon={<TargetIcon className="h-3 w-3" />}
                text={hasEstimate ? `${task.actualPomodoros}/${task.estimatedPomodoros}` : String(task.actualPomodoros)}
                title={
                  hasEstimate
                    ? `${task.actualPomodoros} of ${task.estimatedPomodoros} pomodoros completed`
                    : `${task.actualPomodoros} pomodoros completed`
                }
              />
            ) : null}

            {task.focusMs > 0 ? (
              <Meta
                icon={<ClockIcon className="h-3 w-3" />}
                text={formatDuration(task.focusMs)}
                title="Focus time logged on this task, including sessions stopped early"
              />
            ) : null}

            {task.subtaskTotal > 0 ? (
              <Meta
                icon={<ChecklistIcon className="h-3 w-3" />}
                text={`${task.subtaskDone}/${task.subtaskTotal}`}
                title={`${task.subtaskDone} of ${task.subtaskTotal} subtasks done`}
              />
            ) : null}
          </div>
        ) : null}
      </button>

      {drag ? (
        <span
          aria-hidden="true"
          className={`mt-0.5 shrink-0 cursor-grab text-[var(--color-text-muted)]/70 active:cursor-grabbing ${HOVER_ACTION}`}
          title="Drag to reorder (or Alt+↑/↓)"
        >
          <GripIcon className="h-3.5 w-3.5" />
        </span>
      ) : null}
    </li>
  )
}
