/**
 * Daily focus-time bar chart. `daily()` already emits a contiguous, zero-filled series —
 * this component renders exactly what it receives and neither drops empty days nor
 * synthesises its own gaps.
 *
 * `DailyBucket.date` is a local 'YYYY-MM-DD' string. The compact axis label (`shortLabel`) is
 * formatted by slicing, with no `Date` at all; the weekday label (`weekdayLabel`, used for the
 * tooltip always and the axis on a 7-day range) does need a `Date` to name the day, so it
 * builds one from the key's own y/m/d fields via `new Date(y, m - 1, d)`. Neither ever goes
 * through `new Date(dateKey)` or `.toISOString()`, which reads the key as UTC and can shift
 * the label a day.
 */

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { DailyBucket } from '@shared/types'
import { formatDuration, formatHours } from '@renderer/lib/format'

/** 'YYYY-MM-DD' -> 'D MMM', without ever constructing a Date from the string. */
function shortLabel(dateKey: string): string {
  const [, m, d] = dateKey.split('-')
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ]
  const monthIndex = Number(m) - 1
  return `${Number(d)} ${months[monthIndex] ?? ''}`
}

/**
 * 'YYYY-MM-DD' -> 'Thu 24 Sep'. Unlike `shortLabel`, this one does need a real `Date` to name
 * the weekday — built from the key's own y/m/d fields via `new Date(y, m - 1, d)` (local
 * midnight), never `new Date(dateKey)` or `.toISOString()`, either of which reads the key as
 * UTC and can name the day before or after the one the key actually means.
 */
function weekdayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  })
}

interface TooltipPayload {
  active?: boolean
  payload?: Array<{ payload: DailyBucket }>
}

function ChartTooltip({ active, payload }: TooltipPayload): React.JSX.Element | null {
  if (!active || !payload?.length) return null
  const bucket = payload[0]?.payload
  if (!bucket) return null
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-2.5 py-1.5 text-[12px] shadow-lg">
      <div className="text-[var(--color-text)]">{weekdayLabel(bucket.date)}</div>
      <div className="text-[var(--color-text-muted)]">
        {formatDuration(bucket.focusMs)} · {bucket.sessions} session{bucket.sessions === 1 ? '' : 's'}
      </div>
    </div>
  )
}

export function DailyChart({ daily }: { daily: DailyBucket[] }): React.JSX.Element {
  // Dense ranges (year/all) would collide on every label; let recharts thin them out rather
  // than fighting it with a fixed interval that assumes a particular range length.
  const tickInterval = daily.length > 45 ? 'preserveStartEnd' : 0
  // A week fits the weekday on the axis without crowding ("Thu 24 Sep"); anything longer
  // falls back to the compact "D MMM" `shortLabel` so the ticks stay legible.
  const axisLabel = daily.length <= 7 ? weekdayLabel : shortLabel

  return (
    <div className="h-56 min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-3">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={daily} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
          <CartesianGrid stroke="var(--color-border)" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={axisLabel}
            interval={tickInterval}
            tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
            axisLine={{ stroke: 'var(--color-border)' }}
            tickLine={false}
            minTickGap={20}
          />
          <YAxis
            tickFormatter={formatHours}
            tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={44}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--color-surface-sunken)' }} />
          <Bar dataKey="focusMs" fill="var(--color-focus)" radius={[3, 3, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
