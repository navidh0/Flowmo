/**
 * Daily focus-time bar chart. `daily()` already emits a contiguous, zero-filled series —
 * this component renders exactly what it receives and neither drops empty days nor
 * synthesises its own gaps.
 *
 * `DailyBucket.date` is a local 'YYYY-MM-DD' string. It is formatted for the axis by
 * slicing, never by round-tripping through `new Date(dateKey).toISOString()`, which reads
 * the key as UTC and can shift the label a day.
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
      <div className="text-[var(--color-text)]">{shortLabel(bucket.date)}</div>
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

  return (
    <div className="h-56 min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-3">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={daily} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
          <CartesianGrid stroke="var(--color-border)" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={shortLabel}
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
