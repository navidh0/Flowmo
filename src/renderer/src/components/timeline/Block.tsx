/**
 * One block on the grid: a session, the running phase, or a calendar event.
 *
 * Focusable and hoverable — both reveal the same detail card (title, times, duration, and
 * the task title once `tasks.get` resolves), so the information is reachable without a
 * mouse. Positioned by the caller via `style` (percentage top/height from `dayFraction`,
 * percentage left/width from the overlap column) — never a fixed pixel width, so the block
 * still fits a 280px panel.
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
 * instead, the same as everything else sitting directly on the surface.
 */

import { useTimelineStore } from '@renderer/stores/timeline'
import { formatDuration } from '@renderer/lib/format'
import { formatClockTime, formatEventStart } from './format'
import type { TimelineBlock } from './blocks'

const KIND_STYLE: Record<TimelineBlock['kind'], string> = {
  focus: '',
  break: 'opacity-80',
  'running-focus': 'ring-2 ring-inset ring-white/40',
  'running-break': 'opacity-80 ring-2 ring-inset ring-white/40',
  event: 'border border-dashed border-white/0'
}

export interface BlockProps {
  block: TimelineBlock
  /** 0-based column and total columns from `layoutOverlaps`. */
  column: number
  columns: number
  /** Vertical position as a 0..1 fraction of the day, from `dayFraction` — computed by the
   *  caller so this component stays free of date arithmetic. */
  startFraction: number
  endFraction: number
}

export function Block({
  block,
  column,
  columns,
  startFraction,
  endFraction
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

  const widthPct = 100 / columns
  const leftPct = column * widthPct
  // A small gutter between side-by-side columns, expressed as a fraction of one column's
  // own width rather than a fixed px gap, so it still reads at the panel's minimum width.
  const gutter = columns > 1 ? 2 : 0

  return (
    <div
      className="absolute px-px"
      style={{
        top: `${startFraction * 100}%`,
        height: `${Math.max(endFraction - startFraction, 0.004) * 100}%`,
        left: `${leftPct}%`,
        width: `${widthPct}%`
      }}
    >
      <div
        tabIndex={0}
        aria-label={label}
        title={label}
        className={`group/block relative h-full min-h-[3px] w-full overflow-hidden rounded-[4px] text-left text-[10px] leading-tight outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-text-muted)]/40 ${
          block.abandoned
            ? 'bg-[repeating-linear-gradient(135deg,var(--tint),var(--tint)_4px,transparent_4px,transparent_8px)] text-[var(--color-text)]'
            : 'text-[var(--color-on-swatch)]'
        } ${KIND_STYLE[block.kind]}`}
        style={
          {
            marginRight: `${gutter}%`,
            backgroundColor: block.abandoned ? 'transparent' : block.color,
            border: block.abandoned ? `1.5px dashed ${block.color}` : undefined,
            '--tint': block.color
          } as React.CSSProperties & { '--tint': string }
        }
      >
        <span className="pointer-events-none block truncate px-1 py-0.5 font-medium">
          {block.title}
        </span>

        <div
          role="tooltip"
          className="pointer-events-none absolute left-0 top-full z-20 mt-1 w-max max-w-[220px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-[11px] normal-case text-[var(--color-text)] opacity-0 shadow-lg transition-opacity duration-100 group-hover/block:opacity-100 group-focus-visible/block:opacity-100"
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
