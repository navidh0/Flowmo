/**
 * Pure mapping helpers between Flowdo's model and the Todoist wire format.
 *
 * No I/O, no SQLite — everything here is a plain function so it can be unit-tested
 * without a database or a network.
 */

import type { Priority } from '@shared/types'
import type { RemoteDue } from './wire-types'

/** Todoist 4 = urgent, Flowdo 1 = highest. The formula is its own inverse. */
export function toRemotePriority(local: Priority): number {
  return 5 - local
}

export function toLocalPriority(remote: number): Priority {
  const p = 5 - remote
  if (p === 1 || p === 2 || p === 3 || p === 4) return p
  return 3
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/
const HAS_TIME = /^\d{4}-\d{2}-\d{2}T/

/**
 * The local calendar day a Todoist `due.date` string falls on, or `null` if the string
 * cannot be parsed as a date at all.
 *
 * - Date-only ('YYYY-MM-DD') is the day, verbatim.
 * - A floating datetime (no trailing 'Z'/offset) has no attached zone — its date part
 *   *is* the day, in every timezone, by definition.
 * - A zoned datetime is a real instant; the day is whatever the host's local clock reads
 *   at that instant, computed in JS (never via SQL date()/strftime(), which assume UTC).
 *
 * A malformed offset string (one `Date` can't parse) must never produce the literal text
 * "NaN-NaN-NaN" into `tasks.due_date` — that degrades to `null` (no due date) instead.
 */
export function calendarDayFromDue(dateStr: string): string | null {
  if (DATE_ONLY.test(dateStr)) return dateStr
  if (!HAS_OFFSET.test(dateStr)) return dateStr.slice(0, 10)
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function dueDateFromRemote(due: RemoteDue | null): string | null {
  if (!due) return null
  return calendarDayFromDue(due.date)
}

/** The local wall-clock time of day a `due.date` string carries, or null for a date-only
 *  due (midnight has no meaning to preserve). For a zoned datetime, converts the UTC
 *  instant to wall time in `timezone` via `Intl` — never a manual UTC-offset guess. */
function timeOfDay(dateStr: string, timezone: string | null | undefined): { h: number; m: number; s: number } | null {
  if (!HAS_TIME.test(dateStr)) return null
  if (!HAS_OFFSET.test(dateStr)) {
    const match = /T(\d{2}):(\d{2}):(\d{2})/.exec(dateStr)
    if (!match) return null
    return { h: Number(match[1]), m: Number(match[2]), s: Number(match[3]) }
  }
  const instant = new Date(dateStr)
  if (Number.isNaN(instant.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone ?? 'UTC',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(instant)
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0')
  return { h: get('hour') % 24, m: get('minute'), s: get('second') }
}

/**
 * The UTC instant (RFC 3339, 'Z'-suffixed) at which the wall clock in `timezone` reads
 * the given local date/time — the inverse of `timeOfDay` for a zoned due. Converges in at
 * most two passes: guess as if the wall time were already UTC, see what that guess reads
 * as in the target zone, and correct by the difference (handles a DST boundary falling
 * between the two).
 */
function zonedWallTimeToUtcIso(y: number, month: number, day: number, h: number, m: number, s: number, timezone: string): string {
  let guessMs = Date.UTC(y, month - 1, day, h, m, s)
  const target = Date.UTC(y, month - 1, day, h, m, s)
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).formatToParts(new Date(guessMs))
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0')
    const shownMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
    guessMs += target - shownMs
  }
  return new Date(guessMs).toISOString()
}

/**
 * Build the `due` argument for a push where `dueDate` actually changed, preserving
 * whatever else the original due had — verified against the "Due dates" section of
 * https://developer.todoist.com/api/v1/ (2026-09-24; the docs are a client-rendered SPA,
 * fetched directly with curl and stripped of markup since WebFetch's summary of the
 * rendered page truncated before this section):
 *
 *  - Full-day: `{ date: 'YYYY-MM-DD', timezone: null, string, lang, is_recurring }`.
 *  - Floating datetime: `{ date: 'YYYY-MM-DDTHH:MM:SS', timezone: null, ... }` — "unlike
 *    fixed due dates, the date representation doesn't end with Z".
 *  - Fixed-timezone datetime: `{ date: 'YYYY-MM-DDTHH:MM:SSZ', timezone: '<IANA zone>',
 *    ... }` — "Due date is stored in UTC. timezone [is] used to recalculate properly the
 *    next iteration for a recurring due date."
 *  - "Create or update due dates" documents two DISTINCT update mechanisms: from a
 *    natural-language `string`, or from a raw `date` object — and explicitly warns "this
 *    approach [date-object] does not allow you to create recurring due dates" when `date`
 *    is sent alone. It also says up front "you may provide all fields of an object in the
 *    constructor" — so a recurring update here always resends the ORIGINAL `string`
 *    (which is what actually encodes the recurrence rule) alongside the new `date`,
 *    rather than relying on `date` alone. This combination is not shown as a worked
 *    example in the docs, so it is the best-supported reading rather than a confirmed
 *    example — flagged for a real-account check before relying on it in production.
 *
 * Rules (Wave B review): a day change alone must never destroy a recurrence rule or drop
 * a time. Only clearing the due date (`newDueDate === null`) is allowed to drop everything
 * — the user asked for that explicitly.
 */
export function buildDueForDateChange(newDueDate: string | null, previous: RemoteDue | null): RemoteDue | null {
  if (newDueDate === null) return null
  if (!previous) return { date: newDueDate }

  const time = timeOfDay(previous.date, previous.timezone)
  const zoned = time !== null && HAS_OFFSET.test(previous.date)

  let date: string
  if (time === null) {
    date = newDueDate // date-only: a bare day is all there ever was.
  } else if (zoned) {
    const [y, mo, d] = newDueDate.split('-').map(Number) as [number, number, number]
    date = zonedWallTimeToUtcIso(y, mo, d, time.h, time.m, time.s, previous.timezone as string)
  } else {
    const hh = String(time.h).padStart(2, '0')
    const mm = String(time.m).padStart(2, '0')
    const ss = String(time.s).padStart(2, '0')
    date = `${newDueDate}T${hh}:${mm}:${ss}`
  }

  if (previous.is_recurring !== true) {
    return zoned ? { date, timezone: previous.timezone } : { date }
  }

  const recurring: RemoteDue = { date, is_recurring: true, string: previous.string }
  if (previous.lang !== undefined) recurring.lang = previous.lang
  if (zoned) recurring.timezone = previous.timezone
  return recurring
}
