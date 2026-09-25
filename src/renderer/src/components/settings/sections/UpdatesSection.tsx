/**
 * Auto-update status and controls.
 *
 * Same shape as `TodoistSection`: subscribe to `updates.onStatus` in an effect, seed with
 * `getStatus()` on mount, unsubscribe on unmount. The main-process handlers for `updates.*`
 * are wired separately (in parallel with this file) — until then `getStatus()`/`check()`
 * reject, so every call here is wrapped and a rejection degrades to quiet text instead of a
 * crash or an endless spinner.
 */

import { useEffect, useState } from 'react'
import type { Settings, UpdateStatus, UpdateUnsupportedReason } from '@shared/types'
import { Button } from '@renderer/components/timer/Button'
import { isActive, useTimerStore } from '@renderer/stores/timer'
import { formatRelativeTime, useRelativeTick } from '../integrations/relativeTime'
import { Section, ToggleRow } from '../ui'

const UNSUPPORTED_COPY: Record<UpdateUnsupportedReason, string> = {
  dev: 'Updates are off in development builds.',
  portable:
    "The portable version doesn't update itself — download new versions from the releases page.",
  deb: 'Installed from a .deb package — update it with your package manager or from the releases page.',
  'test-profile': 'Updates are off on test profiles.'
}

export function UpdatesSection({
  settings,
  set
}: {
  settings: Settings
  set: (patch: Partial<Settings>) => void
}): React.JSX.Element {
  const timerState = useTimerStore((s) => s.state)
  const sessionActive = isActive(timerState)

  const [version, setVersion] = useState<string | null>(null)
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [statusUnavailable, setStatusUnavailable] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)

  const now = useRelativeTick()

  useEffect(() => {
    let cancelled = false
    window.flowdo.app
      .getVersion()
      .then((v) => {
        if (!cancelled) setVersion(v)
      })
      .catch(() => {
        // Version display falls back to the literal below — not worth surfacing an error for.
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    window.flowdo.updates
      .getStatus()
      .then((s) => {
        if (cancelled) return
        setStatus(s)
        setStatusUnavailable(false)
      })
      .catch(() => {
        if (!cancelled) setStatusUnavailable(true)
      })

    const unsubscribe = window.flowdo.updates.onStatus((s) => {
      setStatus(s)
      setStatusUnavailable(false)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  async function handleCheck(): Promise<void> {
    setCheckError(null)
    try {
      const s = await window.flowdo.updates.check()
      setStatus(s)
      setStatusUnavailable(false)
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleInstall(): Promise<void> {
    setInstallError(null)
    try {
      await window.flowdo.updates.installNow()
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err))
    }
  }

  const checkDisabled = status?.state === 'checking' || status?.state === 'downloading'

  let statusText = ''
  let statusTone: 'normal' | 'danger' = 'normal'
  if (status) {
    switch (status.state) {
      case 'idle':
        statusText =
          status.lastCheckedAt != null
            ? `Checked ${formatRelativeTime(status.lastCheckedAt, now)}`
            : 'Not checked yet'
        break
      case 'checking':
        statusText = 'Checking for updates…'
        break
      case 'up-to-date':
        statusText = `You're up to date · checked ${formatRelativeTime(status.lastCheckedAt, now)}`
        break
      case 'available':
        statusText = `Update available — version ${status.version}`
        break
      case 'downloading':
        statusText = `Downloading ${status.version} — ${Math.round(status.percent)}%`
        break
      case 'ready':
        statusText = `Version ${status.version} is ready`
        break
      case 'unsupported':
        statusText = UNSUPPORTED_COPY[status.reason]
        break
      case 'error':
        statusText = `${status.message} · checked ${formatRelativeTime(status.lastCheckedAt, now)}`
        statusTone = 'danger'
        break
    }
  }

  return (
    <Section title="Updates" description="Keep Flowdo current.">
      <p className="text-[12px] text-[var(--color-text-muted)]">Flowdo {version ?? '0.4.0'}</p>

      <ToggleRow
        label="Update automatically"
        hint="Checks for new versions in the background and installs them the next time Flowdo restarts. Never interrupts a running session."
        checked={settings.autoUpdate}
        onChange={(v) => set({ autoUpdate: v })}
      />

      {!status && statusUnavailable ? (
        <p className="text-[12px] text-[var(--color-text-muted)]">Update status unavailable</p>
      ) : status?.state === 'unsupported' ? (
        <div className="flex flex-col items-start gap-1.5">
          <p className="text-[12px] text-[var(--color-text-muted)]">{statusText}</p>
          <a
            href={status.releasesUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[12px] text-[var(--color-focus)] underline underline-offset-2 hover:no-underline"
          >
            View releases
          </a>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {status ? (
            <p
              role="status"
              aria-live="polite"
              className={`text-[12px] ${statusTone === 'danger' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}
            >
              {statusText}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={checkDisabled}
              onClick={() => void handleCheck()}
            >
              {status?.state === 'checking' ? 'Checking…' : 'Check for updates'}
            </Button>

            {status?.state === 'ready' ? (
              <Button
                variant="primary"
                size="sm"
                disabled={sessionActive}
                onClick={() => void handleInstall()}
              >
                Restart to update
              </Button>
            ) : null}
          </div>

          {status?.state === 'ready' && sessionActive ? (
            <p className="text-[11px] text-[var(--color-text-muted)]">
              Finish or stop your current session first — Flowdo never interrupts a running
              session to update.
            </p>
          ) : null}

          {checkError ? (
            <p role="alert" className="text-[11px] text-[var(--color-danger)]">
              Couldn&rsquo;t check for updates: {checkError}
            </p>
          ) : null}

          {installError ? (
            <p role="alert" className="text-[11px] text-[var(--color-danger)]">
              {installError}
            </p>
          ) : null}
        </div>
      )}
    </Section>
  )
}
