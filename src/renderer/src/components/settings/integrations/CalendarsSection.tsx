/**
 * Calendar feeds: read-only iCal subscriptions layered onto the timer's day view.
 *
 * The feed URL is a credential exactly like the Todoist token: it is only ever sent to main as
 * the argument of `add()`, never rendered back (no channel returns one, by design) and cleared
 * from this form's state on success and on unmount.
 */

import { useEffect, useRef, useState } from 'react'
import type { CalendarFeed } from '@shared/types'
import { Button } from '@renderer/components/timer/Button'
import { InlineConfirm } from '@renderer/components/tasks/ui'
import { Field, Section, TextInput } from '../ui'
import { useIntegrationsStore } from '@renderer/stores/integrations'
import { formatRelativeTime, useRelativeTick } from './relativeTime'

/** Small fixed palette — feed colour is the one place a raw hex is a data value, not a token. */
const PALETTE = ['#22c55e', '#3b82f6', '#f97316', '#ec4899', '#a855f7', '#eab308', '#14b8a6', '#ef4444']

function ColorPicker({
  value,
  onChange
}: {
  value: string
  onChange: (color: string) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Colour">
      {PALETTE.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={color}
          className="h-6 w-6 rounded-full border-2 transition-transform enabled:hover:scale-110"
          style={{
            backgroundColor: color,
            borderColor: value === color ? 'var(--color-text)' : 'transparent'
          }}
          onClick={() => onChange(color)}
        />
      ))}
    </div>
  )
}

function FeedRow({ feed }: { feed: CalendarFeed }): React.JSX.Element {
  const updateFeed = useIntegrationsStore((s) => s.updateFeed)
  const removeFeed = useIntegrationsStore((s) => s.removeFeed)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(feed.name)
  const [pickingColor, setPickingColor] = useState(false)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const now = useRelativeTick()

  function commitName(): void {
    setRenaming(false)
    const trimmed = name.trim()
    if (trimmed && trimmed !== feed.name) void updateFeed(feed.id, { name: trimmed })
    else setName(feed.name)
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-[var(--color-border)] p-2.5">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-3 w-3 shrink-0 rounded-full"
          style={{ backgroundColor: feed.color }}
        />
        {renaming ? (
          <input
            autoFocus
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-1.5 py-0.5 text-[12px] text-[var(--color-text)] outline-none"
            value={name}
            aria-label="Feed name"
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitName()
              }
              if (e.key === 'Escape') {
                setName(feed.name)
                setRenaming(false)
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-[12px] text-[var(--color-text)] hover:underline"
            onClick={() => setRenaming(true)}
          >
            {feed.name}
          </button>
        )}
        <span
          role="switch"
          aria-checked={feed.enabled}
          aria-label={`${feed.name} enabled`}
          className="relative h-5 w-9 shrink-0 rounded-full border border-[var(--color-border)]"
          style={{ backgroundColor: feed.enabled ? 'var(--color-focus)' : 'var(--color-surface-sunken)' }}
        >
          <input
            type="checkbox"
            className="absolute inset-0 m-0 h-full w-full cursor-pointer opacity-0"
            checked={feed.enabled}
            onChange={(e) => void updateFeed(feed.id, { enabled: e.target.checked })}
          />
          <span
            className="pointer-events-none absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-[left]"
            style={{ left: feed.enabled ? '18px' : '2px' }}
          />
        </span>
      </div>

      <p className="text-[11px] text-[var(--color-text-muted)]">
        {feed.lastOkAt ? `As of ${formatRelativeTime(feed.lastOkAt, now)}` : 'Not refreshed yet'}
      </p>
      {feed.lastError ? (
        <p className="text-[11px] text-[var(--color-danger)]">{feed.lastError}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => setPickingColor((v) => !v)}>
          Colour
        </Button>
        <Button variant="danger" size="sm" onClick={() => setConfirmingRemove(true)}>
          Remove
        </Button>
      </div>
      {pickingColor ? (
        <ColorPicker
          value={feed.color}
          onChange={(color) => {
            void updateFeed(feed.id, { color })
            setPickingColor(false)
          }}
        />
      ) : null}
      {confirmingRemove ? (
        <InlineConfirm
          message={`Remove "${feed.name}"? Its cached events and stored address are deleted.`}
          confirmLabel="Remove"
          onConfirm={() => {
            setConfirmingRemove(false)
            void removeFeed(feed.id)
          }}
          onCancel={() => setConfirmingRemove(false)}
        />
      ) : null}
    </div>
  )
}

function AddFeedForm(): React.JSX.Element {
  const addFeed = useIntegrationsStore((s) => s.addFeed)
  const feedsError = useIntegrationsStore((s) => s.feedsError)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [urlTouched, setUrlTouched] = useState(false)
  const [color, setColor] = useState(PALETTE[0])
  const [adding, setAdding] = useState(false)
  const urlRef = useRef(url)
  urlRef.current = url

  useEffect(() => {
    return () => {
      if (urlRef.current) setUrl('')
    }
  }, [])

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!name.trim() || !url.trim()) return
    setAdding(true)
    const ok = await addFeed({ name: name.trim(), url: url.trim(), color })
    setAdding(false)
    if (ok) {
      setUrl('')
      setName('')
      setUrlTouched(false)
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(e)}>
      <Field label="Name">
        <TextInput
          value={name}
          disabled={adding}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Work calendar"
        />
      </Field>
      <Field
        label="Secret iCal address"
        hint="It's private, stored encrypted, and never shown again once added."
      >
        <TextInput
          type={urlTouched ? 'text' : 'password'}
          autoComplete="off"
          value={url}
          disabled={adding}
          onFocus={() => setUrlTouched(true)}
          onBlur={() => setUrlTouched(false)}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://calendar.google.com/calendar/ical/..."
        />
      </Field>
      <Field label="Colour">
        <ColorPicker value={color} onChange={setColor} />
      </Field>
      <div>
        <Button type="submit" variant="primary" disabled={adding || !name.trim() || !url.trim()}>
          {adding ? 'Adding…' : 'Add calendar'}
        </Button>
      </div>
      {feedsError ? (
        <p role="alert" className="text-[11px] text-[var(--color-danger)]">
          {feedsError}
        </p>
      ) : null}
    </form>
  )
}

