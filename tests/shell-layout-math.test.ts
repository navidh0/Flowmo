/**
 * Independent check on the pure arithmetic behind `ResizableShell`: the drag clamp
 * (`clampPanelWidth`) and the render-time squeeze that keeps a stored layout valid when the
 * window shrinks underneath it (`effectivePanelWidths`).
 *
 * Covers: a panel's own min/max, the flexing panel's protected minimum, collapsed siblings
 * counting as rail width rather than their stored width, and a container too small to
 * satisfy every constraint (must not go below the dragged panel's own minimum).
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from '@shared/types'
import type { LayoutSettings } from '@shared/types'
import {
  clampPanelWidth,
  effectivePanelWidths,
  flexPanelId,
  RAIL_WIDTH
} from '../src/renderer/src/components/shell/layoutMath'

function layout(patch: Partial<LayoutSettings> = {}): LayoutSettings {
  return { ...DEFAULT_LAYOUT, ...patch }
}

const ALL_VISIBLE = { projects: true, timer: true, main: true }

describe('flexPanelId', () => {
  it('is the last panel in order when everything is visible', () => {
    expect(flexPanelId(DEFAULT_LAYOUT.order, ALL_VISIBLE)).toBe('main')
  })

  it('is the last VISIBLE panel when the true last is hidden on this screen', () => {
    expect(flexPanelId(DEFAULT_LAYOUT.order, { projects: true, timer: true, main: null })).toBe(
      'timer'
    )
  })
})

describe('clampPanelWidth', () => {
  const CONTAINER = 1000

  it('clamps to the panel own minimum', () => {
    expect(clampPanelWidth('projects', 10, CONTAINER, layout())).toBe(PANEL_MIN_WIDTH.projects)
  })

  it('clamps to the panel own maximum, when the container is roomy enough not to bind first', () => {
    const roomyContainer = 5000
    expect(clampPanelWidth('projects', 10_000, roomyContainer, layout())).toBe(
      PANEL_MAX_WIDTH.projects
    )
  })

  it('passes through a value already inside both the own and flex-protecting bounds', () => {
    expect(clampPanelWidth('projects', 250, CONTAINER, layout())).toBe(250)
  })

  it('protects the flexing panel minimum width', () => {
    // container 1000, timer fixed at its default 368, main (flex) needs >= 280.
    // projects can grow up to 1000 - 368 - 280 = 352 before main would be squeezed.
    const proposed = 500
    const result = clampPanelWidth('projects', proposed, CONTAINER, layout())
    expect(result).toBe(352)
    expect(result).toBeLessThanOrEqual(PANEL_MAX_WIDTH.projects)
  })

  it('counts a collapsed sibling as rail width, not its stored width, when protecting the flex panel', () => {
    const collapsedLayout = layout({ collapsed: ['timer'] })
    const proposed = 380 // inside projects' own max (420), so only the flex-protection differs
    const withTimerOpen = clampPanelWidth('projects', proposed, CONTAINER, layout())
    const withTimerCollapsed = clampPanelWidth('projects', proposed, CONTAINER, collapsedLayout)
    expect(withTimerOpen).toBe(CONTAINER - DEFAULT_LAYOUT.widths.timer - PANEL_MIN_WIDTH.main)
    expect(withTimerCollapsed).toBe(proposed)
    expect(withTimerCollapsed).toBeGreaterThan(withTimerOpen)
  })

  it('never drops below the dragged panel own minimum even when the container is too small', () => {
    const tinyContainer = 200
    const result = clampPanelWidth('projects', 300, tinyContainer, layout())
    expect(result).toBe(PANEL_MIN_WIDTH.projects)
  })

  it('ignores a hidden panel entirely when reserving space for the flex panel', () => {
    const withoutProjects = { projects: null, timer: true, main: true }
    // Only timer (368) and the dragged panel matter now; projects contributes nothing.
    const result = clampPanelWidth('timer', 900, CONTAINER, layout(), withoutProjects)
    expect(result).toBe(Math.min(PANEL_MAX_WIDTH.timer, CONTAINER - PANEL_MIN_WIDTH.main))
  })
})

describe('effectivePanelWidths', () => {
  it('returns the stored widths untouched when the container has room to spare', () => {
    const result = effectivePanelWidths(layout(), 1200, ALL_VISIBLE)
    expect(result.projects).toBe(DEFAULT_LAYOUT.widths.projects)
    expect(result.timer).toBe(DEFAULT_LAYOUT.widths.timer)
  })

  it('never touches the stored layout object — it is a read, not a write', () => {
    const l = layout()
    const snapshot = JSON.parse(JSON.stringify(l))
    effectivePanelWidths(l, 500, ALL_VISIBLE)
    expect(l).toEqual(snapshot)
  })

  it('squeezes non-flex panels proportionally so the flex panel keeps its minimum', () => {
    // Reproduces the reported bug: stored widths (projects 308, timer 408) were fine at the
    // window size they were dragged at, but the container shrank (e.g. a NavBar appeared
    // beside the shell) to 970px, which is no longer enough to also give `main` its 280px
    // minimum.
    const dragged = layout({ widths: { projects: 308, timer: 408, main: 480 } })
    const result = effectivePanelWidths(dragged, 970, ALL_VISIBLE)

    // Headroom above each panel's own minimum: projects 148, timer 108 — total 256.
    // Overflow to shed: (308 + 408) - (970 - 280) = 26. factor = 26 / 256.
    expect(result.projects).toBe(293)
    expect(result.timer).toBe(397)
    // The point of the exercise: main, the flex panel, gets exactly its minimum back.
    expect(970 - result.projects - result.timer).toBe(PANEL_MIN_WIDTH.main)
  })

  it('leaves a collapsed panel at RAIL_WIDTH and squeezes only the non-collapsed ones', () => {
    const collapsedLayout = layout({
      widths: { projects: 400, timer: 368, main: 480 },
      collapsed: ['timer']
    })
    const result = effectivePanelWidths(collapsedLayout, 700, ALL_VISIBLE)
    expect(result.timer).toBe(RAIL_WIDTH)
    // available = 700 - 280 = 420; only RAIL_WIDTH (40) + projects compete for it.
    expect(result.projects).toBe(420 - RAIL_WIDTH)
  })

  it('floors every reducible panel at its own minimum when even that leaves no room to spare', () => {
    const tiny = layout({ widths: { projects: 160, timer: 300, main: 480 } })
    const result = effectivePanelWidths(tiny, 100, ALL_VISIBLE)
    expect(result.projects).toBe(PANEL_MIN_WIDTH.projects)
    expect(result.timer).toBe(PANEL_MIN_WIDTH.timer)
  })

  it('ignores a hidden panel when computing the squeeze', () => {
    const withoutProjects = { projects: null, timer: true, main: true }
    // Only timer (368, headroom 68 above its 300 minimum) competes with main's minimum now;
    // projects' stored width is irrelevant. available = 600 - 280 = 320, so timer alone must
    // shed 48 of its 68 headroom to fit.
    const result = effectivePanelWidths(layout(), 600, withoutProjects)
    expect(result.timer).toBe(320)
  })
})
