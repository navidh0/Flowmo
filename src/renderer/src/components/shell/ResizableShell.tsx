/**
 * The three-column (or fewer) main shell, resizable and collapsible.
 *
 * Ownership split: this component owns pixel-level drag/keyboard/collapse *interaction* and
 * commits a finished `LayoutSettings` upward. It never decides what a panel means, and it
 * never persists anything itself — `onLayoutCommit` is the only way state leaves this file,
 * and every interaction (drag release, dblclick, keyup, collapse toggle) fires it exactly
 * once. A SQLite write, a broadcast, and a tray update ride on each commit in main, so firing
 * it per-pointermove would turn every drag into a write storm.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react'
import { DEFAULT_LAYOUT, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from '@shared/types'
import type { LayoutSettings, PanelId } from '@shared/types'
import { clampPanelWidth, effectivePanelWidths, flexPanelId } from './layoutMath'

const PANEL_LABEL: Record<PanelId, string> = {
  projects: 'Projects',
  timer: 'Timer',
  main: 'Main'
}

const KEYBOARD_STEP = 16

/** The visible line is 3px, but that's an unreliable target for a real mouse — the
 *  hit area is widened to this, centred on the line. */
const DIVIDER_HIT_WIDTH = 9
const DIVIDER_LINE_WIDTH = 3

export interface ResizableShellProps {
  /** null = this panel is not shown on the current screen: no space, no divider. */
  panels: Record<PanelId, ReactNode | null>
  layout: LayoutSettings
  onLayoutCommit: (layout: LayoutSettings) => void
}