export function CalendarsSection(): React.JSX.Element {
  const feeds = useIntegrationsStore((s) => s.feeds)
  const secureStorageAvailable = useIntegrationsStore((s) => s.secureStorageAvailable)
  const refreshFeedsNow = useIntegrationsStore((s) => s.refreshFeedsNow)
  const [refreshing, setRefreshing] = useState(false)

  async function handleRefresh(): Promise<void> {
    setRefreshing(true)
    await refreshFeedsNow()
    setRefreshing(false)
  }

  return (
    <Section
      title="Calendars"
      description="Add a read-only calendar feed. In Google Calendar: the calendar's ⋮ menu → Settings and sharing → “Secret address in iCal format”. Events shown can lag a little behind the source."
    >
      {feeds.length > 0 ? (
        <div className="flex flex-col gap-2">
          {feeds.map((feed) => (
            <FeedRow key={feed.id} feed={feed} />
          ))}
          <div>
            <Button variant="secondary" size="sm" disabled={refreshing} onClick={() => void handleRefresh()}>
              {refreshing ? 'Refreshing…' : 'Refresh now'}
            </Button>
          </div>
        </div>
      ) : null}

      {secureStorageAvailable ? (
        <AddFeedForm />
      ) : (
        <p className="text-[12px] leading-relaxed text-[var(--color-text-muted)]">
          Your system&rsquo;s secure storage (keyring) is missing or locked, so Flowdo can&rsquo;t
          add a calendar feed — it refuses to store the address unencrypted. Unlock or configure
          your OS keyring, then reopen this screen; retrying here won&rsquo;t help until
          that&rsquo;s fixed.
        </p>
      )}
    </Section>
  )
}
