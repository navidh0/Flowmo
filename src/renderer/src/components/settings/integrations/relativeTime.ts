/**
 * "2 minutes ago" formatting for `lastOkAt` / `lastError` timestamps.
 *
 * Display only — never fed back into any decision. `useRelativeTick` forces a re-render every
 * 30s so the text stays roughly current without hammering the `aria-live` region the caller
 * wraps it in; the brief is explicit that the status line updates periodically, not per second.
 */

import { useEffect, useState } from 'react'

export function formatRelativeTime(atMs: number, nowMs: number = Date.now()): string {
  const diffMs = nowMs - atMs
  if (diffMs < 0) return 'just now'
  const seconds = Math.round(diffMs / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/** Re-renders the caller every `intervalMs` so relative-time text stays fresh. */
export function useRelativeTick(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
