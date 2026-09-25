/**
 * The current selection's tasks, plus quick capture and the completed history.
 *
 * The current selection is either a project (or "All tasks") or a smart view (Today /
 * Upcoming) — see `useTasksStore`'s `smartView`. A smart view spans every project and is
 * grouped by due date instead of showing one flat, reorderable list, so it gets its own
 * render path below rather than reusing the project list's drag machinery, which has no
 * meaning once rows are grouped by date rather than a single persisted order.
 *
 * The add field is always mounted and always visible: capturing a task is the thing this
 * screen is for, and a capture flow that starts with "click New" costs a mouse trip you
 * make thirty times a day. Enter adds and leaves the caret in place for the next one.
 *
 * Reordering (project/"All tasks" view only) is native HTML5 drag-and-drop — no dependency
 * for what is two events and an array splice — and commits through `reorderTasks`, which
 * applies the new order optimistically and rolls it back if main rejects it. Alt+↑/↓ does
 * the same thing from the keyboard, because a drag-only feature is a mouse-only feature.
 */

import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import type { Project, TaskWithStats } from '@shared/types'
import { Button } from '@renderer/components/timer/Button'
import { formatDueGroupLabel } from '@renderer/lib/format'
import { useTasksStore } from '@renderer/stores/tasks'
import { ChevronIcon, EmptyListIcon, PlusIcon } from './icons'
import { TaskRow, type RowDrag } from './TaskRow'
import { FIELD, SectionLabel } from './ui'
import { countUpcoming, selectToday, selectUpcoming } from './views'

/** Where a new task lands when the "All tasks" view is open and no project is implied. */
function fallbackProject(projects: Project[]): Project | undefined {
  return projects.find((p) => p.name === 'Inbox') ?? projects[0]
}

interface DueGroupProps {
  label: string
  tone?: 'muted' | 'danger'
  tasks: TaskWithStats[]
  todayKey: string
  projects: Project[]
  selectedTaskId: number | null
  focusTaskId: number | null
  onSelect: (id: number) => void
  onComplete: (id: number) => void
}

/** One due-date group inside a smart view: a label, then its rows in the shared ordering
 *  (`views.ts`'s `compareWithinGroup` via `selectToday`/`selectUpcoming`) — timed first by
 *  time, then untimed by priority. Not draggable: there is no single persisted order across
 *  a view that spans every project and regroups itself by due date. */
function DueGroup({
  label,
  tone = 'muted',
  tasks,
  todayKey,
  projects,
  selectedTaskId,
  focusTaskId,
  onSelect,
  onComplete
}: DueGroupProps): React.JSX.Element {
  return (
    <div className="mb-3">
      <div
        className={`mb-1 px-1 text-[10px] font-semibold uppercase tracking-[0.09em] ${
          tone === 'danger' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'
        }`}
      >
        {label} <span className="tabular">· {tasks.length}</span>
      </div>
      <ul className="space-y-0.5">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            todayKey={todayKey}
            selected={selectedTaskId === task.id}
            focused={focusTaskId === task.id}
            project={projects.find((p) => p.id === task.projectId)}
            onSelect={() => onSelect(task.id)}
            onToggleComplete={() => onComplete(task.id)}
          />
        ))}
      </ul>
    </div>
  )
}

