/**
 * Pure clamping arithmetic for `ResizableShell`, pulled out of the component so it can be
 * unit-tested without a DOM. Everything here is a function of its arguments only — no refs,
 * no state, no side effects.
 */

import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from '@shared/types'
import type { LayoutSettings, PanelId } from '@shared/types'

/** Width a collapsed non-flexing panel occupies — just enough for its expand affordance. */
export const RAIL_WIDTH = 40

/**
 * Display name for each panel, shared by the collapse/expand affordance in `ResizableShell`
 * and the reorder control in Settings → Layout, so the two always agree on what a panel is
 * called. `main` reads "Tasks" — what that column actually shows on the Focus screen —
 * rather than the internal `PanelId`.
 */
export const PANEL_LABEL: Record<PanelId, string> = {
  projects: 'Projects',
  timer: 'Timer',
  main: 'Tasks'
}

export type MoveDirection = 'left' | 'right'

/**
 * Moves `id` one slot left or right in `layout.order`, swapping it with its neighbour.
 * A no-op (returns `layout` unchanged) at either end — there is nothing to swap with past
 * the first or last position, so the caller's "disabled at the ends" button state and this
 * function's own behaviour agree without either needing to duplicate the other's bounds
 * check.
 *
 * The swap can change which panel flexes (the new last slot) — if that panel was collapsed,
 * collapsing the flexing panel is an invariant `LayoutSettings.collapsed` must never violate
 * (see its own doc comment), so it is dropped from `collapsed` here rather than leaving that
 * to the settings-repo validator to clean up after the fact.
 */
export function movePanel(layout: LayoutSettings, id: PanelId, direction: MoveDirection): LayoutSettings {
  const order = [...layout.order]
  const index = order.indexOf(id)
  if (index === -1) return layout

  const target = direction === 'left' ? index - 1 : index + 1
  if (target < 0 || target >= order.length) return layout

  const neighbour = order[target]
  if (neighbour === undefined) return layout
  order[target] = id
  order[index] = neighbour

  const flexing = order[order.length - 1]
  const collapsed = layout.collapsed.filter((p) => p !== flexing)

  return { ...layout, order, collapsed }
}

const ALL_VISIBLE: Partial<Record<PanelId, unknown>> = { projects: true, timer: true, main: true }

/** The panel that flexes to fill remaining space: the last VISIBLE entry in `order`. */
export function flexPanelId(order: PanelId[], panels: Partial<Record<PanelId, unknown>>): PanelId {
  const visible = order.filter((id) => panels[id] != null)
  const lastVisible = visible[visible.length - 1]
  if (lastVisible !== undefined) return lastVisible
  // `order` is always a non-empty permutation of PANEL_IDS; nothing visible falls back to
  // the nominal last slot rather than throwing.
  const lastInOrder = order[order.length - 1]
  if (lastInOrder === undefined) throw new Error('layout order must not be empty')
  return lastInOrder
}

/**
 * Clamp a proposed width for `id` to:
 *  - its own [PANEL_MIN_WIDTH, PANEL_MAX_WIDTH],
 *  - and whatever leaves the flexing panel at least its own PANEL_MIN_WIDTH, given the
 *    other visible panels' current widths (rail width if collapsed) and the container width.
 *
 * `id` must not be the flexing panel — the flexing panel has no stored width to clamp.
 */
export function clampPanelWidth(
  id: PanelId,
  proposed: number,
  containerWidth: number,
  layout: LayoutSettings,
  panels: Partial<Record<PanelId, unknown>> = ALL_VISIBLE
): number {
  const ownMin = PANEL_MIN_WIDTH[id]
  const ownMax = PANEL_MAX_WIDTH[id]
  const ownClamped = Math.min(ownMax, Math.max(ownMin, proposed))

  const visible = layout.order.filter((p) => panels[p] != null)
  const flexId = flexPanelId(layout.order, panels)

  const othersWidth = visible.reduce((sum, p) => {
    if (p === id || p === flexId) return sum
    return sum + (layout.collapsed.includes(p) ? RAIL_WIDTH : layout.widths[p])
  }, 0)

  const flexMin = PANEL_MIN_WIDTH[flexId]
  const maxAllowedForId = containerWidth - othersWidth - flexMin

  // Never go below the panel's own minimum, even if the container is too small to satisfy
  // every constraint at once — a degenerate tiny window should overflow, not disappear.
  return Math.min(ownClamped, Math.max(ownMin, maxAllowedForId))
}

/**
 * Render-time widths for the non-flexing panels, squeezed (never committed) so the flexing
 * panel keeps its minimum whenever the container is physically able to give it that.
 *
 * `clampPanelWidth` only stops a *drag* from creating a bad `layout`; it does nothing about
 * a `layout` that was fine at one window size becoming invalid at a smaller one — the window
 * shrank, not the stored widths. This is the read path for that case: it never touches
 * `layout` itself, so nothing here should ever be passed to `onLayoutCommit`.
 *
 * Non-collapsed panels are squeezed down proportionally to how much headroom each has above
 * its own minimum, floored at that minimum. Collapsed panels stay at `RAIL_WIDTH` — there is
 * nothing left to give. If even flooring every panel at its minimum still doesn't leave the
 * flex panel its minimum, the container is simply too small for a valid layout; this returns
 * the least-bad one (everything at its floor) rather than pretending a solution exists.
 */
export function effectivePanelWidths(
  layout: LayoutSettings,
  containerWidth: number,
  panels: Partial<Record<PanelId, unknown>> = ALL_VISIBLE
): Record<PanelId, number> {
  const flexId = flexPanelId(layout.order, panels)
  const others = layout.order.filter((id) => panels[id] != null && id !== flexId)

  const widths: Record<PanelId, number> = { ...layout.widths }
  for (const id of others) {
    widths[id] = layout.collapsed.includes(id) ? RAIL_WIDTH : layout.widths[id]
  }

  const totalOthers = others.reduce((sum, id) => sum + widths[id], 0)
  const flexMin = PANEL_MIN_WIDTH[flexId]
  const available = containerWidth - flexMin

  if (totalOthers <= available) return widths

  const overflow = totalOthers - available
  const reducible = others.filter((id) => !layout.collapsed.includes(id))
  const totalHeadroom = reducible.reduce((sum, id) => sum + (widths[id] - PANEL_MIN_WIDTH[id]), 0)

  if (totalHeadroom <= 0) {
    for (const id of reducible) widths[id] = PANEL_MIN_WIDTH[id]
    return widths
  }

  const factor = Math.min(1, overflow / totalHeadroom)
  for (const id of reducible) {
    const min = PANEL_MIN_WIDTH[id]
    widths[id] = Math.round(widths[id] - (widths[id] - min) * factor)
  }
  return widths
}