export function ResizableShell({
  panels,
  layout,
  onLayoutCommit
}: ResizableShellProps): React.JSX.Element {
  const [local, setLocal] = useState(layout)
  const draggingRef = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const containerWidthRef = useRef(0)
  // Starts as "unknown, assume roomy" rather than 0 — 0 would squeeze every panel to its
  // floor for the one frame before the ResizeObserver's first measurement lands.
  const [containerWidth, setContainerWidth] = useState(Number.POSITIVE_INFINITY)

  // Resync from outside (e.g. "Reset layout" in settings) unless a drag is in flight —
  // clobbering local state mid-drag would fight the user's own pointer.
  useEffect(() => {
    if (!draggingRef.current) setLocal(layout)
  }, [layout])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    containerWidthRef.current = el.clientWidth
    setContainerWidth(el.clientWidth)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      containerWidthRef.current = entry.contentRect.width
      // Window resizes are a read-time concern only — this never touches `layout` and
      // never calls `onLayoutCommit`. The stored widths are untouched; only what's drawn
      // this frame is squeezed.
      setContainerWidth(entry.contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const visible = local.order.filter((id) => panels[id] != null)
  const flexId = flexPanelId(local.order, panels)
  const effectiveWidths = effectivePanelWidths(local, containerWidth, panels)

  function commit(next: LayoutSettings): void {
    setLocal(next)
    onLayoutCommit(next)
  }

  function startDrag(id: PanelId, startEvent: PointerEvent<HTMLDivElement>): void {
    if (id === flexId || local.collapsed.includes(id)) return
    if (startEvent.button !== 0) return

    // Without this, once the pointer travels far enough Chromium hands the gesture to a
    // native drag/selection behaviour and the pointer event stream simply stops — no
    // pointerup, no pointercancel, nothing. The divider would then move a fixed amount
    // regardless of drag distance and never commit until the next unrelated pointerdown.
    startEvent.preventDefault()

    const startX = startEvent.clientX
    const startWidth = local.widths[id]
    const layoutAtStart = local
    const el = startEvent.currentTarget
    el.setPointerCapture(startEvent.pointerId)
    draggingRef.current = true

    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    let latest: LayoutSettings = layoutAtStart
    let ended = false

    function onMove(e: globalThis.PointerEvent): void {
      const delta = e.clientX - startX
      const clamped = clampPanelWidth(
        id,
        startWidth + delta,
        containerWidthRef.current,
        layoutAtStart,
        panels
      )
      latest = { ...layoutAtStart, widths: { ...layoutAtStart.widths, [id]: clamped } }
      setLocal(latest)
    }

    function endDrag(): void {
      // Several listeners below can each observe the end of the same gesture (release,
      // lost capture, window blur, the window-level fallback) — commit exactly once.
      if (ended) return
      ended = true

      draggingRef.current = false
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevUserSelect
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('lostpointercapture', onUp)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('blur', endDrag)
      onLayoutCommit(latest)
    }

    function onUp(): void {
      endDrag()
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('lostpointercapture', onUp)
    // Fallback for the case capture is lost silently (observed with a real OS-level mouse
    // drag): a window-level pointerup and a window blur both end the drag too.
    window.addEventListener('pointerup', onUp)
    window.addEventListener('blur', endDrag)
  }

  function resetPanel(id: PanelId): void {
    commit({ ...local, widths: { ...local.widths, [id]: DEFAULT_LAYOUT.widths[id] } })
  }

  function toggleCollapsed(id: PanelId): void {
    const collapsed = local.collapsed.includes(id)
      ? local.collapsed.filter((p) => p !== id)
      : [...local.collapsed, id]
    commit({ ...local, collapsed })
  }

  function onDividerKeyDown(id: PanelId, e: KeyboardEvent<HTMLDivElement>): void {
    if (local.collapsed.includes(id)) return
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const delta = e.key === 'ArrowRight' ? KEYBOARD_STEP : -KEYBOARD_STEP
    const clamped = clampPanelWidth(
      id,
      local.widths[id] + delta,
      containerWidthRef.current,
      local,
      panels
    )
    setLocal((prev) => ({ ...prev, widths: { ...prev.widths, [id]: clamped } }))
  }

  function onDividerKeyUp(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    // `local` here reflects the last keydown's update (same render pass as this listener).
    onLayoutCommit(local)
  }

  return (
    <div ref={containerRef} className="flex h-full min-h-0 min-w-0 flex-1">
      {visible.map((id) => {
        const isFlex = id === flexId
        const isCollapsed = !isFlex && local.collapsed.includes(id)

        if (isFlex) {
          return (
            <div key={id} className="min-w-0 flex-1">
              {panels[id]}
            </div>
          )
        }

        // `effectiveWidths` already maps a collapsed panel to RAIL_WIDTH and squeezes the
        // rest so the flex panel keeps its minimum at the current container width — this is
        // draw-time only and is never fed back into `local` or `onLayoutCommit`.
        const width = effectiveWidths[id]

        return (
          <div key={id} className="flex h-full shrink-0" style={{ width }}>
            <div className="h-full min-w-0 flex-1 overflow-hidden">
              {!isCollapsed && panels[id]}
            </div>

            <div
              className="group relative flex shrink-0 cursor-col-resize touch-none select-none items-stretch justify-center outline-none"
              style={{ width: DIVIDER_HIT_WIDTH }}
              role="separator"
              aria-orientation="vertical"
              aria-valuenow={width}
              aria-valuemin={PANEL_MIN_WIDTH[id]}
              aria-valuemax={PANEL_MAX_WIDTH[id]}
              tabIndex={0}
              draggable={false}
              onPointerDown={(e) => startDrag(id, e)}
              onDoubleClick={() => resetPanel(id)}
              onKeyDown={(e) => onDividerKeyDown(id, e)}
              onKeyUp={onDividerKeyUp}
            >
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 bg-[var(--color-border)] group-hover:bg-[var(--color-focus)] group-focus-visible:bg-[var(--color-focus)]"
                style={{ width: DIVIDER_LINE_WIDTH }}
              />

              <button
                type="button"
                className="absolute top-2 z-10 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-text-muted)] opacity-0 transition-opacity hover:text-[var(--color-text)] focus-visible:opacity-100 group-hover:opacity-100"
                aria-label={isCollapsed ? `Expand ${PANEL_LABEL[id]}` : `Collapse ${PANEL_LABEL[id]}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleCollapsed(id)
                }}
              >
                {isCollapsed ? <ChevronRight /> : <ChevronLeft />}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ChevronLeft(): React.JSX.Element {
  return (
    <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 3.5 5 8l5 4.5" />
    </svg>
  )
}

function ChevronRight(): React.JSX.Element {
  return (
    <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3.5 11 8l-5 4.5" />
    </svg>
  )
}
