/**
 * All SQL for `calendar_feeds` / `calendar_events` (migration v2, `src/main/db/migrations.ts`).
 * Lives here rather than under `db/repo/` because that directory is owned elsewhere in this
 * wave — see the iCal agent brief.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { CalendarEvent, CalendarFeed, CalendarFeedUpdate } from '@shared/types'
import {
  bool,
  getDb,
  num,
  numOrNull,
  rowId,
  str,
  strOrNull,
  toInt,
  tx,
  type Row
} from '../../db'
import type { RawOccurrence } from './parse'
import { localDateKeyToMs, touchedDayKeyRange } from './dates'

function mapFeed(row: Row): CalendarFeed {
  return {
    id: num(row, 'id'),
    name: str(row, 'name'),
    color: str(row, 'color'),
    enabled: bool(row, 'enabled'),
    lastOkAt: numOrNull(row, 'last_ok_at'),
    lastError: strOrNull(row, 'last_error')
  }
}

export function listFeeds(): CalendarFeed[] {
  const rows = getDb().prepare('SELECT * FROM calendar_feeds ORDER BY id').all() as Row[]
  return rows.map(mapFeed)
}

export function getFeed(id: number): CalendarFeed | null {
  const row = getDb().prepare('SELECT * FROM calendar_feeds WHERE id = ?').get(id) as
    | Row
    | undefined
  return row ? mapFeed(row) : null
}

/** Never exposed outside this module — these are refresh bookkeeping, not app-visible state. */
export function getFeedConditional(
  id: number
): { etag: string | null; lastModified: string | null } | null {
  const row = getDb().prepare('SELECT etag, last_modified FROM calendar_feeds WHERE id = ?').get(
    id
  ) as Row | undefined
  if (!row) return null
  return { etag: strOrNull(row, 'etag'), lastModified: strOrNull(row, 'last_modified') }
}

export function listEnabledFeedIds(): number[] {
  const rows = getDb().prepare('SELECT id FROM calendar_feeds WHERE enabled = 1').all() as Row[]
  return rows.map((row) => num(row, 'id'))
}

function insertEvents(db: DatabaseSync, feedId: number, events: RawOccurrence[]): void {
  db.prepare('DELETE FROM calendar_events WHERE feed_id = ?').run(feedId)
  const stmt = db.prepare(
    `INSERT INTO calendar_events (feed_id, uid, title, location, all_day, start_ms, end_ms, start_date, end_date, tzid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const event of events) {
    if (event.allDay) {
      stmt.run(feedId, event.uid, event.title, event.location, 1, null, null, event.startDate, event.endDate, null)
    } else {
      stmt.run(
        feedId,
        event.uid,
        event.title,
        event.location,
        0,
        event.startMs,
        event.endMs,
        null,
        null,
        event.timeZone
      )
    }
  }
}

/**
 * Insert a brand-new feed together with its first batch of cached events, in one
 * transaction. Called only after a successful fetch+parse — `add()` in `index.ts` must never
 * leave a feed row behind for a URL that turned out to be bad.
 */
export function insertFeedWithEvents(
  input: { name: string; color: string },
  createdAt: number,
  conditional: { etag: string | null; lastModified: string | null; lastOkAt: number },
  events: RawOccurrence[]
): CalendarFeed {
  return tx((db) => {
    const info = db
      .prepare(
        `INSERT INTO calendar_feeds (name, color, enabled, etag, last_modified, last_ok_at, last_error, created_at)
         VALUES (?, ?, 1, ?, ?, ?, NULL, ?)`
      )
      .run(
        input.name,
        input.color,
        conditional.etag,
        conditional.lastModified,
        conditional.lastOkAt,
        createdAt
      )
    const id = rowId(info.lastInsertRowid)
    insertEvents(db, id, events)
    const row = db.prepare('SELECT * FROM calendar_feeds WHERE id = ?').get(id) as Row
    return mapFeed(row)
  })
}

export function updateFeedPatch(id: number, patch: CalendarFeedUpdate): CalendarFeed {
  const sets: string[] = []
  const params: (string | number)[] = []
  if (patch.name !== undefined) {
    sets.push('name = ?')
    params.push(patch.name)
  }
  if (patch.color !== undefined) {
    sets.push('color = ?')
    params.push(patch.color)
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?')
    params.push(toInt(patch.enabled))
  }
  if (sets.length > 0) {
    params.push(id)
    getDb()
      .prepare(`UPDATE calendar_feeds SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params)
  }
  const feed = getFeed(id)
  if (!feed) throw new Error(`Calendar feed ${id} not found`)
  return feed
}

/** Cascades to `calendar_events` via `ON DELETE CASCADE`. Does not touch the stored secret —
 *  that is `index.ts`'s job, since only it knows the credentials key. */
