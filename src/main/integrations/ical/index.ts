/**
 * Public surface for secret-iCal-URL calendar feeds. See `.claude/plans/v0.3-integrations.md`
 * for the research and invariants this implements.
 *
 * The feed URL is the credential (it usually embeds a capability token) and is stored ONLY
 * through `src/main/credentials.ts`, under `ical.<feedId>.url` — never in `calendar_feeds`,
 * never logged, never returned by any function here. Everything logged below refers to a
 * feed by its numeric id.
 */
import type {
  CalendarEvent,
  CalendarFeed,
  CalendarFeedCreate,
  CalendarFeedUpdate,
  DataChangedScope
} from '@shared/types'
import { deleteSecret, getSecret, isSecureStorageAvailable, setSecret } from '../../credentials'
import { fetchIcs, normalizeFeedUrl } from './fetch'
import { parseIcsOccurrences, type RawOccurrence } from './parse'
import { refreshWindow } from './dates'
import * as store from './store'

const REFRESH_INTERVAL_MS = 30 * 60_000
const DEFAULT_COLOR = '#22c55e'

export interface CalendarDeps {
  fetch?: typeof fetch
  now?: () => number
  onDataChanged(scope: DataChangedScope): void
}

export interface CalendarIntegration {
  list(): CalendarFeed[]
  add(input: CalendarFeedCreate): Promise<CalendarFeed>
  update(id: number, patch: CalendarFeedUpdate): CalendarFeed
  remove(id: number): void
  refreshNow(): Promise<CalendarFeed[]>
  secureStorageAvailable(): boolean
  start(): void
  stop(): void
  eventsRange(fromMs: number, toMs: number): CalendarEvent[]
}

function secretKey(feedId: number): string {
  return `ical.${feedId}.url`
}

type ParseOutcome =
  | { status: 'not-modified' }
  | { status: 'ok'; etag: string | null; lastModified: string | null; events: RawOccurrence[] }

export function createCalendarIntegration(deps: CalendarDeps): CalendarIntegration {
  const fetchImpl = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  let intervalHandle: ReturnType<typeof setInterval> | null = null

  async function fetchAndParse(
    url: string,
    conditional: { etag: string | null; lastModified: string | null }
  ): Promise<ParseOutcome> {
    const result = await fetchIcs(fetchImpl, url, conditional)
    if (result.status === 'not-modified') return result
    const { fromMs, toMs } = refreshWindow(now())
    const events = parseIcsOccurrences(result.body, fromMs, toMs)
    return { status: 'ok', etag: result.etag, lastModified: result.lastModified, events }
  }

  /**
   * Fetch + parse FIRST; only on success does a row get inserted, the secret stored, and
   * events cached. A bad URL or unparseable body rejects here and leaves nothing behind.
   */
  async function add(input: CalendarFeedCreate): Promise<CalendarFeed> {
    if (!isSecureStorageAvailable()) {
      throw new Error(
        'Calendars need OS secure storage to keep the feed address encrypted, and it is not available on this machine.'
      )
    }

    const url = normalizeFeedUrl(input.url)
    const parsed = await fetchAndParse(url, { etag: null, lastModified: null })
    // A brand-new feed sends no conditional headers, so this is never actually 304 — the
    // fallback just keeps the type checker (and any server that ignores that) honest.
    const events = parsed.status === 'ok' ? parsed.events : []
    const etag = parsed.status === 'ok' ? parsed.etag : null
    const lastModified = parsed.status === 'ok' ? parsed.lastModified : null

    const feed = store.insertFeedWithEvents(
      { name: input.name, color: input.color ?? DEFAULT_COLOR },
      now(),
      { etag, lastModified, lastOkAt: now() },
      events
    )

    try {
      setSecret(secretKey(feed.id), url)
    } catch (error) {
      // Secret storage refused after we already inserted the row — leave nothing behind.
      store.deleteFeed(feed.id)
      throw error
    }

    return feed
  }

  function update(id: number, patch: CalendarFeedUpdate): CalendarFeed {
    return store.updateFeedPatch(id, patch)
  }

  /** Deletes the row (events cascade) and the URL secret. */
  function remove(id: number): void {
    store.deleteFeed(id)
    deleteSecret(secretKey(id))
  }

  async function refreshOne(id: number): Promise<boolean> {
    const url = getSecret(secretKey(id))
    if (!url) {
      store.markFeedError(id, 'This calendar’s saved address is missing. Remove and re-add it.')
      return false
    }

    const conditional = store.getFeedConditional(id) ?? { etag: null, lastModified: null }
    try {
      const result = await fetchAndParse(url, conditional)
      if (result.status === 'not-modified') {
        store.markFeedNotModified(id, now())
        return false
      }
      return store.replaceFeedEvents(
        id,
        { etag: result.etag, lastModified: result.lastModified },
        now(),
        result.events
      )
    } catch (error) {
      store.markFeedError(id, error instanceof Error ? error.message : 'Refresh failed.')
      return false
    }
  }

  /** Refreshes every enabled feed concurrently and independently — one feed's failure must
   *  not block or fail another's refresh. */
  async function refreshNow(): Promise<CalendarFeed[]> {
    const ids = store.listEnabledFeedIds()
    const changedFlags = await Promise.all(ids.map((id) => refreshOne(id)))
    if (changedFlags.some(Boolean)) {
      deps.onDataChanged('calendar')
    }
    return store.listFeeds()
  }

  function start(): void {
    stop()
    intervalHandle = setInterval(() => {
      if (store.listFeeds().length > 0) {
        void refreshNow()
      }
    }, REFRESH_INTERVAL_MS)
  }

  function stop(): void {
    if (intervalHandle) {
      clearInterval(intervalHandle)
      intervalHandle = null
    }
  }

  return {
    list: () => store.listFeeds(),
    add,
    update,
    remove,
    refreshNow,
    secureStorageAvailable: () => isSecureStorageAvailable(),
    start,
    stop,
    eventsRange: (fromMs, toMs) => store.eventsRange(fromMs, toMs)
  }
}
