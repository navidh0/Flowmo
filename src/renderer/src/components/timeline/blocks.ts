/**
 * Turns raw sessions/events/the running phase into the flat list `HourGrid` lays out.
 *
 * Pure and React-free like `layout.ts`, but not covered by the DST test suite itself — it
 * has no date arithmetic of its own, just clipping (via `clipToDay`) and colour lookup.
 */

import type { CalendarEvent, Project, Session, TimerState } from '@shared/types'
import { clipToDay, type DayBounds, type OverlapInterval } from './layout'

export type BlockKind = 'focus' | 'break' | 'running-focus' | 'running-break' | 'event'

export interface TimelineBlock extends OverlapInterval {
  kind: BlockKind
  title: string
  color: string
  /** True when the underlying session/event runs past the day's end. */
  continues: boolean
  /** Present for session-derived blocks; used to look up the task title on hover. */
  taskId: number | null
  /** Focus session stopped before completion — rendered visibly distinct (dashed). */
  abandoned: boolean
  /** Present for calendar-event blocks. */
  location: string | null
  /** The IANA zone a calendar event was defined in, or null for a session/running block (no
   *  such concept) or a floating/UTC event. Positioning never uses this — only the label,
   *  via `formatEventStart` — see its own doc for why. */
  timeZone: string | null
}

const NEUTRAL = 'var(--color-text-muted)'
const BREAK_COLOR = 'var(--color-break)'

function projectColor(projectId: number | null, projects: Project[]): string {
  if (projectId === null) return NEUTRAL
  return projects.find((p) => p.id === projectId)?.color ?? NEUTRAL
}

/** Sessions in the day, clipped at 24:00 with a "continues" flag — never split or repeated
 *  on the next day (a session belongs to the day it BEGAN, matching `listRange`). */
export function sessionBlocks(
  sessions: Session[],
  projects: Project[],
  bounds: DayBounds
): TimelineBlock[] {
  return sessions.map((s) => {
    const clipped = clipToDay(s.startedAt, s.endedAt, bounds)
    const isBreak = s.kind !== 'focus'
    return {
      id: `session-${s.id}`,
      startMs: clipped.startMs,
      endMs: clipped.endMs,
      continues: clipped.continues,
      kind: isBreak ? 'break' : 'focus',
      title: isBreak ? (s.kind === 'long_break' ? 'Long break' : 'Short break') : 'Focus',
      color: isBreak ? BREAK_COLOR : projectColor(s.projectId, projects),
      taskId: s.taskId,
      abandoned: !isBreak && !s.completed,
      location: null,
      timeZone: null
    }
  })
}

/** The in-progress phase, drawn from `TimerState` (render-only — `state.elapsedMs` is
 *  main's own derived value, not a clock this module keeps). Absent once idle, or when the
 *  phase did not start on this day. */
export function runningBlock(
  state: TimerState,
  projects: Project[],
  bounds: DayBounds
): TimelineBlock | null {
  if (state.status === 'idle') return null
  if (state.startedAt < bounds.start || state.startedAt >= bounds.end) return null

  const isBreak = state.kind !== 'focus'
  const nowMs = state.startedAt + state.elapsedMs
  const clipped = clipToDay(state.startedAt, nowMs, bounds)

  return {
    id: 'running',
    startMs: clipped.startMs,
    endMs: Math.max(clipped.endMs, clipped.startMs + 60_000), // stay visible at the very start
    continues: clipped.continues,
    kind: isBreak ? 'running-break' : 'running-focus',
    title: isBreak ? 'Break (running)' : 'Focus (running)',
    color: isBreak ? BREAK_COLOR : projectColor(state.projectId, projects),
    taskId: state.taskId,
    abandoned: false,
    location: null,
    timeZone: null
  }
}

/** Fallback when a feed's colour is unknown — the feed list hasn't loaded, failed to load, or
 *  (in principle) the event's feed was deleted between fetches. */
const EVENT_COLOR = 'var(--color-focus)'

export function eventColor(feedId: number, feedColors: Map<number, string>): string {
  return feedColors.get(feedId) ?? EVENT_COLOR
}

/** Timed calendar events overlapping the day, clipped the same way a session is. All-day
 *  events are handled separately by the all-day row, never mixed into the hour grid.
 *
 * Filters to events that actually overlap `bounds` first — required once the caller fetches
 * a whole week/month in one call (see `stores/timeline.ts`) rather than one day at a time,
 * or every event in the visible range would render on every day of it. */
export function eventBlocks(
  events: CalendarEvent[],
  bounds: DayBounds,
  feedColors: Map<number, string>
): TimelineBlock[] {
  return events
    .filter((e): e is Extract<CalendarEvent, { allDay: false }> => !e.allDay)
    .filter((e) => e.startMs < bounds.end && e.endMs > bounds.start)
    .map((e) => {
      const clipped = clipToDay(Math.max(e.startMs, bounds.start), e.endMs, bounds)
      return {
        id: `event-${e.id}`,
        startMs: clipped.startMs,
        endMs: clipped.endMs,
        continues: clipped.continues,
        kind: 'event' as const,
        title: e.title,
        color: eventColor(e.feedId, feedColors),
        taskId: null,
        abandoned: false,
        location: e.location,
        timeZone: e.timeZone
      }
    })
}
