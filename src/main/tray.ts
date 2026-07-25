/**
 * The tray icon: the app's real UI while the main window is hidden.
 *
 * Two things matter here. First, `updateTray` runs on every timer tick, so it does the
 * cheap work (tooltip) unconditionally and the expensive work (rebuilding the menu,
 * re-encoding the icon) only when the visible result would actually differ — a context
 * menu rebuilt 4×/second flickers while it's open. Second, the icon is generated in
 * process rather than loaded from disk, so the module has no asset dependency at all.
 */

import { deflateSync } from 'node:zlib'
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import type { SessionKind, Settings, TimerState } from '@shared/types'
import { getMiniWindow, showMainWindow } from './windows'

export interface TrayDeps {
  getState(): TimerState
  getSettings(): Settings
  onStartPause(): void
  onSkip(): void
  onStop(): void
  toggleMini(): void
  quit(): void
}

let tray: Tray | null = null
let deps: TrayDeps | null = null
let menu: Menu | null = null

/** Fingerprint of the last menu we built; a rebuild happens only when this changes. */
let menuKey = ''
let tooltip = ''
let iconColor = ''

export function initTray(injected: TrayDeps): void {
  deps = injected
  if (tray) {
    updateTray(injected.getState())
    return
  }

  const t = new Tray(iconFor('idle', 'idle'))
  t.setToolTip('Flowdo')

  // Windows opens the context menu on left click when one is attached via
  // setContextMenu, which would make the primary click useless. Popping it manually on
  // right click keeps left click for "show the window".
  if (process.platform === 'win32') {
    t.on('right-click', () => {
      if (menu) t.popUpContextMenu(menu)
    })
  }

  t.on('click', () => showMainWindow())
  t.on('double-click', () => showMainWindow())

  tray = t
  updateTray(injected.getState())
}

/**
 * Called ~1×/second by the integration layer.
 *
 * `state` is passed in rather than pulled from `deps.getState()` so the tray always shows
 * the same tick the renderer was sent.
 */
export function updateTray(state: TimerState): void {
  const t = tray
  if (!t) return

  const nextTooltip = tooltipFor(state)
  if (nextTooltip !== tooltip) {
    tooltip = nextTooltip
    t.setToolTip(nextTooltip)
  }

  const nextIconColor = colorFor(state.kind, state.status)
  if (nextIconColor !== iconColor) {
    iconColor = nextIconColor
    t.setImage(iconFor(state.kind ?? 'idle', state.status))
  }

  const nextMenuKey = `${state.status}|${state.kind ?? 'none'}|${state.mode}|${getMiniWindow() ? 'mini' : ''}`
  if (nextMenuKey !== menuKey) {
    menuKey = nextMenuKey
    menu = buildMenu(state)
    if (process.platform !== 'win32') t.setContextMenu(menu)
  }
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
  menu = null
  deps = null
  menuKey = ''
  tooltip = ''
  iconColor = ''
}

/** Exposed for the integration layer and for tests that can't inspect a real Tray. */
export function trayTooltip(): string {
  return tooltip
}

// ─────────────────────────────────────────────────────────────────────────────
// Menu
// ─────────────────────────────────────────────────────────────────────────────

function buildMenu(state: TimerState): Menu {
  const d = deps
  const idle = state.status === 'idle'

  const items: MenuItemConstructorOptions[] = [
    { label: 'Show Flowdo', click: () => showMainWindow() },
    { type: 'separator' },
    { label: startPauseLabel(state), click: () => d?.onStartPause() },
    { label: 'Skip', enabled: !idle, click: () => d?.onSkip() },
    { label: 'Stop', enabled: !idle, click: () => d?.onStop() },
    { type: 'separator' },
    {
      label: 'Show mini timer',
      type: 'checkbox',
      checked: getMiniWindow() !== null,
      click: () => d?.toggleMini()
    },
    { type: 'separator' },
    { label: 'Quit Flowdo', click: () => d?.quit() }
  ]

  return Menu.buildFromTemplate(items)
}

