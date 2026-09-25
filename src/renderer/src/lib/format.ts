/**
 * Shared formatting helpers.
 *
 * Owned by neither UI agent — both the timer and the task/stats views need duration
 * formatting, and two independent implementations would drift into showing the same
 * number two different ways on adjacent panels.
 */

/** `MM:SS`, or `H:MM:SS` once past an hour. Use for the running timer. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** Compact human duration for stats: `0m`, `45m`, `2h 05m`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m}m`
  return `${h}h ${String(m).padStart(2, '0')}m`
}

/** `1.5h` style, for dense chart axes and tooltips. */
export function formatHours(ms: number): string {
  const hours = ms / 3_600_000
  if (hours < 0.1) return '0h'
  return `${hours.toFixed(1)}h`
}

/** Local calendar day as `YYYY-MM-DD` — matches Task.dueDate and DailyBucket.date. */
export function toLocalDateKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Midnight local time for the day containing `ms`. */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 'Today' / 'Tomorrow' / 'Overdue by 2d' / 'Mon 3 Aug' for a `YYYY-MM-DD` due date. */
export function formatDueDate(dateKey: string | null, now = Date.now()): string | null {
  if (!dateKey) return null
  const [y, m, d] = dateKey.split('-').map(Number)
  if (!y || !m || !d) return null

  const due = new Date(y, m - 1, d).getTime()
  const today = startOfLocalDay(now)
  const days = Math.round((due - today) / 86_400_000)

  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'
  if (days < -1) return `${Math.abs(days)}d overdue`

  return new Date(due).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  })
}

/**
 * Like `formatDueDate`, but Today/Tomorrow/Yesterday get the weekday and date appended —
 * `Today · Fri 25 Sep` — for the Today and Upcoming group headers, where the bare relative
 * word alone leaves the actual date unstated. Every other date is exactly
 * `formatDueDate`'s output, unchanged, so a row's own "Today" chip never disagrees with the
 * group heading it sits under.
 */
export function formatDueGroupLabel(dateKey: string | null, now = Date.now()): string | null {
  const relative = formatDueDate(dateKey, now)
  if (relative === null || dateKey === null) return relative
  if (relative !== 'Today' && relative !== 'Tomorrow' && relative !== 'Yesterday') return relative

  const [y, m, d] = dateKey.split('-').map(Number)
  if (!y || !m || !d) return relative
  const due = new Date(y, m - 1, d)
  const dateLabel = due.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  })
  return `${relative} · ${dateLabel}`
}

export const PRIORITY_LABEL: Record<1 | 2 | 3 | 4, string> = {
  1: 'Urgent',
  2: 'High',
  3: 'Normal',
  4: 'Low'
}

/** CSS var name per priority, matching the --color-p* tokens in index.css. */
export const PRIORITY_VAR: Record<1 | 2 | 3 | 4, string> = {
  1: 'var(--color-p1)',
  2: 'var(--color-p2)',
  3: 'var(--color-p3)',
  4: 'var(--color-p4)'
}
