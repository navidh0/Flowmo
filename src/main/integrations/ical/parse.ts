/**
 * Library spike (2026-09-24) — see `.claude/plans/v0.3-integrations.md`.
 *
 * Tried `ical.js` (MPL-2.0, zero dependencies) and `node-ical` (Apache-2.0; pulls in
 * `rrule-temporal` + `temporal-polyfill`, both pure JS — no native module, so
 * `npmRebuild: false` in electron-builder.yml still holds either way) against fixtures
 * covering: a timed event in a non-UTC TZID with its VTIMEZONE, a weekly RRULE with one
 * EXDATE and one RECURRENCE-ID override moved to a different time, an all-day single and
 * multi-day event, an event with an IANA TZID and NO VTIMEZONE block, a UTC ('Z') event,
 * and a cancelled override (STATUS:CANCELLED on a RECURRENCE-ID).
 *
 * `ical.js` failed the "IANA TZID, no VTIMEZONE" fixture: without a matching VTIMEZONE
 * component, `ICAL.Time` falls back to a "floating" zone rather than resolving the IANA id
 * itself — it ships no IANA tzdata of its own. Real feeds do this in practice (Outlook
 * exports, in particular, sometimes reference a TZID without embedding its VTIMEZONE), so
 * this was not an edge case worth working around with a second dependency for tzdata,
 * which would have erased ical.js's "zero deps" advantage anyway.
 *
 * `node-ical` resolves every fixture correctly, because `temporal-polyfill` carries full
 * IANA tzdata. Its `expandRecurringEvent()` helper already applies RECURRENCE-ID overrides
 * and EXDATE exclusions for us, and hands back all-day instances pre-flagged (`isFullDay`)
 * with a Date anchored at LOCAL NOON for the date-only value (not local midnight) —
 * deliberately, it turns out, so that a Y-M-D read back out with local `Date` getters is
 * never at risk of a day-boundary rounding into the wrong day. That is exactly the pattern
 * `localDateKey` below relies on, and exactly what this codebase already requires (see
 * CLAUDE.md: calendar days are computed in JS from local `Date` methods, never
 * `toISOString()`). It does not drop a `STATUS:CANCELLED` override on its own, so that
 * filter is ours below.
 *
 * Decision: node-ical, despite two extra (pure-JS) dependencies, because it is the one that
 * is actually correct on every fixture.
 */
import ical from 'node-ical'
import type { VEvent } from 'node-ical'
import { resolveTimeZone } from './timezone'

export type RawOccurrence =
  | {
      uid: string
      title: string
      location: string | null
      allDay: false
      startMs: number
      endMs: number
      /** IANA zone the event was defined in, or null for UTC/floating. See `timezone.ts`. */
      timeZone: string | null
    }
  | {
      uid: string
      title: string
      location: string | null
      allDay: true
      /** 'YYYY-MM-DD', local. */
      startDate: string
      /** Exclusive, per RFC 5545. */
      endDate: string
    }

function textValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Local 'YYYY-MM-DD'. `inst.start`/`inst.end` for a full-day instance are anchored at
 *  local noon by node-ical specifically so this read-back is safe. */
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/**
 * Parse an ICS document and expand every VEVENT into its occurrences overlapping
 * [windowFromMs, windowToMs). Cancelled instances (STATUS:CANCELLED on a RECURRENCE-ID
 * override) and EXDATE'd occurrences are dropped.
 *
 * Throws a plain, user-showable `Error` on input that is not a calendar at all. A single
 * malformed VEVENT within an otherwise-good feed is skipped rather than failing the whole
 * parse — one bad entry from an upstream provider must not black out every other event.
 */
export function parseIcsOccurrences(
  icsText: string,
  windowFromMs: number,
  windowToMs: number
): RawOccurrence[] {
  let data: ReturnType<typeof ical.sync.parseICS>
  try {
    data = ical.sync.parseICS(icsText)
  } catch {
    throw new Error('This does not look like a valid iCal (.ics) calendar.')
  }

  if (Object.keys(data).length === 0) {
    throw new Error('This does not look like a valid iCal (.ics) calendar.')
  }

  const events = Object.values(data).filter((c): c is VEvent => !!c && c.type === 'VEVENT')

  const from = new Date(windowFromMs)
  const to = new Date(windowToMs)
  const out: RawOccurrence[] = []

  for (const event of events) {
    let instances
    try {
      instances = ical.expandRecurringEvent(event, { from, to })
    } catch {
      continue
    }

    for (const inst of instances) {
      if (inst.event.status === 'CANCELLED') continue

      const uid = textValue(event.uid)
      const title = textValue(inst.summary) || '(untitled)'
      const rawLocation = inst.event.location
      const location = rawLocation == null ? null : textValue(rawLocation) || null

      if (inst.isFullDay) {
        out.push({
          uid,
          title,
          location,
          allDay: true,
          startDate: localDateKey(inst.start),
          endDate: localDateKey(inst.end)
        })
      } else {
        // Read per-occurrence, not per-event: a RECURRENCE-ID override in a different zone
        // than its master must carry its OWN zone, and `inst.start` already is the override's
        // own start when this instance is one.
        out.push({
          uid,
          title,
          location,
          allDay: false,
          startMs: inst.start.getTime(),
          endMs: inst.end.getTime(),
          timeZone: resolveTimeZone(inst.start.tz)
        })
      }
    }
  }

  return out
}
