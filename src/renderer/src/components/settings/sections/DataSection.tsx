/**
 * Export/import the whole database.
 *
 * The IPC handlers (`data:exportJson` / `data:importJson`) are wired up by the orchestrator
 * in a later wave; until then the preload call rejects. That rejection is handled here as an
 * ordinary, visible error rather than an unhandled promise — this section must not crash the
 * settings screen just because main hasn't grown the handler yet.
 */

import { useState } from 'react'
import { Button } from '@renderer/components/timer/Button'
import { Section } from '../ui'

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function DataSection(): React.JSX.Element {
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleExport(): Promise<void> {
    setBusy('export')
    setError(null)
    setMessage(null)
    try {
      const result = await window.flowdo.data.exportJson()
      setMessage(
        result.path ? `Exported ${result.sessions} sessions to ${result.path}.` : 'Export cancelled.'
      )
    } catch (err) {
      setError(`Export isn't available yet: ${describeError(err)}`)
    } finally {
      setBusy(null)
    }
  }

  async function handleImport(): Promise<void> {
    setBusy('import')
    setError(null)
    setMessage(null)
    try {
      const result = await window.flowdo.data.importJson()
      setMessage(
        result.path
          ? `Imported ${result.sessions} sessions. Previous database backed up to ${result.backupPath}.`
          : 'Import cancelled.'
      )
    } catch (err) {
      setError(`Import isn't available yet: ${describeError(err)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section
      title="Data"
      description="Export the whole database to a file, or replace it from one. Importing overwrites current history after a backup."
    >
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={busy !== null} onClick={() => void handleExport()}>
          {busy === 'export' ? 'Exporting…' : 'Export data'}
        </Button>
        <Button variant="secondary" disabled={busy !== null} onClick={() => void handleImport()}>
          {busy === 'import' ? 'Importing…' : 'Import data'}
        </Button>
      </div>
      {message ? <p className="text-[11px] text-[var(--color-text-muted)]">{message}</p> : null}
      {error ? <p className="text-[11px] text-[var(--color-danger)]">{error}</p> : null}
    </Section>
  )
}
