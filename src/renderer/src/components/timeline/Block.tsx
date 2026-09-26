/**
 * One block on the grid: a session, the running phase, or a calendar event.
 *
 * Focusable and hoverable — both reveal the same detail card (title, times, duration, and
 * the task title once `tasks.get` resolves), so the information is reachable without a
 * mouse. Positioned by the caller via `style` (percentage top/height from `dayFraction`,
 * percentage left/width from the overlap column) — never a fixed pixel width, so the block
 * still fits a 280px panel.
 *
 * Layering (see `layoutTimeline`): calendar events are the background layer — full width of
 * their own overlap column, columned only among other events — and sessions (focus/break/
 * running) are the foreground layer, columned only among other sessions. Both layers share
 * one absolutely-positioned container, and `HourGrid`/`WeekView` render every event placement
 * before every session placement (the order `layoutTimeline` returns), so plain DOM order
 * alone paints sessions over events. Neither this component's outer wrapper nor its inner
 * block div ever takes a `z-index` (or anything else that creates a stacking context —
 * `opacity` < 1, `transform`, `filter`, `isolation`): the hover card (`role="tooltip"`,
 * `z-20`) is a child of the inner div and only wins against every sibling block when its own
 * ancestor has no stacking context of its own to trap it inside. Give a block a z-index and
 * its tooltip would be pinned under whatever sits on top of *that* block in DOM order,
 * regardless of `z-20`. (Break blocks already carry `opacity-80`, which does create a
 * stacking context — see the note in `HourGrid`'s header about the one place this bites.)
 *
 * The inner block div itself carries NO `overflow-hidden` (a pre-existing property this pass
 * moved, not removed — see below): `overflow-hidden` on that same div clipped the tooltip too,
 * which hangs off it at `top-full`, i.e. *below* the div's own box. `getBoundingClientRect()`
 * still reports a tooltip's full (unclipped) layout box regardless,
 * so this read as "visible" in every property-based check that only asked the DOM for a rect
 * or an `opacity`, and only failed a real `elementFromPoint()` hit-test — which is exactly how
 * the layered-timeline e2e suite (its over-an-event hover check) caught it. The label DOES
 * still need clipping, though: a block's own height is the actual duration at 56px/hour (Day)
 * or 48px/hour (Week), so a real few-minute session is only a handful of px tall — well under
 * the label's own line height — and without a clip its text spills downward over the gridlines
 * and whatever block comes next, past `min-h-[3px]`'s floor. So the clip moved rather than
 * disappeared: a small `absolute inset-0 overflow-hidden rounded-[4px]` div, sized to the
 * block, wraps ONLY the label span; the tooltip stays a sibling of that wrapper, outside it,
 * so it is never clipped by it. That wrapper carries no `z-index`/`opacity`/`transform`/
 * `filter`/`isolation` either — `overflow-hidden` alone does not create a stacking context, so
 * it does not add another place a tooltip could get trapped.
 *
 * The tooltip is `pointer-events-none` at rest (also pre-existing) for good reason — it sits
 * in the DOM right below every block, invisible (`opacity-0`) until hovered/focused, and
 * would otherwise silently swallow clicks/hover meant for whatever block or grid space it
 * happens to overlap when hidden (often the very next block in time). It only flips to
 * `pointer-events-auto` — via `group-hover/block:`/`group-focus-visible/block:`, the same
 * variants that drive its opacity — for the moment it is actually shown, which is also what
 * lets `elementFromPoint()` resolve to it instead of passing through to whatever it visually
 * covers underneath (an event, or a session drawn over one).
 *
 * An event's fill (`eventFill`, from `blocks.ts`) is a translucent tint of the feed colour
 * plus a solid left stripe — deliberately weaker than a session's solid fill, so "what was
 * planned" reads behind "what was done". A session drawn over an event (`overEvent`) is also
 * inset from its column's left edge, so a sliver of the event's tint — and enough of its
 * hover target — stays reachable beside it. This is a sliver, not a guarantee: a session that
 * starts right at an event's first line still covers most of the event's title, and the
 * event's own hover card is only reachable via the inset strip or above/below the session in
 * time, never through the session itself.
 *
 * The label text is `--color-on-swatch` (near-black in both themes — see its own comment in
 * index.css), never `--color-on-accent`: `block.color` is always a "swatch" in the sense that
 * matters here — either a project/calendar-feed colour a person picked freely (amber, lime,
 * cyan, …), or blocks.ts's own NEUTRAL/BREAK_COLOR/EVENT_COLOR fallback (a no-project
 * session, a break, an uncoloured feed), which point at the theme-independent
 * `--color-swatch-*` tokens for exactly this reason. Light mode's `--color-on-accent` is
 * near-white — readable on the *design* accents (`--color-focus`/`--color-break`/…) this
 * file's light palette deliberately darkens, not on any of the above, where it can drop to
 * ~2:1. An abandoned (stopped-early) block has no real fill behind its text — just the
 * dashed stripe pattern over whatever the page surface is — so it uses plain `--color-text`
 * instead, the same as everything else sitting directly on the surface. An event block also
 * uses plain `--color-text` — its background is only a 22% tint, too light for
 * `--color-on-swatch`'s near-black-on-anything assumption to be the point.
 */

