/**
 * HTTP for iCal feeds. A feed URL is an attacker-adjacent input by design — it comes from
 * pasting a "secret" address into a settings field — so this module bounds every failure
 * mode a hostile or merely broken server could trigger: an unbounded body, a hung
 * connection, or a protocol that leaks the URL somewhere it shouldn't go.
 */

export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024
export const FETCH_TIMEOUT_MS = 20_000

/**
 * `webcal://` is rewritten to `https://` (they are the same protocol by convention). Only
 * `https:` is otherwise accepted, plus `http:` for `localhost`/`127.0.0.1` so tests (and a
 * user's own local server) work — `file:` and anything else is refused outright, since the
 * URL itself is the credential and must never be handed to a scheme that could exfiltrate it
 * some other way.
 */
export function normalizeFeedUrl(raw: string): string {
  // `webcal:` is a "non-special" scheme to the WHATWG URL parser, so `url.protocol = 'https:'`
  // is a silent no-op once parsed (switching between special and non-special schemes that way
  // is forbidden by spec) — the rewrite has to happen on the string before parsing.
  const rewritten = raw.trim().replace(/^webcal:\/\//i, 'https://')

  let url: URL
  try {
    url = new URL(rewritten)
  } catch {
    throw new Error('That does not look like a valid URL.')
  }

  const isLocalHttp =
    url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')

  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('Calendar feed URLs must be https:// (or webcal://) addresses.')
  }

  return url.toString()
}

export interface ConditionalHeaders {
  etag: string | null
  lastModified: string | null
}

export interface FetchOk {
  status: 'ok'
  body: string
  etag: string | null
  lastModified: string | null
}

export type FetchOutcome = FetchOk | { status: 'not-modified' }

/**
 * Fetch with conditional GET (`If-None-Match` / `If-Modified-Since`), a hard timeout, and a
 * hard cap on response size enforced while streaming (not from a possibly-absent or lied-about
 * `Content-Length`). Throws a plain, user-showable `Error` on any failure.
 */
export async function fetchIcs(
  fetchImpl: typeof fetch,
  url: string,
  conditional: ConditionalHeaders,
  opts: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<FetchOutcome> {
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES

  const headers: Record<string, string> = {}
  if (conditional.etag) headers['If-None-Match'] = conditional.etag
  if (conditional.lastModified) headers['If-Modified-Since'] = conditional.lastModified

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetchImpl(url, { headers, signal: controller.signal })
  } catch {
    if (controller.signal.aborted) {
      throw new Error('The calendar server took too long to respond.')
    }
    throw new Error('Could not reach the calendar server.')
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 304) {
    return { status: 'not-modified' }
  }
  if (!response.ok) {
    throw new Error(`The calendar server returned an error (HTTP ${response.status}).`)
  }

  const body = await readCapped(response, maxBytes)

  return {
    status: 'ok',
    body,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified')
  }
}

/** Reads a response body up to `maxBytes`, aborting the read rather than buffering further —
 *  a `Content-Length` header cannot be trusted, so this is enforced against actual bytes. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error('The calendar feed response was too large.')
    }
    return text
  }

  const decoder = new TextDecoder()
  let result = ''
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error('The calendar feed response was too large.')
    }
    result += decoder.decode(value, { stream: true })
  }
  result += decoder.decode()
  return result
}
