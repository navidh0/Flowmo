import { DEFAULT_LAYOUT, DENSITIES } from '@shared/types'
import type { Density, PanelId, Settings } from '@shared/types'
import { Button } from '@renderer/components/timer/Button'
import { movePanel, PANEL_LABEL } from '@renderer/components/shell/layoutMath'
import { Field, Section, Select } from '../ui'

const DENSITY_LABEL: Record<Density, string> = {
  comfortable: 'Comfortable',
  compact: 'Compact'
}

function ChevronLeftIcon(): React.JSX.Element {
  return (
    <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 3.5 5 8l5 4.5" />
    </svg>
  )
}

function ChevronRightIcon(): React.JSX.Element {
  return (
    <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3.5 11 8l-5 4.5" />
    </svg>
  )
}

/** One row of the reorder list: the panel's name plus its two move buttons. */
function PanelOrderRow({
  id,
  index,
  count,
  onMove
}: {
  id: PanelId
  index: number
  count: number
  onMove: (id: PanelId, direction: 'left' | 'right') => void
}): React.JSX.Element {
  const label = PANEL_LABEL[id]
  return (
    <li className="flex items-center justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2">
      <span className="text-[12px] text-[var(--color-text)]">{label}</span>
      <span className="flex items-center gap-1">
        <button
          type="button"
          aria-label={`Move ${label} left`}
          disabled={index === 0}
          onClick={() => onMove(id, 'left')}
          className="grid h-6 w-6 place-items-center rounded-md text-[var(--color-text-muted)] outline-none transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-text-muted)]/40 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ChevronLeftIcon />
        </button>
        <button
          type="button"
          aria-label={`Move ${label} right`}
          disabled={index === count - 1}
          onClick={() => onMove(id, 'right')}
          className="grid h-6 w-6 place-items-center rounded-md text-[var(--color-text-muted)] outline-none transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-text-muted)]/40 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ChevronRightIcon />
        </button>
      </span>
    </li>
  )
}

export function LayoutSection({
  settings,
  set
}: {
  settings: Settings
  set: (patch: Partial<Settings>) => void
}): React.JSX.Element {
  const { layout } = settings

  function onMove(id: PanelId, direction: 'left' | 'right'): void {
    set({ layout: movePanel(layout, id, direction) })
  }

  return (
    <Section
      title="Layout"
      description="Arrange the three main panels, choose how much room the interface gives each element, and reset either back to default."
    >
      <ul className="flex flex-col gap-1.5" aria-label="Panel order">
        {layout.order.map((id, index) => (
          <PanelOrderRow key={id} id={id} index={index} count={layout.order.length} onMove={onMove} />
        ))}
      </ul>

      <Field label="Density" hint="Compact tightens spacing throughout the app, for small screens and long lists.">
        <Select value={settings.density} onChange={(v) => set({ density: v as Density })}>
          {DENSITIES.map((d) => (
            <option key={d} value={d}>
              {DENSITY_LABEL[d]}
            </option>
          ))}
        </Select>
      </Field>

      <div>
        <Button variant="secondary" onClick={() => set({ layout: DEFAULT_LAYOUT })}>
          Reset layout
        </Button>
      </div>
    </Section>
  )
}
