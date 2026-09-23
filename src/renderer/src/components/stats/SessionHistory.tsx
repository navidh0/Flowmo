/**
 * Recent logged sessions with per-row delete. Independent of the selected range — it is a
 * recency view, not filtered to match the summary above, same as the completed-tasks list
 * in the tasks panel.
 */

import type { Session } from '@shared/types'
import { IconButton } from '@renderer/components/timer/Button'
import { formatDuration } from '@renderer/lib/format'
import { TrashIcon } from './icons'

const KIND_LABEL: Record<Session['kind'], string> = {
  focus: 'Focus',
  short_break: 'Short break',
  long_break: 'Long break'
}

function formatWhen(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return time
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`
}

export interface SessionHistoryProps {
  sessions: Session[]
  onRemove: (id: number) => void
}

export function SessionHistory({ sessions, onRemove }: SessionHistoryProps): React.JSX.Element {
  if (sessions.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3.5 py-6 text-center text-[12px] text-[var(--color-text-muted)]">
        No sessions logged yet.
      </div>
    )
  }

  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)]">
      <h3 className="border-b border-[var(--color-border)] px-3.5 py-2.5 text-[12px] font-medium text-[var(--color-text)]">
        Recent sessions
      </h3>
      <ul className="max-h-72 divide-y divide-[var(--color-border)] overflow-y-auto">
        {sessions.map((session) => (
          <li
            key={session.id}
            className="group flex min-w-0 items-center gap-2.5 px-3.5 py-2 text-[12px]"
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                session.kind === 'focus'
                  ? session.completed
                    ? 'bg-[var(--color-focus)]'
                    : 'bg-[var(--color-text-muted)]'
                  : 'bg-[var(--color-break)]'
              }`}
              title={
                session.kind === 'focus' && !session.completed ? 'Abandoned' : KIND_LABEL[session.kind]
              }
            />
            <span className="w-24 shrink-0 truncate text-[var(--color-text-muted)]">
              {formatWhen(session.startedAt)}
            </span>
            <span className="w-24 shrink-0 truncate text-[var(--color-text)]">
              {KIND_LABEL[session.kind]}
            </span>
            <span className="min-w-0 flex-1 truncate text-right tabular text-[var(--color-text-muted)]">
              {formatDuration(session.actualMs)}
              {session.kind === 'focus' && !session.completed ? ' (stopped early)' : ''}
            </span>
            <IconButton
              variant="danger"
              aria-label="Delete session"
              title="Delete session"
              onClick={() => onRemove(session.id)}
              className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            >
              <TrashIcon />
            </IconButton>
          </li>
        ))}
      </ul>
    </div>
  )
}
