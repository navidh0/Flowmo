/**
 * Todoist sync + calendar feeds. Owns `useIntegrationsStore`'s lifecycle: mounts subscribe to
 * `todoist.onStatus`, unmounts tear it down, matching the pattern `stores/stats.ts` uses for
 * `timer.onPhaseEnd`.
 *
 * The main-process handlers for these channels are wired up in a later wave; until then every
 * call rejects. That rejection surfaces as an ordinary, visible error in each sub-section —
 * this must never crash the rest of the settings screen.
 */

import { useEffect } from 'react'
import { useIntegrationsStore } from '@renderer/stores/integrations'
import { CalendarsSection } from './CalendarsSection'
import { TodoistSection } from './TodoistSection'

export function IntegrationsSection(): React.JSX.Element {
  const init = useIntegrationsStore((s) => s.init)
  const dispose = useIntegrationsStore((s) => s.dispose)

  useEffect(() => {
    void init()
    return () => dispose()
  }, [init, dispose])

  return (
    <>
      <TodoistSection />
      <CalendarsSection />
    </>
  )
}
