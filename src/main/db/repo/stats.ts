import type {
  DailyBucket,
  ModeSplit,
  ProjectBucket,
  StatsRange,
  StatsSummary,
  TimerMode
} from '@shared/types'
import { getDb, num, scalarNum, str, strOrNull, numOrNull, type Row } from '../index'

/**
 * Every range boundary is computed in JS with `Date` and passed into SQL as epoch ms.
 *
 * This is deliberate and load-bearing: SQLite's `date()`/`strftime()` interpret an epoch
 * value as UTC unless told otherwise, so a focus session at 22:30 local in a UTC+n zone
 * would be filed under tomorrow and vanish from "today". The only place that knows about
 * calendar days is this file, and it always asks the host's local time zone.
 */

/**
 * ALL focus sessions count here, completed or not — this is a time tracker, and twenty
 * minutes you stopped early is still twenty minutes you spent. Excluding them would make
 * the time simply vanish from "where did my day go", which is the question the app exists
 * to answer.
 *
 * These numbers therefore deliberately DISAGREE with `TaskWithStats.actualPomodoros`, and
 * the disagreement is the useful part: `focusMs` is time spent, `actualPomodoros` is
 * pomodoros finished. A day of abandoned sessions should show real hours against zero
 * completed pomodoros.
 */
const FOCUS_WHERE = "kind = 'focus' AND started_at >= ? AND started_at <= ?"

/** Breaks are summed regardless of `completed` — a break cut short was still a break. */
const BREAK_WHERE =
  "kind IN ('short_break', 'long_break') AND started_at >= ? AND started_at <= ?"

const MODES: readonly TimerMode[] = ['pomodoro', 'flowmodoro']

/** Sessions whose project was deleted, or that were run with none, still hold real time. */
const UNASSIGNED = { id: 0, name: 'No project', color: '#64748b' } as const

