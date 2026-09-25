import type { LayoutSettings, PanelId, Settings, TimerMode } from '@shared/types'
import {
  DEFAULT_LAYOUT,
  DEFAULT_SETTINGS,
  PANEL_IDS,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  WEEKDAYS
} from '@shared/types'
import { getDb, str, tx } from '../index'

/**
 * Settings are one row per key, JSON-encoded, rather than one blob row.
 *
 * A blob means a concurrent write from two windows clobbers keys it never touched; a row
 * per key means `set({ theme })` writes exactly `theme`. It also makes a stored value
 * that has gone bad — hand-edited file, type changed between versions — cost one default
 * instead of the whole settings object.
 */

const KEYS = Object.keys(DEFAULT_SETTINGS)

function isSettingsKey(key: string): boolean {
  return KEYS.includes(key)
}

function readStored(): Map<string, unknown> {
  const stored = new Map<string, unknown>()
  for (const row of getDb().prepare('SELECT key, value FROM settings').all()) {
    const key = str(row, 'key')
    if (!isSettingsKey(key)) continue
    try {
      stored.set(key, JSON.parse(str(row, 'value')))
    } catch {
      // Unparseable JSON is treated as absent; the default below covers it.
    }
  }
  return stored
}

function pickNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** Validated widening for the string and number unions, without an `as` cast. */
function pickEnum<T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T {
  for (const option of allowed) {
    if (option === value) return option
  }
  return fallback
}

const MODES: readonly TimerMode[] = ['pomodoro', 'flowmodoro']
const THEMES: readonly Settings['theme'][] = ['system', 'light', 'dark']

function isPanelId(value: unknown): value is PanelId {
  for (const id of PANEL_IDS) {
    if (id === value) return true
  }
  return false
}

/**
 * The one structured setting, validated field by field like every scalar above.
 *
 * A layout is only useful if it is coherent: a partial or reordered-away panel leaves the
 * shell unable to render a column. So anything that is not a complete permutation of
 * PANEL_IDS falls back wholesale to DEFAULT_LAYOUT rather than being patched up —
 * a half-repaired layout is harder to reason about than a reset one, and the user has a
 * "Reset layout" button precisely because this is recoverable.
 *
 * Widths are clamped rather than rejected: a stored 5000px is a resize against a monitor
 * that no longer exists, and clamping keeps the panel usable where discarding would throw
 * away an otherwise fine layout.
 */
function pickLayout(value: unknown): LayoutSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_LAYOUT
  const raw = value as Partial<Record<keyof LayoutSettings, unknown>>

  const order = Array.isArray(raw.order) ? raw.order.filter(isPanelId) : []
  // Every panel exactly once, or the shell cannot lay itself out.
  if (order.length !== PANEL_IDS.length || new Set(order).size !== PANEL_IDS.length) {
    return DEFAULT_LAYOUT
  }

  const storedWidths =
    typeof raw.widths === 'object' && raw.widths !== null
      ? (raw.widths as Record<string, unknown>)
      : {}

  const widths = { ...DEFAULT_LAYOUT.widths }
  for (const id of PANEL_IDS) {
    const width = storedWidths[id]
    if (typeof width === 'number' && Number.isFinite(width)) {
      widths[id] = Math.min(PANEL_MAX_WIDTH[id], Math.max(PANEL_MIN_WIDTH[id], Math.round(width)))
    }
  }

  const collapsed = Array.isArray(raw.collapsed) ? raw.collapsed.filter(isPanelId) : []
  // The last panel flexes to fill; collapsing it would leave the shell with no filler.
  const flexing = order[order.length - 1]

  return {
    order,
    widths,
    collapsed: [...new Set(collapsed)].filter((id) => id !== flexing)
  }
}

/**
 * The full settings object, stored values layered over `DEFAULT_SETTINGS`.
 *
 * Every field is read explicitly and type-checked against its default, so a key that a
 * future version adds gets a sane value with no migration, and a key whose stored value
 * has the wrong shape degrades to the default instead of reaching the timer as a string
 * where it expected a number.
 */
