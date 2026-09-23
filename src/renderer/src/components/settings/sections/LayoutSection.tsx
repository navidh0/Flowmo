import { DEFAULT_LAYOUT } from '@shared/types'
import type { Settings } from '@shared/types'
import { Button } from '@renderer/components/timer/Button'
import { Section } from '../ui'

export function LayoutSection({
  set
}: {
  set: (patch: Partial<Settings>) => void
}): React.JSX.Element {
  return (
    <Section
      title="Layout"
      description="Restore the three main panels to their default widths and order — the escape hatch if a divider ever gets dragged to zero."
    >
      <div>
        <Button variant="secondary" onClick={() => set({ layout: DEFAULT_LAYOUT })}>
          Reset layout
        </Button>
      </div>
    </Section>
  )
}
