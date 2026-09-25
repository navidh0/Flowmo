/**
 * The handful of primitives the task surface repeats. Buttons come from
 * `components/timer/Button` so both halves of the window share one button; these are the
 * pieces that surface has no equivalent of.
 */

import type { ReactNode } from 'react'
import { Button } from '@renderer/components/timer/Button'

/** Text inputs everywhere in this surface. Sunken, because it is a well you type into. */
export const FIELD =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-sunken)] ' +
  'px-2.5 py-1.5 text-[13px] text-[var(--color-text)] outline-none ' +
  'placeholder:text-[var(--color-text-muted)]/70 transition-colors ' +
  'hover:border-[var(--color-border-hover)] focus:border-[var(--color-focus)] ' +
  'focus:ring-1 focus:ring-[var(--color-focus)]/40'

/** Row-hover affordances. Also revealed by keyboard focus, or they are unreachable. */
export const HOVER_ACTION =
  'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ' +
  'focus-visible:opacity-100'

export function SectionLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="px-1 text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-text-muted)]">
      {children}
    </div>
  )
}

export interface InlineConfirmProps {
  /** Spell out the consequence. This is the only warning the user gets. */
  message: ReactNode
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Destructive confirmation, inline.
 *
 * Never `window.confirm` here: a native modal in a frameless Electron window steals focus,
 * renders in the OS's own chrome, and reads as a crash rather than a question.
 *
 * Cancel takes the initial focus — the pointer is already over the row that spawned this,
 * and a delete button under the cursor is one stray click from being irreversible.
 */
export function InlineConfirm({
  message,
  confirmLabel,
  onConfirm,
  onCancel
}: InlineConfirmProps): React.JSX.Element {
  return (
    <div
      role="alertdialog"
      aria-label={confirmLabel}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onCancel()
        }
      }}
      className="rounded-md border border-[var(--color-danger)]/45 bg-[color-mix(in_srgb,var(--color-danger)_9%,var(--color-surface-raised))] p-2.5"
    >
      <p className="text-[12px] leading-relaxed text-[var(--color-text)]">{message}</p>
      <div className="mt-2 flex justify-end gap-1.5">
        <Button autoFocus variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={onConfirm}
          className="border-[var(--color-danger)]/50 text-[var(--color-danger)] enabled:hover:border-[var(--color-danger)] enabled:hover:bg-[color-mix(in_srgb,var(--color-danger)_18%,transparent)]"
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  )
}
