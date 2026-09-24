/**
 * Resolves an event's raw TZID (as node-ical hands it back on `DateWithTimeZone.tz`) into the
 * IANA zone name shown to the user, or `null` when there is none worth showing — a UTC/'Z'
 * instant, a floating time, or a TZID that cannot be resolved to anything real.
 *
 * node-ical already resolves the common cases (VTIMEZONE blocks, bare IANA TZIDs, and even
 * some Windows display names) internally before setting `.tz` — see `resolveTZID` /
 * `mapWindowsZone` in its bundled source. This is the fallback for whatever slips through: a
 * Windows label it did not recognise, or a value that is not a real zone at all.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** UTC by another name. The contract wants `timeZone: null` for these, not `'Etc/UTC'`. */
const UTC_ALIASES = new Set(['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT'])

let windowsZoneMap: Map<string, string> | null = null

/**
 * Lazily loads node-ical's own Windows-zone-name → IANA table from its package directory.
 *
 * It is not part of node-ical's public API — its `package.json` "exports" map only allows
 * importing "." and "./package.json" — so this resolves the one subpath that IS allowed
 * (`require.resolve('node-ical/package.json')`) and reads the sibling file straight off disk,
 * rather than depending on an unexported module path (or `import.meta.url`, which esbuild
 * cannot support once this bundles to CommonJS for the packaged app).
 */
function getWindowsZoneMap(): Map<string, string> {
  if (windowsZoneMap) return windowsZoneMap
  windowsZoneMap = new Map()
  try {
    const pkgJsonPath = require.resolve('node-ical/package.json')
    const jsonPath = join(dirname(pkgJsonPath), 'windowsZones.json')
    const raw = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, { iana?: string[] }>
    for (const [label, entry] of Object.entries(raw)) {
      const iana = entry.iana?.[0]
      if (iana) windowsZoneMap.set(label, iana)
    }
  } catch {
    // No table available (package layout changed upstream, or something odd about how this is
    // packaged) — fall through to Intl-only validation, which still covers every ordinary IANA
    // TZID node-ical hands back, just not an unrecognised Windows display name.
  }
  return windowsZoneMap
}

function isValidIana(tz: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * `rawTz` is whatever node-ical put on `DateWithTimeZone.tz` for one occurrence — read
 * per-occurrence (not per-event), so a RECURRENCE-ID override in a different zone than its
 * master is captured correctly.
 */
export function resolveTimeZone(rawTz: string | null | undefined): string | null {
  if (!rawTz) return null
  const trimmed = rawTz.trim()
  if (trimmed === '') return null
  if (UTC_ALIASES.has(trimmed)) return null

  if (isValidIana(trimmed)) return trimmed

  const mapped = getWindowsZoneMap().get(trimmed)
  if (mapped && !UTC_ALIASES.has(mapped) && isValidIana(mapped)) {
    return mapped
  }

  return null
}