export function startOfLocalDay(ms: number): number {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * Step whole calendar days, not 86_400_000 ms.
 *
 * A DST transition makes a local day 23 or 25 hours long; adding a fixed number of ms
 * across one drifts the boundary and silently merges or splits a day's bucket.
 */
export function addLocalDays(dayStartMs: number, days: number): number {
  const date = new Date(dayStartMs)
  date.setDate(date.getDate() + days)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 'YYYY-MM-DD' in local time. Never `toISOString()`, which is UTC. */
export function localDateKey(ms: number): string {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export interface RangeBounds {
  fromMs: number
  toMs: number
}

/**
 * Calendar boundaries, not rolling windows: "today" is since local midnight, not the last
 * 24 hours, and "week" starts on Monday. Both bounds are inclusive.
 */
export function rangeBounds(range: StatsRange, now = Date.now()): RangeBounds {
  const today = startOfLocalDay(now)

  if (range === 'today') return { fromMs: today, toMs: now }

  if (range === 'week') {
    // getDay() is 0 for Sunday; shift so Monday is 0.
    const mondayOffset = (new Date(today).getDay() + 6) % 7
    return { fromMs: addLocalDays(today, -mondayOffset), toMs: now }
  }

  if (range === 'year') {
    const date = new Date(today)
    return { fromMs: new Date(date.getFullYear(), 0, 1).getTime(), toMs: now }
  }

  return { fromMs: 0, toMs: now }
}

function emptySplit(): ModeSplit {
  return { focusMs: 0, sessions: 0 }
}

/**
 * Consecutive local days, ending today, with at least one completed focus session.
 *
 * If today has none yet, counting starts at yesterday — otherwise the streak would read 0
 * every morning until the first session lands, which is exactly when the number is
 * supposed to be motivating.
 *
 * Abandoned sessions still count toward focusMs (time spent is time spent), but they must
 * not extend the streak — only a completed focus session does.
 *
 * One indexed EXISTS probe per day, walking back until a day comes up empty.
 */
export function streakDays(now = Date.now()): number {
  const stmt = getDb().prepare(
    `SELECT 1 AS value FROM sessions
     WHERE kind = 'focus' AND completed = 1 AND started_at >= ? AND started_at < ?
     LIMIT 1`
  )
  const hasFocus = (dayStart: number): boolean =>
    stmt.get(dayStart, addLocalDays(dayStart, 1)) !== undefined

  const today = startOfLocalDay(now)
  let cursor = hasFocus(today) ? today : addLocalDays(today, -1)

  let count = 0
  // The loop exits on the first empty day; the bound only stops a corrupt clock from
  // spinning here forever.
  for (let guard = 0; guard < 3660 && hasFocus(cursor); guard++) {
    count += 1
    cursor = addLocalDays(cursor, -1)
  }
  return count
}

export function summary(range: StatsRange, now = Date.now()): StatsSummary {
  const { fromMs, toMs } = rangeBounds(range, now)
  const db = getDb()

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS sessions, COALESCE(SUM(actual_ms), 0) AS focus_ms
       FROM sessions WHERE ${FOCUS_WHERE}`
    )
    .get(fromMs, toMs)

  const focusMs = totals ? num(totals, 'focus_ms') : 0
  const focusSessions = totals ? num(totals, 'sessions') : 0

  const byMode: Record<TimerMode, ModeSplit> = {
    pomodoro: emptySplit(),
    flowmodoro: emptySplit()
  }
  const modeRows = db
    .prepare(
      `SELECT mode, COUNT(*) AS sessions, COALESCE(SUM(actual_ms), 0) AS focus_ms
       FROM sessions WHERE ${FOCUS_WHERE} GROUP BY mode`
    )
    .all(fromMs, toMs)
  for (const row of modeRows) {
    const mode = str(row, 'mode')
    for (const known of MODES) {
      if (known === mode) {
        byMode[known] = { focusMs: num(row, 'focus_ms'), sessions: num(row, 'sessions') }
      }
    }
  }

  const completed = db
    .prepare(
      `SELECT COUNT(*) AS sessions, COALESCE(SUM(actual_ms), 0) AS focus_ms
       FROM sessions WHERE ${FOCUS_WHERE} AND completed = 1`
    )
    .get(fromMs, toMs)

  const completedSessions = completed ? num(completed, 'sessions') : 0
  const completedFocusMs = completed ? num(completed, 'focus_ms') : 0

  return {
    range,
    focusMs,
    focusSessions,
    breakMs: scalarNum(
      `SELECT COALESCE(SUM(actual_ms), 0) AS value FROM sessions WHERE ${BREAK_WHERE}`,
      [fromMs, toMs]
    ),
    completedTasks: scalarNum(
      `SELECT COUNT(*) AS value FROM tasks
       WHERE completed_at IS NOT NULL AND completed_at >= ? AND completed_at <= ?`,
      [fromMs, toMs]
    ),
    // Mean of COMPLETED focus sessions only — this is the number that shows whether
    // Flowmodoro is buying longer stretches than Pomodoro, so an abandoned 8-second
    // session must not drag it down. Deliberately independent of `focusMs`/`focusSessions`
    // above, which include abandoned sessions on purpose (see file header).
    avgFocusMs: completedSessions > 0 ? Math.round(completedFocusMs / completedSessions) : 0,
    byMode,
    streakDays: streakDays(now)
  }
}

/**
 * A contiguous daily series, including days with nothing on them.
 *
 * Bucketing happens in JS after fetching the rows, because the bucket key has to be the
 * local calendar day. Zero-days are emitted explicitly: a chart handed only non-empty
 * days compresses the gaps and draws a week off as a smooth line.
 */
export function daily(range: StatsRange, now = Date.now()): DailyBucket[] {
  const { fromMs, toMs } = rangeBounds(range, now)

  const rows = getDb()
    .prepare(
      `SELECT started_at, actual_ms FROM sessions
       WHERE ${FOCUS_WHERE} ORDER BY started_at`
    )
    .all(fromMs, toMs)

  const buckets = new Map<string, DailyBucket>()
  for (const row of rows) {
    const key = localDateKey(num(row, 'started_at'))
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.focusMs += num(row, 'actual_ms')
      bucket.sessions += 1
    } else {
      buckets.set(key, { date: key, focusMs: num(row, 'actual_ms'), sessions: 1 })
    }
  }

  // 'all' has no natural first day until there is data — start at the earliest session
  // rather than at the epoch, which would emit fifty-six years of zeroes.
  const first = rows[0]
  const seriesStart =
    range === 'all'
      ? first
        ? startOfLocalDay(num(first, 'started_at'))
        : null
      : startOfLocalDay(fromMs)
  if (seriesStart === null) return []

  const series: DailyBucket[] = []
  const lastDay = startOfLocalDay(toMs)
  for (let day = seriesStart; day <= lastDay; day = addLocalDays(day, 1)) {
    const key = localDateKey(day)
    series.push(buckets.get(key) ?? { date: key, focusMs: 0, sessions: 0 })
  }
  return series
}

/**
 * Focus time per project, from the session's own `project_id`.
 *
 * Attribution is whatever was recorded when the session ended, so moving a task to
 * another project later does not rewrite last month's chart.
 */
export function byProject(range: StatsRange, now = Date.now()): ProjectBucket[] {
  const { fromMs, toMs } = rangeBounds(range, now)

  return getDb()
    .prepare(
      `SELECT s.project_id AS project_id,
              p.name       AS name,
              p.color      AS color,
              COUNT(*)     AS sessions,
              COALESCE(SUM(s.actual_ms), 0) AS focus_ms
       FROM sessions s
       LEFT JOIN projects p ON p.id = s.project_id
       WHERE s.kind = 'focus'
         AND s.started_at >= ? AND s.started_at <= ?
       GROUP BY s.project_id
       ORDER BY focus_ms DESC`
    )
    .all(fromMs, toMs)
    .map((row: Row) => {
      const projectId = numOrNull(row, 'project_id')
      return {
        projectId: projectId ?? UNASSIGNED.id,
        projectName: strOrNull(row, 'name') ?? UNASSIGNED.name,
        color: strOrNull(row, 'color') ?? UNASSIGNED.color,
        focusMs: num(row, 'focus_ms'),
        sessions: num(row, 'sessions')
      }
    })
}
