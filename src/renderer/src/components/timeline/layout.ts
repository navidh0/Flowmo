/**
 * Pure layout math for the day timeline: local-day bounds, DST-correct hour marks, and
 * overlap-column assignment. No React, no IPC — kept here so `tests/timeline-layout.test.ts`
 * can exercise it directly with `process.env.TZ` pointed at a DST zone.
 *
 * Local-day rule (see CLAUDE.md): a day is `[new Date(y,m,d), new Date(y,m,d+1))`, stepped
 * with `setDate()` so a DST transition changes the day's LENGTH (23h/25h) rather than
 * silently shifting its boundary. Never `toISOString()` — that is UTC and would put a
 * 22:30 local session under tomorrow.
 */

const HOUR_MS = 3_600_000

export interface DayBounds {
  /** Epoch ms of local midnight starting this day. */
  start: number
  /** Epoch ms of local midnight starting the next day (exclusive). */
  end: number
}

/** The local calendar day containing `ms`. */
export function localDayBounds(ms: number): DayBounds {
  const d = new Date(ms)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  end.setDate(end.getDate() + 1)
  return { start: start.getTime(), end: end.getTime() }
}

/** `ms` moved `deltaDays` local calendar days, via `setDate()` (never `± 86_400_000`). */
export function shiftLocalDay(ms: number, deltaDays: number): number {
  const d = new Date(ms)
  d.setDate(d.getDate() + deltaDays)
  return d.getTime()
}

/** True when `ms` falls within the same local day as `dayMs`. */
export function isSameLocalDay(ms: number, dayMs: number): boolean {
  const bounds = localDayBounds(dayMs)
  return ms >= bounds.start && ms < bounds.end
}

export interface HourMark {
  /** Epoch ms of this tick — exactly `bounds.start + k * 1h` of real elapsed time. */
  ms: number
  /** The real local hour (0-23) at that instant. Two marks can share this value on a
   *  25-hour (fall-back) day; a value can be entirely absent on a 23-hour (spring-forward)
   *  day. That is deliberate — it is what the clock actually did. */
  hour: number
  /** Fraction of the day elapsed, 0..1 (exclusive of 1, since the day is half-open). */
  fraction: number
}

/**
 * One mark per real elapsed hour from the day's start, labelled with the actual local hour
 * at that instant.
 *
 * Ticking by civil hour-of-day (`setHours(h)`) instead of real elapsed ms would silently
 * "fix" the DST anomaly by construction — asking for civil hour 2 on a spring-forward day
 * just returns 03:00, and civil hour 1 can never yield fall-back's second occurrence at all.
 * Stepping by real milliseconds and reading the hour back off the resulting instant is the
 * only way to reproduce the skip/double exactly as the clock showed it.
 */
export function hourMarks(bounds: DayBounds): HourMark[] {
  const marks: HourMark[] = []
  const span = bounds.end - bounds.start
  for (let offset = 0; offset < span; offset += HOUR_MS) {
    const ms = bounds.start + offset
    marks.push({ ms, hour: new Date(ms).getHours(), fraction: offset / span })
  }
  return marks
}

/** Fraction of the day `[0, 1]` for an instant, clamped to the day's bounds. */
export function dayFraction(ms: number, bounds: DayBounds): number {
  const span = bounds.end - bounds.start
  return Math.min(1, Math.max(0, (ms - bounds.start) / span))
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlap columns
// ─────────────────────────────────────────────────────────────────────────────

export interface OverlapInterval {
  id: string
  startMs: number
  endMs: number
}

export interface OverlapPlacement<T extends OverlapInterval> {
  item: T
  /** 0-based column within this overlap cluster. */
  column: number
  /** Total columns in this cluster — the item's width is `1 / columns`. */
  columns: number
}

/**
 * Greedy interval-graph column assignment (as calendar UIs commonly do it): sort by start,
 * group into clusters of transitively-overlapping items, then within each cluster hand each
 * item the first column whose previous occupant has already ended. Every item in a cluster
 * gets `columns = ` that cluster's peak concurrency, so overlapping items always sit side by
 * side and never stack invisibly on top of each other.
 */
export function layoutOverlaps<T extends OverlapInterval>(items: T[]): OverlapPlacement<T>[] {
  const sorted = [...items].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const result: OverlapPlacement<T>[] = []

  let cluster: T[] = []
  let clusterEnd = -Infinity

  const flush = (): void => {
    if (cluster.length === 0) return
    const columnEnds: number[] = []
    const assigned: number[] = []
    for (const it of cluster) {
      let col = columnEnds.findIndex((end) => end <= it.startMs)
      if (col === -1) {
        col = columnEnds.length
        columnEnds.push(it.endMs)
      } else {
        columnEnds[col] = it.endMs
      }
      assigned.push(col)
    }
    const columns = columnEnds.length
    cluster.forEach((it, i) => result.push({ item: it, column: assigned[i] ?? 0, columns }))
    cluster = []
  }

  for (const it of sorted) {
    if (cluster.length === 0 || it.startMs < clusterEnd) {
      cluster.push(it)
      clusterEnd = Math.max(clusterEnd, it.endMs)
    } else {
      flush()
      cluster.push(it)
      clusterEnd = it.endMs
    }
  }
  flush()

  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Clipping a session that runs past the day's end
// ─────────────────────────────────────────────────────────────────────────────

export interface ClippedRange {
  startMs: number
  endMs: number
  /** True when the real end lies beyond the day's end — render a "continues" marker. */
  continues: boolean
}

/** Clip `[startMs, endMs)` to `bounds`, marking whether the real end was cut off.
 *  A session belongs to the day it BEGAN — this never moves `startMs`, only caps `endMs`. */
export function clipToDay(startMs: number, endMs: number, bounds: DayBounds): ClippedRange {
  const clippedEnd = Math.min(endMs, bounds.end)
  return { startMs, endMs: clippedEnd, continues: endMs > bounds.end }
}