export function get(): Settings {
  const s = readStored()
  const d = DEFAULT_SETTINGS

  return {
    mode: pickEnum(s.get('mode'), MODES, d.mode),

    pomodoroFocusMs: pickNumber(s.get('pomodoroFocusMs'), d.pomodoroFocusMs),
    pomodoroShortBreakMs: pickNumber(s.get('pomodoroShortBreakMs'), d.pomodoroShortBreakMs),
    pomodoroLongBreakMs: pickNumber(s.get('pomodoroLongBreakMs'), d.pomodoroLongBreakMs),
    longBreakEvery: pickNumber(s.get('longBreakEvery'), d.longBreakEvery),

    flowmodoroDivisor: pickNumber(s.get('flowmodoroDivisor'), d.flowmodoroDivisor),
    flowmodoroMinBreakMs: pickNumber(s.get('flowmodoroMinBreakMs'), d.flowmodoroMinBreakMs),
    flowmodoroMaxBreakMs: pickNumber(s.get('flowmodoroMaxBreakMs'), d.flowmodoroMaxBreakMs),

    autoStartBreaks: pickBoolean(s.get('autoStartBreaks'), d.autoStartBreaks),
    autoStartFocus: pickBoolean(s.get('autoStartFocus'), d.autoStartFocus),

    notificationsEnabled: pickBoolean(s.get('notificationsEnabled'), d.notificationsEnabled),
    soundEnabled: pickBoolean(s.get('soundEnabled'), d.soundEnabled),

    minimizeToTray: pickBoolean(s.get('minimizeToTray'), d.minimizeToTray),
    launchAtLogin: pickBoolean(s.get('launchAtLogin'), d.launchAtLogin),
    showMiniWidget: pickBoolean(s.get('showMiniWidget'), d.showMiniWidget),
    theme: pickEnum(s.get('theme'), THEMES, d.theme),

    hotkeyStartPause: pickString(s.get('hotkeyStartPause'), d.hotkeyStartPause),
    hotkeySkip: pickString(s.get('hotkeySkip'), d.hotkeySkip),

    sleepGraceMs: pickNumber(s.get('sleepGraceMs'), d.sleepGraceMs),

    // pickEnum compares with ===, so a stored "1", 1.5 or 7 falls back rather than
    // reaching the calendar as a weekday that doesn't exist.
    weekStartsOn: pickEnum(s.get('weekStartsOn'), WEEKDAYS, d.weekStartsOn),

    layout: pickLayout(s.get('layout'))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Window bounds — main-process only
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the main window was last placed.
 *
 * Deliberately NOT part of `Settings`, even though it shares this table. Settings are
 * broadcast to every renderer on each change and window geometry is of no interest to
 * any of them; routing bounds through `set()` would push an IPC message to two windows
 * every time the user finishes dragging one. The key is outside `DEFAULT_SETTINGS`, so
 * `get()` and `set()` ignore it entirely.
 */
const WINDOW_BOUNDS_KEY = 'internal:windowBounds'

export interface StoredBounds {
  x: number
  y: number
  width: number
  height: number
}

export function getWindowBounds(): StoredBounds | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(WINDOW_BOUNDS_KEY)
  if (!row) return null

  try {
    const parsed: unknown = JSON.parse(str(row, 'value'))
    if (typeof parsed !== 'object' || parsed === null) return null

    const b = parsed as Record<string, unknown>
    const nums = [b.x, b.y, b.width, b.height]
    if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null

    return {
      x: b.x as number,
      y: b.y as number,
      width: b.width as number,
      height: b.height as number
    }
  } catch {
    return null
  }
}

export function setWindowBounds(bounds: StoredBounds): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(WINDOW_BOUNDS_KEY, JSON.stringify(bounds))
}

/**
 * Upsert only the keys present in `patch` and return the resulting full object, so the
 * caller can broadcast one authoritative settings state without a second read.
 */
export function set(patch: Partial<Settings>): Settings {
  tx((db) => {
    const stmt = db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    for (const [key, value] of Object.entries(patch)) {
      // Unknown keys are dropped rather than stored: get() would ignore them anyway, and
      // junk rows outlive the version that wrote them.
      if (value === undefined || !isSettingsKey(key)) continue
      stmt.run(key, JSON.stringify(value))
    }
  })

  return get()
}
