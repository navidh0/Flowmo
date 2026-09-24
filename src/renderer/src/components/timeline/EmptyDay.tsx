/** Nothing logged and nothing on the calendar for this day — a short message, not a bare
 *  grid with no content to anchor it. */

import { CalendarEmptyIcon } from './icons'

export function EmptyDay(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <CalendarEmptyIcon className="h-10 w-10 shrink-0 text-[var(--color-text-muted)]" />
      <div>
        <p className="text-[13px] font-medium text-[var(--color-text)]">Nothing on this day</p>
        <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
          No logged sessions or calendar events. Start a focus session and it will show up here.
        </p>
      </div>
    </div>
  )
}
