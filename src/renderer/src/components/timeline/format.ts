/**
 * Timeline-only formatting helpers. Kept here rather than `lib/format.ts` per this
 * directory's ownership brief — nothing else needs a bare hour label or a time range.
 */

/** `9`, `13` — the raw local hour for a grid line label (rendered as `9 AM` / `13:00` by
 *  the caller's locale settings; kept numeric here so tests don't depend on locale). */
export function formatHourLabel(hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  const suffix = hour < 12 ? 'AM' : 'PM'
  return `${h12} ${suffix}`
}

/** `9:00 AM` for a full instant, used in the header and hover card. */
export function formatTimeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** `9:00 AM – 10:15 AM`, or with a "continues" note when the range was clipped. */
export function formatTimeRange(startMs: number, endMs: number, continues: boolean): string {
  const range = `${formatTimeOfDay(startMs)} – ${formatTimeOfDay(endMs)}`
  return continues ? `${range} (continues past midnight)` : range
}

/** `Monday, 3 August 2026` for the header. */
export function formatDayHeading(dayMs: number): string {
  return new Date(dayMs).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })
}
