/**
 * What this session is being logged against. Read-only by design — picking a task belongs to
 * the task list, and a second picker here would be a second place for the selection to get out
 * of sync. The only action offered is detaching.
 */

import { PRIORITY_VAR } from '../../lib/format'
import { timerActions } from '../../stores/timer'
import { TargetIcon, XIcon } from './icons'
import { useCurrentTask } from './useCurrentTask'

export function TaskChip(): React.JSX.Element {
  const { taskId, task } = useCurrentTask()
  const attached = taskId != null

  // An ellipsis rather than "Loading…": the fetch resolves in a frame or two and a word that
  // appears and vanishes draws more attention than the title it is standing in for.
  const label = attached ? (task?.title ?? '…') : 'No task'

  return (
    <div
      className={`flex h-8 max-w-[320px] items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-raised)] pl-3 text-[12px] ${
        attached ? 'pr-1' : 'pr-3'
      }`}
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
        title={attached ? (task?.title ?? undefined) : undefined}
      >
        {label}
      </span>

      {attached && (
        <button
          type="button"
          aria-label="Detach task from timer"
          title="Detach task"
          onClick={() => timerActions.setTask(null)}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[var(--color-text-muted)] outline-none transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--color-danger)_16%,transparent)] hover:text-[var(--color-danger)] focus-visible:ring-2 focus-visible:ring-[var(--color-text-muted)]/40 active:scale-95"
        >
          <XIcon className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}
