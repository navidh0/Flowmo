import type { Settings, TimerMode } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
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

/** Validated widening for the string unions, without an `as` cast. */
function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  for (const option of allowed) {
    if (option === value) return option
  }
  return fallback
}

const MODES: readonly TimerMode[] = ['pomodoro', 'flowmodoro']
const THEMES: readonly Settings['theme'][] = ['system', 'light', 'dark']

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

    sleepGraceMs: pickNumber(s.get('sleepGraceMs'), d.sleepGraceMs)
  }
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
