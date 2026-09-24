/**
 * Todoist connection: connect/disconnect, health, pending/rejected changes.
 *
 * The token never lives anywhere but the password input's own DOM node while the user types
 * it, and the argument of the single `connect()` call — it is cleared from state immediately
 * after that call settles (success or failure) and on unmount, and it is never logged.
 */

import { useEffect, useRef, useState } from 'react'
import { Button } from '@renderer/components/timer/Button'
import { InlineConfirm } from '@renderer/components/tasks/ui'
import { Field, Section, TextInput } from '../ui'
import { useIntegrationsStore } from '@renderer/stores/integrations'
import { formatRelativeTime, useRelativeTick } from './relativeTime'

export function TodoistSection(): React.JSX.Element {
  const todoist = useIntegrationsStore((s) => s.todoist)
  const todoistError = useIntegrationsStore((s) => s.todoistError)
  const clearTodoistError = useIntegrationsStore((s) => s.clearTodoistError)
  const connectTodoist = useIntegrationsStore((s) => s.connectTodoist)
  const disconnectTodoist = useIntegrationsStore((s) => s.disconnectTodoist)
  const syncNow = useIntegrationsStore((s) => s.syncNow)

  const [token, setToken] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)
  const [dismissedRejections, setDismissedRejections] = useState<Set<string>>(new Set())
  const tokenRef = useRef(token)
  tokenRef.current = token

  // Never let a stray unmount leave a typed-but-unsubmitted token sitting in state.
  useEffect(() => {
    return () => {
      if (tokenRef.current) setToken('')
    }
  }, [])

  const now = useRelativeTick()

  async function handleConnect(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!token.trim()) return
    setConnecting(true)
    await connectTodoist(token)
    setConnecting(false)
    // Cleared on success AND failure — the user retypes it either way. Keeping it around
    // "for convenience" after a rejected token is exactly the kind of lingering copy this
    // section must avoid.
    setToken('')
  }

  async function handleDisconnect(): Promise<void> {
    setConfirmingDisconnect(false)
    await disconnectTodoist()
  }

  async function handleSyncNow(): Promise<void> {
    setSyncing(true)
    await syncNow()
    setSyncing(false)
  }

  const health = todoist?.health

  if (!health || health.state === 'disconnected') {
    return (
      <Section
        title="Todoist"
        description="Connect a Todoist account to sync tasks two-way. Find your token in Todoist → Settings → Integrations → Developer → API token."
      >
        <form className="flex flex-col gap-3" onSubmit={(e) => void handleConnect(e)}>
          <Field label="API token">
            <TextInput
              type="password"
              autoComplete="off"
              value={token}
              disabled={connecting}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste your Todoist API token"
            />
          </Field>
          <div>
            <Button type="submit" variant="primary" disabled={connecting || !token.trim()}>
              {connecting ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
          {todoistError ? (
            <p role="alert" className="flex items-start justify-between gap-2 text-[11px] text-[var(--color-danger)]">
              <span>{todoistError}</span>
              <button
                type="button"
                className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                onClick={clearTodoistError}
              >
                Dismiss
              </button>
            </p>
          ) : null}
        </form>
      </Section>
    )
  }

  if (health.state === 'unavailable') {
    return (
      <Section title="Todoist">
        <p className="text-[12px] leading-relaxed text-[var(--color-text-muted)]">
          Your system&rsquo;s secure storage (keyring) is missing or locked, so Flowdo can&rsquo;t
          connect Todoist — it refuses to store the token unencrypted. Unlock or configure your
          OS keyring, then reopen this screen; retrying here won&rsquo;t help until that&rsquo;s
          fixed.
        </p>
      </Section>
    )
  }

  const isAuthError = health.state === 'error' && health.kind === 'auth'
  const pendingChanges = todoist?.pendingChanges ?? 0
  const rejectedChanges = todoist?.rejectedChanges ?? []
  const visibleRejections = rejectedChanges.filter(
    (r) => !dismissedRejections.has(`${r.at}:${r.message}`)
  )

  let statusText: string
  let statusTone: 'normal' | 'warn' | 'danger' = 'normal'
  if (health.state === 'syncing') {
    statusText = 'Syncing…'
  } else if (health.state === 'ok') {
    statusText = `Synced ${formatRelativeTime(health.lastOkAt, now)}`
  } else {
    switch (health.kind) {
      case 'auth':
        statusText = 'Todoist rejected the token — reconnect with a new one'
        statusTone = 'danger'
        break
      case 'network':
        statusText = "Offline — changes are kept and will sync when you're back"
        statusTone = 'warn'
        break
      case 'rate-limit':
        statusText = 'Todoist asked Flowdo to slow down — retrying shortly'
        statusTone = 'warn'
        break
      case 'provider':
        statusText = health.message
        statusTone = 'danger'
        break
    }
  }

  const toneClass =
    statusTone === 'danger'
      ? 'text-[var(--color-danger)]'
      : statusTone === 'warn'
        ? 'text-[var(--color-text-muted)]'
        : 'text-[var(--color-text)]'

  return (
    <Section title="Todoist">
      <p role="status" aria-live="polite" className={`text-[12px] ${toneClass}`}>
        {statusText}
      </p>

      {pendingChanges > 0 ? (
        <p className="text-[11px] text-[var(--color-text-muted)]">
          {pendingChanges} change{pendingChanges === 1 ? '' : 's'} waiting to sync.
        </p>
      ) : null}

      {visibleRejections.map((r) => (
        <div
          key={`${r.at}:${r.message}`}
          className="flex items-start justify-between gap-2 rounded-md border border-[var(--color-danger)]/35 bg-[color-mix(in_srgb,var(--color-danger)_9%,var(--color-surface-raised))] p-2"
        >
          <p className="text-[11px] leading-relaxed text-[var(--color-text)]">
            Todoist rejected a change: {r.message}
          </p>
          <button
            type="button"
            aria-label="Dismiss"
            className="shrink-0 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            onClick={() =>
              setDismissedRejections((prev) => new Set(prev).add(`${r.at}:${r.message}`))
            }
          >
            Dismiss
          </button>
        </div>
      ))}

      {isAuthError ? (
        <form className="flex flex-col gap-3" onSubmit={(e) => void handleConnect(e)}>
          <Field label="New API token">
            <TextInput
              type="password"
              autoComplete="off"
              value={token}
              disabled={connecting}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste a new Todoist API token"
            />
          </Field>
          <div>
            <Button type="submit" variant="primary" disabled={connecting || !token.trim()}>
              {connecting ? 'Reconnecting…' : 'Reconnect'}
            </Button>
          </div>
        </form>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={syncing} onClick={() => void handleSyncNow()}>
          {syncing ? 'Syncing…' : 'Sync now'}
        </Button>
        <Button variant="danger" onClick={() => setConfirmingDisconnect(true)}>
          Disconnect
        </Button>
      </div>

      {confirmingDisconnect ? (
        <InlineConfirm
          message={
            <>
              Disconnecting keeps synced tasks as local tasks and keeps all logged time.
              {pendingChanges > 0
                ? ` ${pendingChanges} unsynced change${pendingChanges === 1 ? '' : 's'} will be discarded.`
                : ''}
            </>
          }
          confirmLabel="Disconnect"
          onConfirm={() => void handleDisconnect()}
          onCancel={() => setConfirmingDisconnect(false)}
        />
      ) : null}

      {todoistError ? (
        <p role="alert" className="flex items-start justify-between gap-2 text-[11px] text-[var(--color-danger)]">
          <span>{todoistError}</span>
          <button
            type="button"
            className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            onClick={clearTodoistError}
          >
            Dismiss
          </button>
        </p>
      ) : null}
    </Section>
  )
}
