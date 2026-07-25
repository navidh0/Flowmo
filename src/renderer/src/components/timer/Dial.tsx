/**
 * The circular readout. Hand-rolled SVG rather than a chart library — it is two circles and
 * an arithmetic expression, and it repaints four times a second.
 *
 * Two performance decisions worth keeping:
 *  - only `stroke-dashoffset` changes between frames, which the compositor handles without
 *    a layout pass. The transition is 250ms linear to match main's tick interval exactly,
 *    so the arc glides continuously instead of stepping.
 *  - the glow is a separate blurred div, not a `filter` on the arc. A blur on the animated
 *    stroke would force a full re-rasterise of the ring every 250ms.
 *
 * The digits live in an HTML overlay, not in `<text>`, so they get the `.tabular` figures
 * and real font metrics.
 */

const SIZE = 264
const RADIUS = 118
const STROKE = 12
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const CENTER = SIZE / 2

export interface DialProps {
  /** CSS colour for the arc, glow, and leading cap. */
  accent: string
  /** Fraction of the ring to paint, 0..1. The caller decides drain-vs-fill semantics. */
  fraction: number
  /** Tick-mark track instead of a solid one — the visual signal for "no fixed target". */
  openEnded?: boolean
  /** Dims the arc. Used for armed and paused phases, which must not read as running. */
  muted?: boolean
  label: string
  /** Pre-formatted clock string. */
  time: string
  caption?: string | null
}

export function Dial({
  accent,
  fraction,
  openEnded = false,
  muted = false,
  label,
  time,
  caption
}: DialProps): React.JSX.Element {
  const clamped = Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 1) : 0
  const offset = CIRCUMFERENCE * (1 - clamped)

  // 'H:MM:SS' is two glyphs wider than 'MM:SS' and would collide with the ring at full size.
  const timeClass = time.length > 5 ? 'text-[46px]' : 'text-[62px]'

  return (
    <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-8 rounded-full blur-2xl transition-opacity duration-500"
        style={{ background: accent, opacity: muted ? 0.05 : 0.12 }}
      />

      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="absolute inset-0 h-full w-full -rotate-90"
        aria-hidden="true"
      >
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth={STROKE}
          // Butt caps keep the ticks crisp rectangles; round caps at this width blur into dashes.
          strokeLinecap="butt"
          strokeDasharray={openEnded ? '3 11' : undefined}
          opacity={openEnded ? 0.85 : 1}
        />
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          stroke={accent}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          opacity={muted ? 0.45 : 1}
          style={{
            transition: 'stroke-dashoffset 250ms linear, opacity 300ms ease',
            // A zero-length arc still paints a round cap dot; hide it so idle reads as empty.
            visibility: clamped <= 0 ? 'hidden' : 'visible'
          }}
        />
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
          {label}
        </div>
        <div
          className={`tabular ${timeClass} font-light leading-none tracking-tight`}
          style={{ color: muted ? 'var(--color-text-muted)' : 'var(--color-text)' }}
        >
          {time}
        </div>
        <div className="h-4 text-[11px] tabular text-[var(--color-text-muted)]">
          {caption ?? ''}
        </div>
      </div>
    </div>
  )
}