import { useTimelineStore } from '@renderer/stores/timeline'
import { formatDuration } from '@renderer/lib/format'
import { formatClockTime, formatEventStart } from './format'
import { eventFill, type TimelineBlock } from './blocks'

/** Session-only kind styling. Events are styled separately below — `eventFill` supplies
 *  their background/border, and they never take a ring (nothing is ever drawn over them). */
const SESSION_KIND_STYLE: Record<Exclude<TimelineBlock['kind'], 'event'>, string> = {
  // The 1px surface-coloured ring separates a session's solid fill from the tinted event it
  // may sit over; the running kinds keep their own (wider, brighter) ring instead of stacking
  // a second one — Tailwind's `ring-*` utilities share one box-shadow layer, so only one wins.
  focus: 'ring-1 ring-inset ring-[var(--color-surface)]',
  break: 'opacity-80 ring-1 ring-inset ring-[var(--color-surface)]',
  'running-focus': 'ring-2 ring-inset ring-white/40',
  'running-break': 'opacity-80 ring-2 ring-inset ring-white/40'
}

/** The gap a session drawn over an event insets from its column's left edge, matched in the
 *  width it loses — small enough to stay a sliver on a narrow panel (`min(1.25rem, 22%)`),
 *  not a fixed px width (forbidden under components/ — see scripts/sweep.mjs). */
const OVER_EVENT_INSET = 'min(1.25rem, 22%)'

export interface BlockProps {
  block: TimelineBlock
  /** 0-based column and total columns within this block's own layer (events among events,
   *  sessions among sessions) — from `layoutTimeline`. */
  column: number
  columns: number
  /** Vertical position as a 0..1 fraction of the day, from `dayFraction` — computed by the
   *  caller so this component stays free of date arithmetic. */
  startFraction: number
  endFraction: number
  /** 'event' for a calendar event (background layer), 'session' for focus/break/running
   *  (foreground layer) — from `layoutTimeline`. */
  layer: 'event' | 'session'
  /** Sessions only: true when this session overlaps a calendar event in time, so it should
   *  inset from its column's left edge to leave the event reachable beside it. Always false
   *  for events. */
  overEvent: boolean
}

