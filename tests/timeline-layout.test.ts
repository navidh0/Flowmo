/**
 * Pure layout math for the day timeline (`components/timeline/layout.ts`).
 *
 * `process.env.TZ` is set directly on `process.env` (not exported from the surrounding
 * shell) — on Windows the OS timezone API, not `TZ`, drives `Date`, and only V8's own
 * lookup honours a `TZ` mutation made from inside the running process. It is set at
 * import time and restored after every test.
 *
 * 2026 US Eastern DST transitions used as the two cases: spring-forward on 2026-03-08
 * (a 23-hour day, 02:00 never happens) and fall-back on 2026-11-01 (a 25-hour day, 01:00
 * happens twice).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clipToDay,
  dayFraction,
  hourMarks,
  isInMonth,
  isSameLocalDay,
  layoutOverlaps,
  localDayBounds,
  localWeekBounds,
  monthAnchor,
  monthGrid,
  shiftLocalDay,
  shiftLocalMonth,
  shiftLocalWeek,
  weekDays
} from '../src/renderer/src/components/timeline/layout'

let originalTz: string | undefined

beforeEach(() => {
  originalTz = process.env.TZ
  process.env.TZ = 'America/New_York'
})

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
})

describe('localDayBounds', () => {
  it('is a 23-hour day on the spring-forward transition', () => {
    const noon = new Date(2026, 2, 8, 12, 0, 0).getTime()
    const { start, end } = localDayBounds(noon)
    expect(start).toBe(new Date(2026, 2, 8, 0, 0, 0).getTime())
    expect(end).toBe(new Date(2026, 2, 9, 0, 0, 0).getTime())
    expect(end - start).toBe(23 * 3_600_000)
  })

  it('is a 25-hour day on the fall-back transition', () => {
    const noon = new Date(2026, 10, 1, 12, 0, 0).getTime()
    const { start, end } = localDayBounds(noon)
    expect(start).toBe(new Date(2026, 10, 1, 0, 0, 0).getTime())
    expect(end).toBe(new Date(2026, 10, 2, 0, 0, 0).getTime())
    expect(end - start).toBe(25 * 3_600_000)
  })

  it('is a normal 24-hour day off a transition', () => {
    const noon = new Date(2026, 5, 15, 12, 0, 0).getTime()
    const { start, end } = localDayBounds(noon)
    expect(end - start).toBe(24 * 3_600_000)
  })
})

describe('shiftLocalDay', () => {
  it('steps across the spring-forward boundary by calendar day, not a fixed ms offset', () => {
    const mar7Noon = new Date(2026, 2, 7, 12, 0, 0).getTime()
    const next = shiftLocalDay(mar7Noon, 1)
    // A naive +86_400_000 would land at 11:00 on the 8th, one hour short of noon.
    expect(next).toBe(new Date(2026, 2, 8, 12, 0, 0).getTime())
  })

  it('steps across the fall-back boundary by calendar day, not a fixed ms offset', () => {
    const oct31Noon = new Date(2026, 9, 31, 12, 0, 0).getTime()
    const next = shiftLocalDay(oct31Noon, 1)
    expect(next).toBe(new Date(2026, 10, 1, 12, 0, 0).getTime())
  })

  it('steps backward too', () => {
    const mar8Noon = new Date(2026, 2, 8, 12, 0, 0).getTime()
    expect(shiftLocalDay(mar8Noon, -1)).toBe(new Date(2026, 2, 7, 12, 0, 0).getTime())
  })
})

describe('isSameLocalDay', () => {
  it('is true for two instants in the same local day and false across midnight', () => {
    const dayMs = new Date(2026, 5, 15, 9, 0, 0).getTime()
    expect(isSameLocalDay(new Date(2026, 5, 15, 23, 59, 0).getTime(), dayMs)).toBe(true)
    expect(isSameLocalDay(new Date(2026, 5, 16, 0, 0, 0).getTime(), dayMs)).toBe(false)
  })
})

describe('hourMarks', () => {
  it('has exactly 23 marks on the spring-forward day, and 02:00 never appears', () => {
    const bounds = localDayBounds(new Date(2026, 2, 8, 12).getTime())
    const marks = hourMarks(bounds)
    expect(marks).toHaveLength(23)
    expect(marks.some((m) => m.hour === 2)).toBe(false)
    expect(marks.map((m) => m.hour)).toEqual([
      0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23
    ])
  })

  it('has exactly 25 marks on the fall-back day, and 01:00 appears twice', () => {
    const bounds = localDayBounds(new Date(2026, 10, 1, 12).getTime())
    const marks = hourMarks(bounds)
    expect(marks).toHaveLength(25)
    expect(marks.filter((m) => m.hour === 1)).toHaveLength(2)
    expect(marks.map((m) => m.hour)).toEqual([
      0, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23
    ])
  })

  it('has exactly 24 marks, one per hour, on a normal day', () => {
    const bounds = localDayBounds(new Date(2026, 5, 15, 12).getTime())
    const marks = hourMarks(bounds)
    expect(marks).toHaveLength(24)
    expect(marks.map((m) => m.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i))
  })

  it('marks land at increasing fractions covering [0, 1)', () => {
    const bounds = localDayBounds(new Date(2026, 5, 15, 12).getTime())
    const marks = hourMarks(bounds)
    expect(marks[0]?.fraction).toBe(0)
    for (let i = 1; i < marks.length; i++) {
      expect(marks[i]?.fraction).toBeGreaterThan(marks[i - 1]?.fraction ?? -Infinity)
    }
    expect(marks.every((m) => m.fraction >= 0 && m.fraction < 1)).toBe(true)
  })
})

describe('dayFraction', () => {
  it('is 0 at the start, just under 1 at the end, and 0.5 at the midpoint of a normal day', () => {
    const bounds = localDayBounds(new Date(2026, 5, 15, 12).getTime())
    expect(dayFraction(bounds.start, bounds)).toBe(0)
    expect(dayFraction(bounds.end, bounds)).toBe(1)
    expect(dayFraction((bounds.start + bounds.end) / 2, bounds)).toBeCloseTo(0.5)
  })

  it('clamps outside the bounds rather than going negative or past 1', () => {
    const bounds = localDayBounds(new Date(2026, 5, 15, 12).getTime())
    expect(dayFraction(bounds.start - 1000, bounds)).toBe(0)
    expect(dayFraction(bounds.end + 1000, bounds)).toBe(1)
  })

  it('gives the shorter spring-forward day proportionally more fraction per real hour', () => {
    const bounds = localDayBounds(new Date(2026, 2, 8, 12).getTime())
    // 12:00 noon is 11 real elapsed hours into a 23-hour day: the clock skipped 02:00,
    // so only 11 hourly ticks (00,01,03..11) have passed by the time it reads 12:00.
    const noon = new Date(2026, 2, 8, 12, 0, 0).getTime()
    expect(dayFraction(noon, bounds)).toBeCloseTo(11 / 23)
  })
})

describe('clipToDay', () => {
  it('leaves a session entirely inside the day untouched', () => {
    const bounds = localDayBounds(new Date(2026, 5, 15, 12).getTime())
    const start = new Date(2026, 5, 15, 9).getTime()
    const end = new Date(2026, 5, 15, 10).getTime()
    expect(clipToDay(start, end, bounds)).toEqual({ startMs: start, endMs: end, continues: false })
  })

  it('clips a session running past midnight and marks it as continuing', () => {
    const bounds = localDayBounds(new Date(2026, 5, 15, 12).getTime())
    const start = new Date(2026, 5, 15, 23).getTime()
    const end = new Date(2026, 5, 16, 1).getTime()
    const clipped = clipToDay(start, end, bounds)
    expect(clipped.startMs).toBe(start)
    expect(clipped.endMs).toBe(bounds.end)
    expect(clipped.continues).toBe(true)
  })
})

describe('layoutOverlaps', () => {
  it('gives a single non-overlapping item its own full-width column', () => {
    const placed = layoutOverlaps([{ id: 'a', startMs: 0, endMs: 100 }])
    expect(placed).toEqual([{ item: { id: 'a', startMs: 0, endMs: 100 }, column: 0, columns: 1 }])
  })

  it('puts two overlapping items in separate columns of a 2-wide cluster', () => {
    const items = [
      { id: 'a', startMs: 0, endMs: 100 },
      { id: 'b', startMs: 50, endMs: 150 }
    ]
    const placed = layoutOverlaps(items)
    const byId = Object.fromEntries(placed.map((p) => [p.item.id, p]))
    expect(byId.a!.columns).toBe(2)
    expect(byId.b!.columns).toBe(2)
    expect(byId.a!.column).not.toBe(byId.b!.column)
  })

  it('does not widen a cluster for items that do not overlap each other', () => {
    // a and b overlap; c starts after both end — same cluster boundary logic must not
    // force c into a third column it does not need.
    const items = [
      { id: 'a', startMs: 0, endMs: 100 },
      { id: 'b', startMs: 50, endMs: 150 },
      { id: 'c', startMs: 200, endMs: 300 }
    ]
    const placed = layoutOverlaps(items)
    const byId = Object.fromEntries(placed.map((p) => [p.item.id, p]))
    expect(byId.a!.columns).toBe(2)
    expect(byId.b!.columns).toBe(2)
    expect(byId.c!.columns).toBe(1)
    expect(byId.c!.column).toBe(0)
  })

  it('reuses a column once its previous occupant has ended', () => {
    const items = [
      { id: 'a', startMs: 0, endMs: 50 },
      { id: 'b', startMs: 0, endMs: 100 },
      { id: 'c', startMs: 60, endMs: 120 }
    ]
    const placed = layoutOverlaps(items)
    const byId = Object.fromEntries(placed.map((p) => [p.item.id, p]))
    // a ends at 50, before c starts at 60, so c can reuse a's column; b overlaps both.
    expect(byId.c!.column).toBe(byId.a!.column)
    expect(byId.b!.column).not.toBe(byId.a!.column)
    expect(byId.a!.columns).toBe(2)
  })

  it('handles three-way overlap with three columns', () => {
    const items = [
      { id: 'a', startMs: 0, endMs: 100 },
      { id: 'b', startMs: 10, endMs: 90 },
      { id: 'c', startMs: 20, endMs: 80 }
    ]
    const placed = layoutOverlaps(items)
    expect(new Set(placed.map((p) => p.column)).size).toBe(3)
    expect(placed.every((p) => p.columns === 3)).toBe(true)
  })

  it('is empty for an empty input', () => {
    expect(layoutOverlaps([])).toEqual([])
  })
})

describe('localWeekBounds', () => {
  it('is Monday-first for a mid-week instant', () => {
    const wed = new Date(2026, 5, 17, 12).getTime() // Wed 17 June 2026
    const { start, end } = localWeekBounds(wed)
    expect(new Date(start).getDay()).toBe(1) // Monday
    expect(start).toBe(new Date(2026, 5, 15).getTime())
    expect(end).toBe(new Date(2026, 5, 22).getTime())
  })

  it('is 167 hours for the week containing the spring-forward day', () => {
    // 8 March 2026 is a Sunday; its Monday-first week is 2-9 March, spanning the transition.
    const { start, end } = localWeekBounds(new Date(2026, 2, 8, 12).getTime())
    expect(end - start).toBe(167 * 3_600_000)
  })

  it('is 169 hours for the week containing the fall-back day', () => {
    // 1 November 2026 is a Sunday; its Monday-first week is 26 Oct - 2 Nov.
    const { start, end } = localWeekBounds(new Date(2026, 10, 1, 12).getTime())
    expect(end - start).toBe(169 * 3_600_000)
  })
})

describe('shiftLocalWeek', () => {
  it('steps by 7 calendar days, across the spring-forward boundary', () => {
    const monday = new Date(2026, 1, 23, 12).getTime()
    expect(shiftLocalWeek(monday, 1)).toBe(new Date(2026, 2, 2, 12).getTime())
  })
})

describe('weekDays', () => {
  it('returns 7 local midnights, Monday through Sunday', () => {
    const days = weekDays(new Date(2026, 5, 17, 9).getTime())
    expect(days).toHaveLength(7)
    expect(days.map((d) => new Date(d).getDay())).toEqual([1, 2, 3, 4, 5, 6, 0])
    expect(days[0]).toBe(new Date(2026, 5, 15).getTime())
  })
})

describe('shiftLocalMonth', () => {
  it('moves by calendar month, normalised to the 1st (no 31 Jan -> March rollover)', () => {
    const jan31 = new Date(2026, 0, 31, 10).getTime()
    expect(shiftLocalMonth(jan31, 1)).toBe(new Date(2026, 1, 1).getTime())
  })

  it('steps backward across a year boundary', () => {
    const jan15 = new Date(2026, 0, 15).getTime()
    expect(shiftLocalMonth(jan15, -1)).toBe(new Date(2025, 11, 1).getTime())
  })
})

describe('monthGrid', () => {
  it('is 5 rows for a month starting on Monday (June 2026)', () => {
    const grid = monthGrid(new Date(2026, 5, 10).getTime())
    expect(grid.weeks).toHaveLength(5)
    expect(grid.weeks[0]?.[0]).toBe(new Date(2026, 5, 1).getTime())
    expect(new Date(grid.weeks[0]![0]!).getDay()).toBe(1)
  })

  it('is 5 rows for February in a non-leap year starting on Sunday (Feb 2026)', () => {
    const grid = monthGrid(new Date(2026, 1, 10).getTime())
    expect(grid.weeks).toHaveLength(5)
    // Feb 2026 starts on a Sunday: the grid's first row leads with the last Monday of January.
    expect(grid.weeks[0]?.[0]).toBe(new Date(2026, 0, 26).getTime())
    expect(grid.weeks[0]?.[6]).toBe(new Date(2026, 1, 1).getTime())
    const lastWeek = grid.weeks[4]!
    expect(lastWeek[6]).toBe(new Date(2026, 2, 1).getTime())
  })

  it('is 6 rows for a month starting on Sunday with 30 days (November 2026)', () => {
    const grid = monthGrid(new Date(2026, 10, 15).getTime())
    expect(grid.weeks).toHaveLength(6)
    expect(grid.weeks[0]?.[0]).toBe(new Date(2026, 9, 26).getTime())
    const lastWeek = grid.weeks[5]!
    expect(lastWeek[6]).toBe(new Date(2026, 11, 6).getTime())
  })

  it('every week has exactly 7 consecutive local days', () => {
    const grid = monthGrid(new Date(2026, 10, 15).getTime())
    for (const week of grid.weeks) {
      expect(week).toHaveLength(7)
      for (let i = 1; i < week.length; i++) {
        expect(week[i]).toBe(shiftLocalDay(week[i - 1]!, 1))
      }
    }
  })
})

describe('monthAnchor / isInMonth', () => {
  it('anchors to the 1st of the month at local midnight', () => {
    expect(monthAnchor(new Date(2026, 5, 17, 23, 59).getTime())).toBe(
      new Date(2026, 5, 1).getTime()
    )
  })

  it('tells a grid day in the shown month from a leading/trailing neighbour', () => {
    const grid = monthGrid(new Date(2026, 1, 10).getTime())
    const leadingDay = grid.weeks[0]![0]! // 26 Jan, borrowed from January
    const inMonthDay = grid.weeks[0]![6]! // 1 Feb
    expect(isInMonth(leadingDay, grid.monthMs)).toBe(false)
    expect(isInMonth(inMonthDay, grid.monthMs)).toBe(true)
  })
})
