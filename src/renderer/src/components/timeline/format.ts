/**
 * Timeline-only formatting helpers. Kept here rather than `lib/format.ts` per this
 * directory's ownership brief — nothing else needs a bare hour label or a time range.
 */

import { zoneLabel } from '@shared/types'

/**
 * `HH:MM`, 24-hour, zero-padded — the ONE time-of-day format for this whole screen (hour
 * gutter, month chips, block tooltips). Matches the rest of the app (the timer, task due
 * times like `19:30`); Day and Week used to disagree (`8 AM` vs `08:00`) before this was
 * the single formatter every view calls through.
 */
export function formatClockTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** `08:00` for an hour-grid line, given the bare local hour (0-23) rather than a full
 *  instant — used by Day and Week, whose gridlines only ever land on the hour. */
export function formatHourMark(hour: number): string {
  return `${String(((hour % 24) + 24) % 24).padStart(2, '0')}:00`
}

/** `08:00 – 09:15`, or with a "continues" note when the range was clipped. */
export function formatTimeRange(startMs: number, endMs: number, continues: boolean): string {
  const range = `${formatClockTime(startMs)} – ${formatClockTime(endMs)}`
  return continues ? `${range} (continues past midnight)` : range
}

/** `HH:MM` for `ms` as read in `timeZone`, using `Intl.DateTimeFormat` directly (not
 *  `toLocaleTimeString`, whose `hour12: false` has shipped `24:00`-at-midnight bugs in some
 *  engines) — `hourCycle: 'h23'` plus `formatToParts` sidesteps that and any locale-specific
 *  separator. Returns `null` if the zone name is invalid, so callers can fall back quietly. */
function formatInZone(ms: number, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(ms))
    const hour = parts.find((p) => p.type === 'hour')?.value
    const minute = parts.find((p) => p.type === 'minute')?.value
    return hour && minute ? `${hour}:${minute}` : null
  } catch {
    return null
  }
}

/**
 * An event's start, in local time — and ALSO in its own zone when that reads differently,
 * e.g. `07:15 Tehran · 07:45 local`. Positioning on the grid always stays by the instant
 * (the host clock), exactly as for a session; this only affects the LABEL, for an event
 * whose organiser meant a specific wall-clock time in a zone that isn't this computer's.
 *
 * Shows just the local time when `timeZone` is null (no zone recorded — floating/UTC) or
 * when the two zones happen to read the same wall-clock time (e.g. Dubai and Muscat, both
 * UTC+4): nothing to disambiguate, so nothing extra to show.
 */
export function formatEventStart(ms: number, timeZone: string | null): string {
  const local = formatClockTime(ms)
  if (!timeZone) return local

  const zoned = formatInZone(ms, timeZone)
  if (!zoned || zoned === local) return local

  return `${zoned} ${zoneLabel(timeZone)} · ${local} local`
}

/** `Monday, 3 August 2026` for the Day header. */
export function formatDayHeading(dayMs: number): string {
  return new Date(dayMs).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })
}

/** `Mon 21` for a Week column header. */
export function formatColumnHeading(dayMs: number): string {
  return new Date(dayMs).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
}

/** The Week header, with both ends' weekday names: `Mon, 1 Jun – Sun, 7 Jun 2026` in en-GB,
 *  `Mon, Jun 1 – Sun, Jun 7, 2026` in en-US. `Intl.DateTimeFormat#formatRange` collapses the
 *  shared month/year and orders the parts the way the user's locale expects — assembling
 *  the two ends separately put the weekday after the day in en-US ("1 Mon – …"). A week
 *  that crosses a month or a year keeps both ends' month or year. `weekStartMs`/`weekEndMs`
 *  are the week's bounds (`end` exclusive). */
export function formatWeekHeading(weekStartMs: number, weekEndMs: number): string {
  const lastInclusive = weekEndMs - 1 // any instant in the week's last day
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).formatRange(weekStartMs, lastInclusive)
}

/** `June 2026` for the Month header. */
export function formatMonthHeading(monthMs: number): string {
  return new Date(monthMs).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}
