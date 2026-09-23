/**
 * Per-project focus time. `byProject` can return `projectId: 0` — the synthetic
 * "No project" bucket for sessions whose project was deleted or never set — and it renders
 * exactly like any other row here, coloured with whatever `color` the bucket carries.
 */

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { ProjectBucket } from '@shared/types'
import { formatDuration, formatHours } from '@renderer/lib/format'

interface TooltipPayload {
  active?: boolean
  payload?: Array<{ payload: ProjectBucket }>
}

function ChartTooltip({ active, payload }: TooltipPayload): React.JSX.Element | null {
  if (!active || !payload?.length) return null
  const bucket = payload[0]?.payload
  if (!bucket) return null
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-2.5 py-1.5 text-[12px] shadow-lg">
      <div className="text-[var(--color-text)]">{bucket.projectName}</div>
      <div className="text-[var(--color-text-muted)]">
        {formatDuration(bucket.focusMs)} · {bucket.sessions} session{bucket.sessions === 1 ? '' : 's'}
      </div>
    </div>
  )
}

/** Truncate long project names for the axis; the tooltip has the full name. */
function axisLabel(name: string): string {
  return name.length > 14 ? `${name.slice(0, 13)}…` : name
}

export function ProjectBreakdown({ byProject }: { byProject: ProjectBucket[] }): React.JSX.Element {
  const sorted = [...byProject].sort((a, b) => b.focusMs - a.focusMs)
  // Cap the bar height per row so a project-heavy account doesn't grow the panel unbounded;
  // ResponsiveContainer still owns the width.
  const height = Math.max(sorted.length * 34, 60)

  return (
    <div className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-3">
      <h3 className="mb-2 text-[12px] font-medium text-[var(--color-text)]">By project</h3>
      <div style={{ height }} className="min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={sorted}
            layout="vertical"
            margin={{ top: 0, right: 12, left: 0, bottom: 0 }}
          >
            <XAxis
              type="number"
              tickFormatter={formatHours}
              tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="projectName"
              tickFormatter={axisLabel}
              tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={90}
            />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--color-surface-sunken)' }} />
            <Bar dataKey="focusMs" radius={[0, 3, 3, 0]} maxBarSize={18}>
              {sorted.map((bucket) => (
                <Cell key={bucket.projectId} fill={bucket.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
