/**
 * Subtasks of the task open in the detail panel.
 *
 * The `n/m` header comes from the task row's `subtaskDone`/`subtaskTotal`, not from
 * counting the array below it — those two numbers are derived by main and the list is
 * loaded separately, so counting locally is how they would start to disagree.
 */

import { useState } from 'react'
import type { Subtask } from '@shared/types'
import { IconButton } from '@renderer/components/timer/Button'
import { XIcon } from '@renderer/components/timer/icons'
import { useTasksStore } from '@renderer/stores/tasks'
import { CheckIcon, PlusIcon } from './icons'
import { FIELD, HOVER_ACTION, SectionLabel } from './ui'

export interface SubtaskListProps {
  taskId: number
  done: number
  total: number
}

function Row({ subtask }: { subtask: Subtask }): React.JSX.Element {
  const updateSubtask = useTasksStore((s) => s.updateSubtask)
  const deleteSubtask = useTasksStore((s) => s.deleteSubtask)

  return (
    <li className="group flex items-center gap-2.5 rounded-md px-1 py-1 hover:bg-[var(--color-surface-raised)]">
      <button
        type="button"
        role="checkbox"
        aria-checked={subtask.done}
        aria-label={`${subtask.done ? 'Reopen' : 'Complete'} ${subtask.title}`}
        onClick={() => void updateSubtask(subtask.id, { done: !subtask.done })}
        className={`grid h-[15px] w-[15px] shrink-0 place-items-center rounded-[4px] border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]/45 ${
          subtask.done
            ? 'border-[var(--color-focus)] bg-[var(--color-focus)] text-[var(--color-on-accent)]'
            : 'border-[var(--color-border)] hover:border-[var(--color-text-muted)]'
        }`}
      >
        <CheckIcon
          className={`h-2.5 w-2.5 ${subtask.done ? 'opacity-100' : 'opacity-0 group-hover:opacity-35'}`}
        />
      </button>
      <span
        className={`min-w-0 flex-1 truncate text-[12.5px] ${
          subtask.done
            ? 'text-[var(--color-text-muted)] line-through decoration-[var(--color-text-muted)]/60'
            : 'text-[var(--color-text)]'
        }`}
        title={subtask.title}
      >
        {subtask.title}
      </span>
      <IconButton
        variant="danger"
        aria-label={`Delete ${subtask.title}`}
        title="Delete subtask"
        className={`h-6 w-6 shrink-0 ${HOVER_ACTION}`}
        onClick={() => void deleteSubtask(subtask.id)}
      >
        <XIcon />
      </IconButton>
    </li>
  )
}

export function SubtaskList({ taskId, done, total }: SubtaskListProps): React.JSX.Element {
  const subtasks = useTasksStore((s) => s.subtasks)
  const createSubtask = useTasksStore((s) => s.createSubtask)
  const [draft, setDraft] = useState('')

  async function submit(): Promise<void> {
    const title = draft.trim()
    if (!title) return
    setDraft('')
    await createSubtask(taskId, title)
  }

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <SectionLabel>Subtasks</SectionLabel>
        {total > 0 ? (
          <span className="tabular text-[11px] text-[var(--color-text-muted)]">
            {done}/{total}
          </span>
        ) : null}
      </div>

      {subtasks.length > 0 ? (
        <ul className="mb-1.5 space-y-px">
          {subtasks.map((subtask) => (
            <Row key={subtask.id} subtask={subtask} />
          ))}
        </ul>
      ) : null}

      <div className="relative">
        <PlusIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--color-text-muted)]" />
        <input
          className={`${FIELD} pl-7 text-[12.5px]`}
          placeholder="Add a step — Enter to save"
          aria-label="Add a subtask"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
            if (e.key === 'Escape') setDraft('')
          }}
        />
      </div>
    </div>
  )
}
