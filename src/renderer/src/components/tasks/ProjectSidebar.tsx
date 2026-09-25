/**
 * Project picker. Mounts as its own column so the shell can place it beside the timer.
 *
 * Counts come straight from the store's `openCounts` / `openTotal`, which are tallied from
 * one full read of the open list — the sidebar never counts anything itself, so a badge
 * cannot disagree with the list next to it.
 */

import { useState } from 'react'
import type { Project } from '@shared/types'
import { IconButton } from '@renderer/components/timer/Button'
import { XIcon } from '@renderer/components/timer/icons'
import { useTasksStore } from '@renderer/stores/tasks'
import { useTasksBootstrap } from './bootstrap'
import {
  CheckIcon,
  PencilIcon,
  PlusIcon,
  StackIcon,
  TodayIcon,
  TodoistIcon,
  TrashIcon,
  UpcomingIcon
} from './icons'
import { FIELD, HOVER_ACTION, InlineConfirm, SectionLabel } from './ui'
import { countToday, countUpcoming } from './views'

/** Matches the palette main cycles through, so the swatches are the colours it can assign. */
const SWATCHES = [
  '#6366f1',
  '#22c55e',
  '#f59e0b',
  '#ec4899',
  '#06b6d4',
  '#a855f7',
  '#ef4444',
  '#84cc16'
] as const

const ROW =
  'group relative flex w-full items-center gap-2.5 rounded-md px-2 py-[7px] text-left ' +
  'text-[13px] outline-none transition-colors focus-visible:ring-1 ' +
  'focus-visible:ring-[var(--color-focus)]/60'

function Badge({ count, active }: { count: number; active: boolean }): React.JSX.Element | null {
  if (count === 0) return null
  return (
    <span
      className={`tabular shrink-0 text-[11px] ${
        active ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'
      }`}
    >
      {count}
    </span>
  )
}