export function deleteFeed(id: number): void {
  getDb().prepare('DELETE FROM calendar_feeds WHERE id = ?').run(id)
}

function canonicalEventRow(row: Row): unknown {
  return {
    uid: str(row, 'uid'),
    title: str(row, 'title'),
    location: strOrNull(row, 'location'),
    allDay: bool(row, 'all_day'),
    startMs: numOrNull(row, 'start_ms'),
    endMs: numOrNull(row, 'end_ms'),
    startDate: strOrNull(row, 'start_date'),
    endDate: strOrNull(row, 'end_date'),
    tzid: strOrNull(row, 'tzid')
  }
}

const EVENT_COLUMNS =
  'uid, title, location, all_day, start_ms, end_ms, start_date, end_date, tzid'

/**
 * Replace a feed's cached events wholesale, in one transaction, and record the successful
 * refresh. Returns whether the cached rows actually changed, so the caller only broadcasts
 * `data:changed` when there is something new to show.
 */
export function replaceFeedEvents(
  id: number,
  conditional: { etag: string | null; lastModified: string | null },
  now: number,
  events: RawOccurrence[]
): boolean {
  return tx((db) => {
    const before = db
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM calendar_events WHERE feed_id = ? ORDER BY uid, start_ms, start_date`
      )
      .all(id) as Row[]

    insertEvents(db, id, events)

    const after = db
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM calendar_events WHERE feed_id = ? ORDER BY uid, start_ms, start_date`
      )
      .all(id) as Row[]

    const changed =
      JSON.stringify(before.map(canonicalEventRow)) !== JSON.stringify(after.map(canonicalEventRow))

    db.prepare(
      'UPDATE calendar_feeds SET etag = ?, last_modified = ?, last_ok_at = ?, last_error = NULL WHERE id = ?'
    ).run(conditional.etag, conditional.lastModified, now, id)

    return changed
  })
}

/** 304 Not Modified: the cache is still good, just record that we checked. */
export function markFeedNotModified(id: number, now: number): void {
  getDb()
    .prepare('UPDATE calendar_feeds SET last_ok_at = ?, last_error = NULL WHERE id = ?')
    .run(now, id)
}

/** A failed fetch/parse keeps the previous cached rows untouched and only records why. */
export function markFeedError(id: number, message: string): void {
  getDb().prepare('UPDATE calendar_feeds SET last_error = ? WHERE id = ?').run(message, id)
}

function sortKeyMs(event: CalendarEvent): number {
  return event.allDay ? localDateKeyToMs(event.startDate) : event.startMs
}

/**
 * Occurrences overlapping [fromMs, toMs) from enabled feeds only, timed and all-day alike,
 * sorted by start. All-day overlap is decided by comparing 'YYYY-MM-DD' TEXT columns against
 * a day-key range computed in JS (`touchedDayKeyRange`) — never SQL `date()`/`strftime()`.
 */
export function eventsRange(fromMs: number, toMs: number): CalendarEvent[] {
  const db = getDb()
  const { firstDayKey, dayAfterLastTouchedKey } = touchedDayKeyRange(fromMs, toMs)

  const timedRows = db
    .prepare(
      `SELECT ce.* FROM calendar_events ce
       JOIN calendar_feeds cf ON cf.id = ce.feed_id
       WHERE cf.enabled = 1 AND ce.all_day = 0 AND ce.start_ms < ? AND ce.end_ms > ?`
    )
    .all(toMs, fromMs) as Row[]

  const allDayRows = db
    .prepare(
      `SELECT ce.* FROM calendar_events ce
       JOIN calendar_feeds cf ON cf.id = ce.feed_id
       WHERE cf.enabled = 1 AND ce.all_day = 1 AND ce.start_date < ? AND ce.end_date > ?`
    )
    .all(dayAfterLastTouchedKey, firstDayKey) as Row[]

  const timed: CalendarEvent[] = timedRows.map((row) => ({
    id: num(row, 'id'),
    feedId: num(row, 'feed_id'),
    title: str(row, 'title'),
    location: strOrNull(row, 'location'),
    allDay: false,
    startMs: num(row, 'start_ms'),
    endMs: num(row, 'end_ms'),
    timeZone: strOrNull(row, 'tzid')
  }))

  const allDay: CalendarEvent[] = allDayRows.map((row) => ({
    id: num(row, 'id'),
    feedId: num(row, 'feed_id'),
    title: str(row, 'title'),
    location: strOrNull(row, 'location'),
    allDay: true,
    startDate: str(row, 'start_date'),
    endDate: str(row, 'end_date')
  }))

  return [...timed, ...allDay].sort((a, b) => sortKeyMs(a) - sortKeyMs(b))
}