function startPauseLabel(state: TimerState): string {
  if (state.status === 'running') return 'Pause'
  if (state.status === 'paused') return 'Resume'
  return 'Start focus'
}

// ─────────────────────────────────────────────────────────────────────────────
// Tooltip
// ─────────────────────────────────────────────────────────────────────────────

function kindLabel(kind: SessionKind | null): string {
  switch (kind) {
    case 'focus':
      return 'Focus'
    case 'long_break':
      return 'Long break'
    case 'short_break':
      return 'Break'
    default:
      return 'Idle'
  }
}

/**
 * `Flowdo — Focus 12:34`, or `Flowdo — Focus 12:34 (paused)`.
 *
 * A bounded phase counts down (that's the number the user cares about); an open-ended
 * Flowmodoro focus counts up and appends the break it has earned so far, which is the
 * whole reason to run Flowmodoro.
 */
function tooltipFor(state: TimerState): string {
  if (state.status === 'idle' || state.kind === null) return 'Flowdo — Idle'

  const clock = formatClock(state.remainingMs ?? state.elapsedMs)
  let text = `Flowdo — ${kindLabel(state.kind)} ${clock}`

  if (state.remainingMs === null && state.earnedBreakMs !== null && state.earnedBreakMs > 0) {
    text += ` · ${formatClock(state.earnedBreakMs)} earned`
  }
  if (state.status === 'paused') text += ' (paused)'

  return text
}

/** `MM:SS`, widening to `H:MM:SS` past an hour. Renderer-side format.ts is unavailable here. */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Icon
// ─────────────────────────────────────────────────────────────────────────────

/** Indigo focus, emerald break, grey idle — the tray communicates state without a tooltip. */
function colorFor(kind: SessionKind | null, status: TimerState['status']): string {
  if (status === 'idle' || kind === null) return '#6b7280'
  if (status === 'paused') return '#a1a1aa'
  return kind === 'focus' ? '#6366f1' : '#10b981'
}

const iconCache = new Map<string, NativeImage>()

function iconFor(kind: SessionKind | 'idle', status: TimerState['status']): NativeImage {
  const color = colorFor(kind === 'idle' ? null : kind, status)
  const cached = iconCache.get(color)
  if (cached) return cached

  // 32px source: Windows downscales to the notification-area size, and starting from 32
  // stays crisp on the 150% displays most Windows 11 laptops ship with.
  const image = nativeImage.createFromDataURL(discPngDataUrl(32, color))
  iconCache.set(color, image)
  return image
}

/**
 * A filled antialiased disc as a PNG data URI.
 *
 * Written out byte by byte because the alternative — shipping a .png/.ico — means a
 * binary asset in the repo, and `createFromEmpty()` produces an invisible tray icon.
 * 4×4 supersampling is enough to hide the stair-stepping at tray sizes.
 */
function discPngDataUrl(size: number, hex: string): string {
  const { r, g, b } = parseHex(hex)
  const center = (size - 1) / 2
  const radius = size / 2 - 1
  const samples = 4
  const step = 1 / samples

  // Scanlines, each prefixed with PNG filter type 0 (none).
  const raw = Buffer.alloc(size * (size * 4 + 1))
  let offset = 0

  for (let y = 0; y < size; y++) {
    raw[offset++] = 0
    for (let x = 0; x < size; x++) {
      let inside = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const dx = x + (sx + 0.5) * step - 0.5 - center
          const dy = y + (sy + 0.5) * step - 0.5 - center
          if (dx * dx + dy * dy <= radius * radius) inside++
        }
      }
      raw[offset++] = r
      raw[offset++] = g
      raw[offset++] = b
      raw[offset++] = Math.round((inside / (samples * samples)) * 255)
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // non-interlaced

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])

  return `data:image/png;base64,${png.toString('base64')}`
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)

  return Buffer.concat([length, body, crc])
}

/** Table-free CRC-32; a 32×32 icon is a few thousand bytes, so the loop cost is noise. */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const value = Number.parseInt(hex.replace('#', ''), 16)
  if (!Number.isFinite(value)) return { r: 99, g: 102, b: 241 }
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff }
}