export function ProjectSidebar(): React.JSX.Element {
  useTasksBootstrap()

  const projects = useTasksStore((s) => s.projects)
  const openCounts = useTasksStore((s) => s.openCounts)
  const openTotal = useTasksStore((s) => s.openTotal)
  const allOpenTasks = useTasksStore((s) => s.allOpenTasks)
  const todayKey = useTasksStore((s) => s.todayKey)
  const smartView = useTasksStore((s) => s.smartView)
  const selectedProjectId = useTasksStore((s) => s.selectedProjectId)
  const selectProject = useTasksStore((s) => s.selectProject)
  const selectSmartView = useTasksStore((s) => s.selectSmartView)
  const createProject = useTasksStore((s) => s.createProject)
  const updateProject = useTasksStore((s) => s.updateProject)
  const deleteProject = useTasksStore((s) => s.deleteProject)

  const todayCount = countToday(allOpenTasks, todayKey)
  const upcomingCount = countUpcoming(allOpenTasks, todayKey)

  const [adding, setAdding] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [confirmingId, setConfirmingId] = useState<number | null>(null)

  function closeEditors(): void {
    setAdding(false)
    setDraftName('')
    setEditingId(null)
    setConfirmingId(null)
  }

  async function submitNew(): Promise<void> {
    const name = draftName.trim()
    if (!name) {
      setAdding(false)
      return
    }
    const created = await createProject(name)
    setDraftName('')
    // Keep the input open for a second project, but jump to the first one created.
    if (created) await selectProject(created.id)
  }

  async function commitRename(project: Project): Promise<void> {
    const name = editName.trim()
    setEditingId(null)
    if (!name || name === project.name) return
    await updateProject(project.id, { name })
  }

  /**
   * Local projects first, synced ones grouped after under their own label — with a synced
   * and a local project both plausibly named "Inbox", visual grouping is the only thing that
   * tells them apart at a glance.
   */
  const localProjects = projects.filter((p) => p.source !== 'todoist')
  const syncedProjects = projects.filter((p) => p.source === 'todoist')

  function renderProject(project: Project): React.JSX.Element {
    const active = smartView === null && selectedProjectId === project.id
    const editing = editingId === project.id
    // Synced projects are pull-only: Flowdo mirrors them but never renames, archives or
    // deletes them upstream, so those actions are not offered at all here.
    const synced = project.source === 'todoist'

    if (editing) {
      return (
        <div
          key={project.id}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-2"
        >
          <input
            autoFocus
            className={FIELD}
            value={editName}
            aria-label={`Rename ${project.name}`}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename(project)
              if (e.key === 'Escape') setEditingId(null)
            }}
          />
          <div className="mt-2 flex items-center gap-1.5">
            {SWATCHES.map((swatch) => (
              <button
                key={swatch}
                type="button"
                aria-label={`Colour ${swatch}`}
                title={swatch}
                onClick={() => void updateProject(project.id, { color: swatch })}
                className="grid h-4 w-4 place-items-center rounded-full outline-none ring-offset-2 ring-offset-[var(--color-surface-raised)] transition-transform hover:scale-110 focus-visible:ring-1 focus-visible:ring-[var(--color-text-muted)]"
                style={{ backgroundColor: swatch }}
              >
                {project.color.toLowerCase() === swatch ? (
                  <CheckIcon className="h-2.5 w-2.5 text-[var(--color-on-accent)]" />
                ) : null}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void commitRename(project)}
              className="ml-auto text-[11px] text-[var(--color-text-muted)] outline-none hover:text-[var(--color-text)] focus-visible:text-[var(--color-text)]"
            >
              Done
            </button>
          </div>
        </div>
      )
    }

    return (
      <div key={project.id}>
        <div
          className={`${ROW} ${
            active
              ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)]'
              : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]/60 hover:text-[var(--color-text)]'
          }`}
        >
          <button
            type="button"
            aria-current={active}
            onClick={() => void selectProject(project.id)}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded text-left outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-focus)]/60"
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: project.color }}
            />
            <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>
            {synced ? (
              <span
                className="shrink-0 text-[var(--color-text-muted)]"
                title="Synced from Todoist — pulled in, never renamed, archived or deleted from here"
              >
                <TodoistIcon />
              </span>
            ) : null}
          </button>

          {synced ? null : (
            <div className={`flex shrink-0 items-center gap-0.5 ${HOVER_ACTION}`}>
              <IconButton
                variant="ghost"
                aria-label={`Rename ${project.name}`}
                title="Rename"
                className="h-6 w-6"
                onClick={() => {
                  closeEditors()
                  setEditName(project.name)
                  setEditingId(project.id)
                }}
              >
                <PencilIcon />
              </IconButton>
              <IconButton
                variant="danger"
                aria-label={`Delete ${project.name}`}
                title="Delete"
                className="h-6 w-6"
                onClick={() => {
                  closeEditors()
                  setConfirmingId(project.id)
                }}
              >
                <TrashIcon />
              </IconButton>
            </div>
          )}

          {/* Sits under the hover actions so the count does not fight them for the slot. */}
          <span className={synced ? '' : 'group-hover:hidden group-focus-within:hidden'}>
            <Badge count={openCounts[project.id] ?? 0} active={active} />
          </span>
        </div>

        {confirmingId === project.id && !synced ? (
          <div className="px-1 py-1.5">
            <InlineConfirm
              confirmLabel="Delete project"
              onCancel={() => setConfirmingId(null)}
              onConfirm={() => {
                setConfirmingId(null)
                void deleteProject(project.id)
              }}
              message={
                <>
                  Delete <strong className="font-semibold">{project.name}</strong> and everything
                  in it? This also deletes its tasks{' '}
                  <span className="tabular">
                    ({openCounts[project.id] ?? 0} open, plus any completed)
                  </span>{' '}
                  and all of their subtasks. Focus time you already logged stays in your stats.
                  This cannot be undone.
                </>
              }
            />
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <aside className="flex h-full w-full flex-col bg-[var(--color-surface-sunken)]">
      <div className="flex items-center justify-between px-3 pb-1.5 pt-3">
        <SectionLabel>Projects</SectionLabel>
        <IconButton
          variant="ghost"
          aria-label="New project"
          title="New project"
          className="h-6 w-6"
          onClick={() => {
            closeEditors()
            setAdding(true)
          }}
        >
          <PlusIcon />
        </IconButton>
      </div>

      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        <button
          type="button"
          aria-current={smartView === 'today'}
          onClick={() => void selectSmartView('today')}
          className={`${ROW} ${
            smartView === 'today'
              ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)]'
              : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]/60 hover:text-[var(--color-text)]'
          }`}
        >
          <TodayIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Today</span>
          <Badge count={todayCount} active={smartView === 'today'} />
        </button>

        <button
          type="button"
          aria-current={smartView === 'upcoming'}
          onClick={() => void selectSmartView('upcoming')}
          className={`${ROW} ${
            smartView === 'upcoming'
              ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)]'
              : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]/60 hover:text-[var(--color-text)]'
          }`}
        >
          <UpcomingIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Upcoming</span>
          <Badge count={upcomingCount} active={smartView === 'upcoming'} />
        </button>

        <div className="my-1 border-t border-[var(--color-border)]" />

        <button
          type="button"
          aria-current={smartView === null && selectedProjectId === null}
          onClick={() => void selectProject(null)}
          className={`${ROW} ${
            smartView === null && selectedProjectId === null
              ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)]'
              : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]/60 hover:text-[var(--color-text)]'
          }`}
        >
          <StackIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">All tasks</span>
          <Badge count={openTotal} active={smartView === null && selectedProjectId === null} />
        </button>

        {localProjects.map(renderProject)}

        {syncedProjects.length > 0 ? (
          <div className="px-1 pb-0.5 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-text-muted)]/70">
            Todoist
          </div>
        ) : null}
        {syncedProjects.map(renderProject)}

        {adding ? (
          <div className="flex items-center gap-1.5 px-1 pt-1">
            <input
              autoFocus
              className={FIELD}
              placeholder="Project name"
              aria-label="New project name"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitNew()
                if (e.key === 'Escape') {
                  setDraftName('')
                  setAdding(false)
                }
              }}
            />
            <IconButton
              variant="ghost"
              aria-label="Cancel"
              title="Cancel"
              className="h-7 w-7 shrink-0"
              onClick={() => {
                setDraftName('')
                setAdding(false)
              }}
            >
              <XIcon />
            </IconButton>
          </div>
        ) : null}

        {projects.length === 0 && !adding ? (
          <p className="px-2 pt-2 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
            No projects. A task has to live in one — create the first with the{' '}
            <span className="text-[var(--color-text)]">+</span> above.
          </p>
        ) : null}
      </nav>
    </aside>
  )
}