export function TaskList(): React.JSX.Element {
  const projects = useTasksStore((s) => s.projects)
  const selectedProjectId = useTasksStore((s) => s.selectedProjectId)
  const smartView = useTasksStore((s) => s.smartView)
  const tasks = useTasksStore((s) => s.tasks)
  const allOpenTasks = useTasksStore((s) => s.allOpenTasks)
  const completedTasks = useTasksStore((s) => s.completedTasks)
  const selectedTaskId = useTasksStore((s) => s.selectedTaskId)
  const focusTaskId = useTasksStore((s) => s.focusTaskId)
  const showCompleted = useTasksStore((s) => s.showCompleted)
  const loading = useTasksStore((s) => s.loading)
  const ready = useTasksStore((s) => s.ready)
  const todayKey = useTasksStore((s) => s.todayKey)

  const selectTask = useTasksStore((s) => s.selectTask)
  const selectSmartView = useTasksStore((s) => s.selectSmartView)
  const createTask = useTasksStore((s) => s.createTask)
  const setTaskCompleted = useTasksStore((s) => s.setTaskCompleted)
  const reorderTasks = useTasksStore((s) => s.reorderTasks)
  const toggleShowCompleted = useTasksStore((s) => s.toggleShowCompleted)

  const [draft, setDraft] = useState('')
  const [dragId, setDragId] = useState<number | null>(null)
  /** Insertion point in the current display order, 0..tasks.length. */
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const smartListRef = useRef<HTMLDivElement>(null)

  const activeProject = projects.find((p) => p.id === selectedProjectId)
  const addTarget = activeProject ?? fallbackProject(projects)
  // A smart view spans every project, same as the cross-project "All tasks" view — both show
  // the row's own project dot, since it is otherwise unknowable from the list alone.
  const crossProject = selectedProjectId === null || smartView !== null

  async function submitDraft(): Promise<void> {
    const title = draft.trim()
    if (!title || !addTarget) return
    setDraft('')
    // Adding from Today should not silently vanish from the view it was typed into.
    await createTask({
      projectId: addTarget.id,
      title,
      ...(smartView === 'today' ? { dueDate: todayKey } : {})
    })
  }

  /**
   * `insertAt` is a slot in the displayed list, 0..length.
   *
   * In the cross-project view the ids span projects, which is fine: main writes
   * `sort_order = index` for exactly the ids given, and every read orders by
   * `sort_order, id`, so a per-project list stays a subsequence of what is on screen.
   */
  function commitOrder(id: number, insertAt: number): void {
    const ids = tasks.map((task) => task.id)
    const from = ids.indexOf(id)
    if (from < 0) return
    // Removing the dragged row first shifts every later slot down by one.
    const to = insertAt > from ? insertAt - 1 : insertAt
    if (to === from || to < 0 || to > ids.length - 1) return
    ids.splice(from, 1)
    ids.splice(to, 0, id)
    void reorderTasks(ids)
  }

  function move(id: number, delta: number): void {
    const index = tasks.findIndex((task) => task.id === id)
    if (index < 0) return
    commitOrder(id, index + (delta > 0 ? 2 : -1))
  }

  /** ↑/↓ walks the rows so the list is navigable without a pointer. */
  function onListKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if (event.altKey) return
    const container = smartView !== null ? smartListRef.current : listRef.current
    const rows = container?.querySelectorAll<HTMLElement>('[data-task-row]')
    if (!rows || rows.length === 0) return
    const current = Array.from(rows).indexOf(document.activeElement as HTMLElement)
    if (current < 0) return
    event.preventDefault()
    const next = rows[current + (event.key === 'ArrowDown' ? 1 : -1)]
    next?.focus()
  }

  function dragFor(task: TaskWithStats, index: number): RowDrag {
    return {
      dragging: dragId === task.id,
      dropAbove: dragId !== null && dropIndex === index,
      dropBelow: dragId !== null && dropIndex === tasks.length && index === tasks.length - 1,
      onDragStart: (event: DragEvent<HTMLElement>) => {
        setDragId(task.id)
        event.dataTransfer.effectAllowed = 'move'
        // Some platforms cancel a drag that carries no payload at all.
        event.dataTransfer.setData('text/plain', String(task.id))
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (dragId === null) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const box = event.currentTarget.getBoundingClientRect()
        const below = event.clientY > box.top + box.height / 2
        setDropIndex(below ? index + 1 : index)
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        event.preventDefault()
        if (dragId !== null && dropIndex !== null) commitOrder(dragId, dropIndex)
        setDragId(null)
        setDropIndex(null)
      },
      onDragEnd: () => {
        setDragId(null)
        setDropIndex(null)
      }
    }
  }

  const initialLoad = loading && !ready

  // ── Smart views ──────────────────────────────────────────────────────────────
  if (smartView !== null) {
    const today = smartView === 'today' ? selectToday(allOpenTasks, todayKey) : null
    const upcomingDays = smartView === 'upcoming' ? selectUpcoming(allOpenTasks, todayKey) : []
    const todayOpenCount = today ? today.overdue.length + today.today.length : 0
    const upcomingOpenCount = upcomingDays.reduce((n, day) => n + day.tasks.length, 0)
    const openCount = smartView === 'today' ? todayOpenCount : upcomingOpenCount
    const isEmpty = !initialLoad && openCount === 0

    return (
      <section className="flex h-full min-h-0 flex-col">
        <header className="flex items-baseline gap-2.5 px-4 pb-2.5 pt-3.5">
          <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-tight">
            {smartView === 'today' ? 'Today' : 'Upcoming'}
          </h2>
          <span className="tabular shrink-0 text-[12px] text-[var(--color-text-muted)]">
            {openCount} open
          </span>
        </header>

        <div className="px-4 pb-2.5">
          <div className="relative">
            <PlusIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input
              className={`${FIELD} pl-8`}
              placeholder={
                addTarget
                  ? `Add a task${smartView === 'today' ? ', due today' : ''} — Enter to save`
                  : 'Create a project first'
              }
              aria-label="Add a task"
              disabled={!addTarget}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitDraft()
                if (e.key === 'Escape') setDraft('')
              }}
            />
          </div>
          {addTarget ? (
            <p className="mt-1 px-1 text-[11px] text-[var(--color-text-muted)]">
              Goes to {addTarget.name}
              {smartView === 'today' ? ', due today' : ''}.
            </p>
          ) : null}
        </div>

        <div
          ref={smartListRef}
          className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4"
          onKeyDown={onListKeyDown}
        >
          {initialLoad ? (
            <ul className="space-y-1.5 px-1.5" aria-hidden="true">
              {[0, 1, 2].map((n) => (
                <li
                  key={n}
                  className="h-11 animate-pulse rounded-lg bg-[var(--color-surface-raised)]/60"
                />
              ))}
            </ul>
          ) : null}

          {isEmpty && smartView === 'today' ? (
            <div className="mt-8 flex flex-col items-center px-6 text-center">
              <EmptyListIcon className="h-9 w-9 text-[var(--color-text-muted)]/50" />
              <p className="mt-3 text-[13px] text-[var(--color-text)]">Nothing due today.</p>
              {(() => {
                const upcomingCount = countUpcoming(allOpenTasks, todayKey)
                return upcomingCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => void selectSmartView('upcoming')}
                    className="mt-1 text-[12px] text-[var(--color-focus)] outline-none hover:underline focus-visible:underline"
                  >
                    {upcomingCount} upcoming
                  </button>
                ) : (
                  <p className="mt-1 max-w-64 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                    Nothing scheduled in the next 7 days either.
                  </p>
                )
              })()}
            </div>
          ) : null}

          {isEmpty && smartView === 'upcoming' ? (
            <div className="mt-8 flex flex-col items-center px-6 text-center">
              <EmptyListIcon className="h-9 w-9 text-[var(--color-text-muted)]/50" />
              <p className="mt-3 text-[13px] text-[var(--color-text)]">
                Nothing due in the next 7 days.
              </p>
            </div>
          ) : null}

          {!initialLoad && today && (today.overdue.length > 0 || today.today.length > 0) ? (
            <>
              {today.overdue.length > 0 ? (
                <DueGroup
                  label="Overdue"
                  tone="danger"
                  tasks={today.overdue}
                  todayKey={todayKey}
                  projects={projects}
                  selectedTaskId={selectedTaskId}
                  focusTaskId={focusTaskId}
                  onSelect={(id) => void selectTask(id)}
                  onComplete={(id) => void setTaskCompleted(id, true)}
                />
              ) : null}
              {today.today.length > 0 ? (
                <DueGroup
                  label={formatDueGroupLabel(todayKey) ?? 'Today'}
                  tasks={today.today}
                  todayKey={todayKey}
                  projects={projects}
                  selectedTaskId={selectedTaskId}
                  focusTaskId={focusTaskId}
                  onSelect={(id) => void selectTask(id)}
                  onComplete={(id) => void setTaskCompleted(id, true)}
                />
              ) : null}
            </>
          ) : null}

          {!initialLoad
            ? upcomingDays.map((day) => (
                <DueGroup
                  key={day.dateKey}
                  label={formatDueGroupLabel(day.dateKey) ?? day.dateKey}
                  tasks={day.tasks}
                  todayKey={todayKey}
                  projects={projects}
                  selectedTaskId={selectedTaskId}
                  focusTaskId={focusTaskId}
                  onSelect={(id) => void selectTask(id)}
                  onComplete={(id) => void setTaskCompleted(id, true)}
                />
              ))
            : null}
        </div>
      </section>
    )
  }

  // ── Project / "All tasks" view ───────────────────────────────────────────────
  const openCount = tasks.length

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex items-baseline gap-2.5 px-4 pb-2.5 pt-3.5">
        <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-tight">
          {activeProject ? (
            <span className="inline-flex items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: activeProject.color }}
              />
              {activeProject.name}
            </span>
          ) : (
            'All tasks'
          )}
        </h2>
        <span className="tabular shrink-0 text-[12px] text-[var(--color-text-muted)]">
          {openCount} open
        </span>
      </header>

      <div className="px-4 pb-2.5">
        <div className="relative">
          <PlusIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            className={`${FIELD} pl-8`}
            placeholder={
              addTarget ? `Add a task to ${addTarget.name} — Enter to save` : 'Create a project first'
            }
            aria-label="Add a task"
            disabled={!addTarget}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitDraft()
              if (e.key === 'Escape') setDraft('')
            }}
          />
        </div>
        {crossProject && addTarget ? (
          <p className="mt-1 px-1 text-[11px] text-[var(--color-text-muted)]">
            No project selected, so new tasks go to {addTarget.name}.
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
        {initialLoad ? (
          <ul className="space-y-1.5 px-1.5" aria-hidden="true">
            {[0, 1, 2].map((n) => (
              <li
                key={n}
                className="h-11 animate-pulse rounded-lg bg-[var(--color-surface-raised)]/60"
              />
            ))}
          </ul>
        ) : null}

        {!initialLoad && openCount === 0 ? (
          <div className="mt-8 flex flex-col items-center px-6 text-center">
            <EmptyListIcon className="h-9 w-9 text-[var(--color-text-muted)]/50" />
            <p className="mt-3 text-[13px] text-[var(--color-text)]">
              {addTarget ? `Nothing open in ${activeProject ? activeProject.name : 'any project'}.` : 'No projects yet.'}
            </p>
            <p className="mt-1 max-w-64 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
              {addTarget
                ? 'Type in the box above and press Enter. Click a task afterwards to point the timer at it.'
                : 'Create a project in the sidebar, then add your first task.'}
            </p>
          </div>
        ) : null}

        {openCount > 0 ? (
          <ul
            ref={listRef}
            className="space-y-0.5"
            onKeyDown={onListKeyDown}
            onDragOver={(event) => {
              // Keeps the cursor a "move" cursor over the gaps between rows.
              if (dragId !== null) event.preventDefault()
            }}
          >
            {tasks.map((task, index) => (
              <TaskRow
                key={task.id}
                task={task}
                todayKey={todayKey}
                selected={selectedTaskId === task.id}
                focused={focusTaskId === task.id}
                project={crossProject ? projects.find((p) => p.id === task.projectId) : undefined}
                onSelect={() => void selectTask(task.id)}
                onToggleComplete={() => void setTaskCompleted(task.id, true)}
                onMove={(delta) => move(task.id, delta)}
                drag={dragFor(task, index)}
              />
            ))}
          </ul>
        ) : null}

        {completedTasks.length > 0 || showCompleted ? (
          <div className="mt-4 border-t border-[var(--color-border)] pt-3">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-1.5 rounded-md px-1.5"
              aria-expanded={showCompleted}
              onClick={() => void toggleShowCompleted()}
            >
              <ChevronIcon open={showCompleted} />
              <SectionLabel>
                Completed{completedTasks.length > 0 ? ` · ${completedTasks.length}` : ''}
              </SectionLabel>
            </Button>

            {showCompleted ? (
              completedTasks.length > 0 ? (
                <ul className="mt-1 space-y-0.5">
                  {completedTasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      completed
                      todayKey={todayKey}
                      selected={selectedTaskId === task.id}
                      focused={focusTaskId === task.id}
                      project={crossProject ? projects.find((p) => p.id === task.projectId) : undefined}
                      onSelect={() => void selectTask(task.id)}
                      onToggleComplete={() => void setTaskCompleted(task.id, false)}
                    />
                  ))}
                </ul>
              ) : (
                <p className="px-2 py-2 text-[12px] text-[var(--color-text-muted)]">
                  Nothing finished here yet.
                </p>
              )
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}
