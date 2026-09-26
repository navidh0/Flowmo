/**
 * Checks that `eventFill`'s tint (`blocks.ts`) never makes a calendar event's `--color-text`
 * label illegible, for every colour someone could actually pick for a project or calendar
 * feed — not just the theme's own `--color-swatch-event` fallback.
 *
 * Mixing rule mirrors `color-mix(in srgb, <color> P%, var(--color-surface))` exactly as the
 * browser evaluates it: plain linear interpolation of the raw (non-linearized) sRGB channel
 * values, `P%` of the palette colour blended with `(100 - P)%` of that theme's surface. WCAG
 * contrast then linearizes (gamma-decodes) the MIXED result to get relative luminance, per the
 * spec — that gamma step belongs to the contrast formula, not to the mix itself.
 *
 * Colours are parsed from source TEXT with readFileSync + regex — the same approach
 * `tests/theme-surface.test.ts` uses for windows.ts/index.css — rather than importing the
 * component files, which pull in React/renderer-only concerns this test has no need for.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EVENT_TINT_PERCENT } from '../src/renderer/src/components/timeline/blocks'

const ROOT = resolve(__dirname, '..')
const INDEX_CSS = resolve(ROOT, 'src/renderer/src/assets/index.css')
const PROJECT_SIDEBAR = resolve(ROOT, 'src/renderer/src/components/tasks/ProjectSidebar.tsx')
const CALENDARS_SECTION = resolve(
  ROOT,
  'src/renderer/src/components/settings/integrations/CalendarsSection.tsx'
)

const HEX_RE = /#[0-9a-fA-F]{6}\b/g

/** Grabs the `{ ... }` body immediately following the first match of `header` in `text`. */
function braceBody(text: string, header: RegExp): string {
  const m = header.exec(text)
  if (!m) throw new Error(`could not find ${header} in source`)
  const start = m.index + m[0].length
  let depth = 1
  let i = start
  while (depth > 0) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') depth--
    i++
    if (i > text.length) throw new Error('unbalanced braces')
  }
  return text.slice(start, i - 1)
}

/** `--color-foo: #abcdef;` (or any value up to the semicolon) -> { foo: '#abcdef' } entries,
 *  keyed by the FULL token name (`--color-foo`). Same approach as theme-surface.test.ts. */
function extractColorTokens(cssBody: string): Map<string, string> {
  const tokens = new Map<string, string>()
  const re = /(--color-[a-z0-9-]+)\s*:\s*([^;]+);/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(cssBody))) {
    const [, name, value] = m
    if (name && value !== undefined) tokens.set(name, value.trim())
  }
  return tokens
}

function readDarkTokens(): Map<string, string> {
  const css = readFileSync(INDEX_CSS, 'utf8')
  return extractColorTokens(braceBody(css, /@theme\s*{/))
}

function readLightTokens(): Map<string, string> {
  const css = readFileSync(INDEX_CSS, 'utf8')
  return extractColorTokens(braceBody(css, /:root\[data-theme=["']light["']\]\s*{/))
}

/** Every distinct hex literal inside the `[ ... ]` array literal assigned to `name` — used for
 *  both `SWATCHES` (ProjectSidebar.tsx) and `PALETTE` (CalendarsSection.tsx). */
function extractArrayOfHex(source: string, name: string): string[] {
  const m = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(source)
  if (!m?.[1]) throw new Error(`could not find ${name} = [...] in source`)
  return [...new Set(m[1].match(HEX_RE) ?? [])]
}

function readSwatches(): string[] {
  return extractArrayOfHex(readFileSync(PROJECT_SIDEBAR, 'utf8'), 'SWATCHES')
}

function readPalette(): string[] {
  return extractArrayOfHex(readFileSync(CALENDARS_SECTION, 'utf8'), 'PALETTE')
}

// ─────────────────────────────────────────────────────────────────────────────
// Colour math
// ─────────────────────────────────────────────────────────────────────────────

interface Rgb {
  r: number
  g: number
  b: number
}

function parseHex(hex: string): Rgb {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex.trim())
  if (!m) throw new Error(`not a 6-digit hex colour: '${hex}'`)
  return { r: parseInt(m[1]!, 16), g: parseInt(m[2]!, 16), b: parseInt(m[3]!, 16) }
}

/** `color-mix(in srgb, a P%, b)`: plain linear interpolation of the raw (non-linearized) sRGB
 *  channel values — `in srgb` does NOT gamma-decode before mixing (that's `in srgb-linear`). */
function mixSrgb(a: Rgb, b: Rgb, aPercent: number): Rgb {
  const t = aPercent / 100
  return {
    r: a.r * t + b.r * (1 - t),
    g: a.g * t + b.g * (1 - t),
    b: a.b * t + b.b * (1 - t)
  }
}

function srgbChannelToLinear(c: number): number {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance. */
function relativeLuminance({ r, g, b }: Rgb): number {
  return (
    0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b)
  )
}

/** WCAG contrast ratio between two colours, >= 1. */
function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

interface Theme {
  name: string
  text: string
  surface: string
}

function themes(): Theme[] {
  const dark = readDarkTokens()
  const light = readLightTokens()
  const darkText = dark.get('--color-text')
  const darkSurface = dark.get('--color-surface')
  const lightText = light.get('--color-text')
  const lightSurface = light.get('--color-surface')
  if (!darkText || !darkSurface) throw new Error('could not read dark --color-text/--color-surface')
  if (!lightText || !lightSurface) throw new Error('could not read light --color-text/--color-surface')
  return [
    { name: 'dark', text: darkText, surface: darkSurface },
    { name: 'light', text: lightText, surface: lightSurface }
  ]
}

function palette(): string[] {
  const dark = readDarkTokens()
  const swatchEvent = dark.get('--color-swatch-event')
  if (!swatchEvent) throw new Error('could not read --color-swatch-event from index.css')
  return [...new Set([...readSwatches(), ...readPalette(), swatchEvent])]
}

describe('event tint keeps --color-text readable', () => {
  it('SWATCHES parses at least 6 colours (regex sanity check)', () => {
    expect(readSwatches().length).toBeGreaterThanOrEqual(6)
  })

  it('PALETTE parses at least 6 colours (regex sanity check)', () => {
    expect(readPalette().length).toBeGreaterThanOrEqual(6)
  })

  it(`mixes every palette colour at ${EVENT_TINT_PERCENT}% and keeps --color-text >= 4.5:1 on it, in both themes`, () => {
    const failures: string[] = []

    for (const theme of themes()) {
      const surfaceRgb = parseHex(theme.surface)
      const textRgb = parseHex(theme.text)

      for (const color of palette()) {
        const colorRgb = parseHex(color)
        const mixed = mixSrgb(colorRgb, surfaceRgb, EVENT_TINT_PERCENT)
        const ratio = contrastRatio(textRgb, mixed)
        if (ratio < 4.5) {
          failures.push(`${color} in ${theme.name} theme: ${ratio.toFixed(2)}:1`)
        }
      }
    }

    expect(failures).toEqual([])
  })
})
