/**
 * Rebinds one global hotkey.
 *
 * `probeHotkey` registers, checks, and immediately unregisters the accelerator — so the
 * result shown here (free / taken / invalid / unavailable) reflects reality at the moment of
 * capture, not a stale guess. Conflicts between `hotkeyStartPause` and `hotkeySkip` sharing
 * one accelerator are NOT reported by the probe (probing the app's own current binding
 * reports 'free' by design) and are checked here instead, against the sibling field's live
 * value.
 */

import { useEffect, useRef, useState } from 'react'
import type { HotkeyProbe } from '@shared/types'
import { Button } from '@renderer/components/timer/Button'
import { XIcon } from '@renderer/components/timer/icons'
import { Field } from './ui'
import { acceleratorFromEvent } from './hotkeyCapture'

export interface HotkeyFieldProps {
  label: string
  hint?: string
  /** '' means the hotkey is off. */
  value: string
  /** The other action's current accelerator, to catch the two colliding with each other. */
  conflictsWith: string
  onCommit: (accelerator: string) => void
  /** Failure main most recently reported for THIS action, if any. */
  activeFailure?: { reason: 'taken' | 'invalid' | 'unavailable' } | null
}

type LiveResult = { kind: 'probe'; probe: HotkeyProbe } | { kind: 'own-conflict' } | null

export function HotkeyField({
  label,
  hint,
  value,
  conflictsWith,
  onCommit,
  activeFailure
}: HotkeyFieldProps): React.JSX.Element {
  const [recording, setRecording] = useState(false)
  const [captured, setCaptured] = useState<string | null>(null)
  const [live, setLive] = useState<LiveResult>(null)
  const probeToken = useRef(0)

  // The app's own global shortcuts would otherwise fire while a combination is being
  // recorded (e.g. pressing the skip combo would skip the timer instead of being captured).
  // Guarded because the handler may not exist yet until main wiring lands, and because main
  // also restores registrations on window reload/close, so unmount cleanup is all this needs
  // beyond every path that ends recording.
  function setHotkeysSuspended(suspended: boolean): void {
    try {
      void window.flowdo?.system?.suspendHotkeys(suspended)?.catch(() => {})
    } catch {
      // No-op: suspendHotkeys may not exist yet, or the bridge may be unavailable.
    }
  }

  useEffect(() => {
    if (!recording) return
    setHotkeysSuspended(true)
    return () => setHotkeysSuspended(false)
  }, [recording])

  useEffect(() => {
    if (!recording) return

    function onKeyDown(event: KeyboardEvent): void {
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        setRecording(false)
        setCaptured(null)
        setLive(null)
        return
      }

      const accelerator = acceleratorFromEvent(event)
      if (!accelerator) return // still just holding modifiers

      setCaptured(accelerator)

      if (accelerator === conflictsWith && accelerator !== '') {
        setLive({ kind: 'own-conflict' })
        return
      }

      const token = ++probeToken.current
      setLive(null)
      void window.flowdo.system.probeHotkey(accelerator).then((probe) => {
        if (probeToken.current !== token) return // a later keystroke superseded this probe
        setLive({ kind: 'probe', probe })
      })
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording, conflictsWith])

  // Require a SETTLED result before allowing a save: while the probe is in flight `live` is
  // still null, and treating that as "not taken, not invalid" would let a combination another
  // app owns be saved in the gap before the response arrives.
  const canSave =
    captured !== null && live?.kind === 'probe' && (live.probe === 'free' || live.probe === 'unavailable')
  // 'unavailable' still lets the user save — no combination fixes it, so refusing to persist
  // the choice would just be a second way of saying the same unhelpful no.

  function save(): void {
    if (captured === null || !canSave) return
    onCommit(captured)
    setRecording(false)
    setCaptured(null)
    setLive(null)
  }

  function cancel(): void {
    setRecording(false)
    setCaptured(null)
    setLive(null)
  }

  function turnOff(): void {
    onCommit('')
    setRecording(false)
    setCaptured(null)
    setLive(null)
  }

  return (
    <Field label={label} hint={hint}>
      <div className="flex flex-wrap items-center gap-2">
        {!recording ? (
          <>
            <code className="rounded border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-2 py-1 text-[12px] text-[var(--color-text)]">
              {value || 'Off'}
            </code>
            <Button size="sm" variant="secondary" onClick={() => setRecording(true)}>
              Change
            </Button>
            {value ? (
              <Button size="sm" variant="ghost" icon={<XIcon />} onClick={turnOff}>
                Turn off
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <code className="rounded border border-[var(--color-focus)] bg-[var(--color-surface-sunken)] px-2 py-1 text-[12px] text-[var(--color-text)]">
              {captured ?? 'Press a combination…'}
            </code>
            <Button size="sm" variant="primary" disabled={!canSave} onClick={save}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={cancel}>
              Cancel (Esc)
            </Button>
          </>
        )}
      </div>

      {recording ? <HotkeyLiveMessage captured={captured} live={live} /> : null}
      {!recording && activeFailure ? <HotkeyFailureMessage reason={activeFailure.reason} /> : null}
    </Field>
  )
}

function HotkeyLiveMessage({
  captured,
  live
}: {
  captured: string | null
  live: LiveResult
}): React.JSX.Element | null {
  if (!live) {
    if (!captured) return null
    return <p className="text-[11px] text-[var(--color-text-muted)]">Checking…</p>
  }
  if (live.kind === 'own-conflict') {
    return (
      <p className="text-[11px] text-[var(--color-danger)]">
        Already used by the other hotkey below — pick a different combination.
      </p>
    )
  }
  return <HotkeyProbeMessage probe={live.probe} />
}

function HotkeyProbeMessage({ probe }: { probe: HotkeyProbe }): React.JSX.Element {
  if (probe === 'free') {
    return <p className="text-[11px] text-[var(--color-break)]">Available.</p>
  }
  if (probe === 'taken') {
    return <p className="text-[11px] text-[var(--color-danger)]">Already used by another application.</p>
  }
  if (probe === 'invalid') {
    return <p className="text-[11px] text-[var(--color-danger)]">Not a valid combination.</p>
  }
  return <HotkeyFailureMessage reason="unavailable" />
}

function HotkeyFailureMessage({
  reason
}: {
  reason: 'taken' | 'invalid' | 'unavailable'
}): React.JSX.Element {
  if (reason === 'unavailable') {
    return (
      <p className="text-[11px] text-[var(--color-text-muted)]">
        Global hotkeys aren&rsquo;t available on this system (no global-shortcut support on this
        platform/session). No combination will fix this — it isn&rsquo;t about which keys you
        choose.
      </p>
    )
  }
  if (reason === 'taken') {
    return (
      <p className="text-[11px] text-[var(--color-danger)]">
        Currently not registered — another running application owns this combination.
      </p>
    )
  }
  return (
    <p className="text-[11px] text-[var(--color-danger)]">
      Currently not registered — Electron rejected this combination.
    </p>
  )
}