export function Block({
  block,
  column,
  columns,
  startFraction,
  endFraction,
  layer,
  overEvent
}: BlockProps): React.JSX.Element {
  const getTaskTitle = useTimelineStore((s) => s.getTaskTitle)
  const taskTitle = block.taskId !== null ? getTaskTitle(block.taskId) : null

  const durationMs = block.endMs - block.startMs
  // The END always reads in local time — only the START also carries the event's own zone
  // when that reads differently (`formatEventStart`); positioning itself never changes, only
  // this label. Sessions/running blocks have `timeZone: null`, so this is just the local
  // start for them, same as before.
  const startLabel = formatEventStart(block.startMs, block.timeZone)
  const timeRange = `${startLabel} – ${formatClockTime(block.endMs)}${block.continues ? ' (continues past midnight)' : ''}`
  const label = [
    block.title,
    taskTitle ? `Task: ${taskTitle}` : null,
    timeRange,
    formatDuration(durationMs),
    block.abandoned ? 'stopped early' : null,
    block.continues ? 'continues past midnight' : null
  ]
    .filter(Boolean)
    .join(' · ')

  const isEvent = layer === 'event'

  const widthPct = 100 / columns
  const leftPct = column * widthPct
  // A small gutter between side-by-side columns, expressed as a fraction of one column's
  // own width rather than a fixed px gap, so it still reads at the panel's minimum width.
  const gutter = columns > 1 ? 2 : 0

  // A session over an event insets from its column's left edge, leaving a sliver of the
  // event's tint (and its hover target) reachable beside it. Events always take their full
  // column — nothing is ever drawn over an event, so it never insets.
  const horizontal = overEvent
    ? {
        left: `calc(${leftPct}% + ${OVER_EVENT_INSET})`,
        width: `calc(${widthPct}% - ${OVER_EVENT_INSET})`
      }
    : { left: `${leftPct}%`, width: `${widthPct}%` }

  return (
    <div
      className="absolute px-px"
      style={{
        top: `${startFraction * 100}%`,
        height: `${Math.max(endFraction - startFraction, 0.004) * 100}%`,
        ...horizontal
      }}
    >
      <div
        tabIndex={0}
        aria-label={label}
        title={label}
        className={`group/block relative h-full min-h-[3px] w-full rounded-[4px] text-left text-[10px] leading-tight outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-text-muted)]/40 ${
          isEvent
            ? 'text-[var(--color-text)]'
            : block.abandoned
              ? 'bg-[repeating-linear-gradient(135deg,var(--tint),var(--tint)_4px,transparent_4px,transparent_8px)] text-[var(--color-text)]'
              : 'text-[var(--color-on-swatch)]'
        } ${isEvent ? '' : SESSION_KIND_STYLE[block.kind as Exclude<TimelineBlock['kind'], 'event'>]}`}
        style={
          {
            marginRight: `${gutter}%`,
            ...(isEvent
              ? eventFill(block.color)
              : {
                  backgroundColor: block.abandoned ? 'transparent' : block.color,
                  border: block.abandoned ? `1.5px dashed ${block.color}` : undefined
                }),
            '--tint': block.color
          } as React.CSSProperties & { '--tint': string }
        }
      >
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[4px]">
          <span className="block truncate px-1 py-0.5 font-medium">{block.title}</span>
        </div>

        <div
          role="tooltip"
          className="pointer-events-none absolute left-0 top-full z-20 mt-1 w-max max-w-[220px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-[11px] normal-case text-[var(--color-text)] opacity-0 shadow-lg transition-opacity duration-100 group-hover/block:pointer-events-auto group-hover/block:opacity-100 group-focus-visible/block:pointer-events-auto group-focus-visible/block:opacity-100"
        >
          <p className="font-medium">{block.title}</p>
          {taskTitle ? <p className="text-[var(--color-text-muted)]">{taskTitle}</p> : null}
          <p className="text-[var(--color-text-muted)]">{timeRange}</p>
          <p className="text-[var(--color-text-muted)]">{formatDuration(durationMs)}</p>
          {block.abandoned ? <p className="text-[var(--color-text-muted)]">Stopped early</p> : null}
          {block.location ? <p className="text-[var(--color-text-muted)]">{block.location}</p> : null}
        </div>
      </div>
    </div>
  )
}
