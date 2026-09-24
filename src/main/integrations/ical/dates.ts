/**
 * Calendar-day arithmetic for iCal feeds, always through local `Date` getters/setters —
 * never `toISOString()` (UTC) and never SQL `date()`/`strftime()` (which treats an epoch
 * value as UTC). See CLAUDE.md: "Calendar boundaries are computed in JS, never in SQL."
 */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 'YYYY-MM-DD' in the host's local time zone. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** Local midnight of the day containing `ms`. */
export function startOfLocalDay(ms: number): Date {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** `d` shifted by `days` local calendar days, via `setDate` so a DST jump cannot drift it. */
export function addLocalDays(d: Date, days: number): Date {
  const copy = new Date(d)
  copy.setDate(copy.getDate() + days)
  return copy
}

/** The reverse of `dayKey`: local midnight of the day named by a 'YYYY-MM-DD' key. */
export function localDateKeyToMs(key: string): number {
  const parts = key.split('-')
  const year = Number(parts[0] ?? '1970')
  const month = Number(parts[1] ?? '1')
  const day = Number(parts[2] ?? '1')
  return new Date(year, month - 1, day).getTime()
}

/**
 * The window a feed is expanded over on every refresh:
 * [local today - pastDays, local today + futureDays], as a half-open [fromMs, toMs) instant
 * range.
 */
export function refreshWindow(
  nowMs: number,
  pastDays = 14,
  futureDays = 60
): { fromMs: number; toMs: number } {
  const today = startOfLocalDay(nowMs)
  const fromMs = addLocalDays(today, -pastDays).getTime()
  // Exclusive end, one day past the last day the window is meant to include.
  const toMs = addLocalDays(today, futureDays + 1).getTime()
  return { fromMs, toMs }
}

/**
 * The local calendar days that [fromMs, toMs) touches, as a half-open day-key range
 * [firstDayKey, dayAfterLastTouchedKey). 'YYYY-MM-DD' keys sort lexicographically the same
 * as chronologically, so this range can be compared directly against stored TEXT columns
 * without any date parsing in SQL.
 */
export function touchedDayKeyRange(
  fromMs: number,
  toMs: number
): { firstDayKey: string; dayAfterLastTouchedKey: string } {
  const firstDayKey = dayKey(new Date(fromMs))
  // A `to` exactly on a local midnight does not touch that day (the range excludes it);
  // anything else means at least one millisecond of that day is included.
  const lastTouchedMs = toMs > fromMs ? toMs - 1 : fromMs
  const lastTouchedDay = startOfLocalDay(lastTouchedMs)
  const dayAfterLastTouchedKey = dayKey(addLocalDays(lastTouchedDay, 1))
  return { firstDayKey, dayAfterLastTouchedKey }
}
