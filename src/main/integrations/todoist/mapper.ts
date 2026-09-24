/**
 * Pure mapping helpers between Flowdo's model and the Todoist wire format.
 *
 * No I/O, no SQLite — everything here is a plain function so it can be unit-tested
 * without a database or a network.
 */

import type { Priority } from '@shared/types'
import { wallClockInZone } from '../../db'
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
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

/**
 * Todoist's fixed 20-colour palette (`id`, `name`, hex), verified against the "Colors"
 * section of https://developer.todoist.com/api/v1/ (2026-09-24, curled directly — this
 * table lives in a guide fragment the rendered SPA loads separately from the main
 * reference, which is why the earlier due-dates verification pass didn't surface it).
 * Projects (and labels/filters) are returned with the *name* column, e.g. `"charcoal"`,
 * never the hex Flowdo's `Project.color` contract requires.
 */
const TODOIST_COLOR_HEX: Readonly<Record<string, string>> = {
  berry_red: '#B8255F',
  red: '#DC4C3E',
  orange: '#C77100',
  yellow: '#B29104',
  olive_green: '#949C31',
  lime_green: '#65A33A',
  green: '#369307',
  mint_green: '#42A393',
  teal: '#148FAD',
  sky_blue: '#319DC0',
  light_blue: '#6988A4',
  blue: '#4180FF',
  grape: '#692EC2',
  violet: '#CA3FEE',
  lavender: '#A4698C',
  magenta: '#E05095',
  salmon: '#C9766F',
  charcoal: '#808080',
  grey: '#999999',
  taupe: '#8F7A69'
}

/** Falls back to charcoal's hex for anything unrecognised — never propagates a bare
 *  colour name (or garbage) into `Project.color`, which the contract requires to be
 *  `#rrggbb`; the sidebar dot and stats breakdown render nothing for anything else. */
const UNKNOWN_COLOR_HEX = '#808080'

export function toProjectColorHex(remoteColor: string | null | undefined): string {
  if (!remoteColor) return UNKNOWN_COLOR_HEX
  if (HEX_COLOR.test(remoteColor)) return remoteColor
  return TODOIST_COLOR_HEX[remoteColor] ?? UNKNOWN_COLOR_HEX
}

/**
 * The calendar day a Todoist `due.date` string falls on, or `null` if the string cannot
 * be parsed as a date at all.
 *
 * - Date-only ('YYYY-MM-DD') is the day, verbatim.
 * - A floating datetime (no trailing 'Z'/offset) has no attached zone — its date part
 *   *is* the day, in every timezone, by definition.
 * - A zoned datetime is a real instant. Todoist dates it in the due's OWN `timezone`
 *   (the zone the user actually set it in), which is not necessarily the host machine's
 *   zone — a task due at 23:45 in Asia/Tehran is 00:15 the next day in Asia/Dubai, a real
 *   case that filed a task under the wrong day when this only looked at the host clock.
 *   `timezone` is read via `wallClockInZone` (never via SQL date()/strftime(), which
 *   assume UTC); only when it is absent or not a valid IANA name does this fall back to
 *   the HOST's local clock, as before.
 *
 * A malformed offset string (one `Date` can't parse) must never produce the literal text
 * "NaN-NaN-NaN" into `tasks.due_date` — that degrades to `null` (no due date) instead.
 */
export function calendarDayFromDue(dateStr: string, timezone?: string | null): string | null {
  if (DATE_ONLY.test(dateStr)) return dateStr
  if (!HAS_OFFSET.test(dateStr)) return dateStr.slice(0, 10)
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return null

  if (timezone) {
    const wall = wallClockInZone(d.getTime(), timezone)
    if (wall) return wall.dateKey
    // Invalid/unrecognised IANA name: fall through to the host-local reading below.
  }

  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function dueDateFromRemote(due: RemoteDue | null): string | null {
  if (!due) return null
  return calendarDayFromDue(due.date, due.timezone)
}

/** The wall-clock time of day a `due.date` string carries, or null for a date-only due
 *  (midnight has no meaning to preserve). For a zoned datetime, converts the UTC instant
 *  to wall time in the due's OWN `timezone` — the zone the user actually set it in, which
 *  can differ from the host machine's zone (see `calendarDayFromDue`). Falls back to the
 *  host's local clock only when `timezone` is absent or not a valid IANA name — never to
 *  UTC, which would silently be wrong for both. */
function timeOfDay(dateStr: string, timezone: string | null | undefined): { h: number; m: number; s: number } | null {
  if (!HAS_TIME.test(dateStr)) return null
  if (!HAS_OFFSET.test(dateStr)) {
    const match = /T(\d{2}):(\d{2}):(\d{2})/.exec(dateStr)
    if (!match) return null
    return { h: Number(match[1]), m: Number(match[2]), s: Number(match[3]) }
  }
  const instant = new Date(dateStr)
  if (Number.isNaN(instant.getTime())) return null

  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }).formatToParts(instant)
      const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0')
      return { h: get('hour') % 24, m: get('minute'), s: get('second') }
    } catch {
      // Invalid/unrecognised IANA name: fall through to the host-local reading below.
    }
  }

  return { h: instant.getHours(), m: instant.getMinutes(), s: instant.getSeconds() }
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
  // Only treat this as a real zoned conversion when there is an actual timezone string to
  // convert with — a zoned datetime that's missing one (malformed data) degrades to being
  // handled like a floating time below rather than passing `null` into `zonedWallTimeToUtcIso`.
  const zoned = time !== null && HAS_OFFSET.test(previous.date) && typeof previous.timezone === 'string'

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
