/**
 * Cross-checks the two places a window's/theme's background colour is duplicated, purely by
 * reading the source text (no build step, no Electron) — so a change to either file that
 * silently drifts from the other fails here instead of only showing up as a flash of the
 * wrong colour on window open.
 *
 *   1. `SURFACE.light` in src/main/windows.ts (the pre-paint background for a light window)
 *      must equal `--color-surface`'s light-mode value in assets/index.css (what the
 *      renderer actually paints once it loads) — same contract windows.ts's own doc comment
 *      states for `SURFACE.dark` vs the dark `@theme` value.
 *   2. Every `--color-*` token declared in the dark `@theme` block has an override in the
 *      `:root[data-theme="light"]` block, so a token added later to one can't silently stay
 *      dark-only in the other.
 *   3. `--color-on-swatch` and every `--color-swatch-*` token are THEME-INDEPENDENT BY RULE
 *      (identical in both palettes) — they ink/fill a project, calendar-feed or "no
 *      project"/break/uncoloured-feed swatch (timeline/Block.tsx, blocks.ts), which stays the
 *      same mid-brightness colour in both themes on purpose, so the near-black ink that reads
 *      on it can too. Matched by name pattern, not a hand-maintained list, so a *new*
 *      `--color-swatch-*` token added later is covered automatically instead of silently
 *      being allowed to drift into a per-theme value nothing would catch.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..')
const WINDOWS_TS = resolve(ROOT, 'src/main/windows.ts')
const INDEX_CSS = resolve(ROOT, 'src/renderer/src/assets/index.css')

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
 *  keyed by the FULL token name (`--color-foo`) so callers don't have to re-add the prefix. */
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

function readSurfaceFromWindows(): { dark: string; light: string } {
  const src = readFileSync(WINDOWS_TS, 'utf8')
  const m = /const SURFACE\s*=\s*\{\s*dark:\s*'([^']+)'\s*,\s*light:\s*'([^']+)'/.exec(src)
  if (!m?.[1] || !m[2]) {
    throw new Error('could not find SURFACE = { dark: ..., light: ... } in windows.ts')
  }
  return { dark: m[1], light: m[2] }
}

function readThemeTokens(): Map<string, string> {
  const css = readFileSync(INDEX_CSS, 'utf8')
  const body = braceBody(css, /@theme\s*{/)
  return extractColorTokens(body)
}

/** `--color-on-swatch` and every `--color-swatch-*` token — the family that's required to be
 *  IDENTICAL between the dark and light palettes (see the file header's point 3). A name
 *  pattern rather than a hand-maintained list, so a new swatch token added later is covered
 *  automatically. */
function isSwatchToken(name: string): boolean {
  return name === '--color-on-swatch' || name.startsWith('--color-swatch-')
}

function readLightOverrideTokens(): Map<string, string> {
  const css = readFileSync(INDEX_CSS, 'utf8')
  // Selected by the `data-theme` attribute App.tsx sets on `<html>`, not by
  // `@media (prefers-color-scheme: light)` — see the comment above this block in index.css
  // for why (nativeTheme.themeSource doesn't reach that media query on a bare Linux/Xvfb
  // session). Tolerates either quote style around the attribute value.
  const rootBody = braceBody(css, /:root\[data-theme=["']light["']\]\s*{/)
  return extractColorTokens(rootBody)
}

describe('theme surface colour stays in sync', () => {
  it('SURFACE.dark (windows.ts) matches --color-surface in the dark @theme block', () => {
    const surface = readSurfaceFromWindows()
    const theme = readThemeTokens()
    expect(theme.get('--color-surface')?.toLowerCase()).toBe(surface.dark.toLowerCase())
  })

  it('SURFACE.light (windows.ts) matches --color-surface in the light override block', () => {
    const surface = readSurfaceFromWindows()
    const light = readLightOverrideTokens()
    expect(light.get('--color-surface')?.toLowerCase()).toBe(surface.light.toLowerCase())
  })

  it('the light surface is exactly #f6f7f9, as the task spec requires', () => {
    const surface = readSurfaceFromWindows()
    expect(surface.light.toLowerCase()).toBe('#f6f7f9')
    const light = readLightOverrideTokens()
    expect(light.get('--color-surface')?.toLowerCase()).toBe('#f6f7f9')
  })

  it('every --color-* token in the dark @theme block has a light override', () => {
    const theme = readThemeTokens()
    const light = readLightOverrideTokens()
    expect(theme.size).toBeGreaterThan(0)
    const missing = [...theme.keys()].filter((token) => !light.has(token))
    expect(missing).toEqual([])
  })

  it('the light override block does not merely repeat the dark values', () => {
    // A copy-pasted block that forgot to change anything would still pass the "has an
    // override" check above — this catches that failure mode specifically. --color-surface is
    // intentionally allowed to coincide too (it isn't here, but nothing requires it not to);
    // every swatch token is EXPECTED to coincide and is asserted on that separately below.
    const theme = readThemeTokens()
    const light = readLightOverrideTokens()
    const identical = [...theme.keys()].filter(
      (token) => token !== '--color-surface' && !isSwatchToken(token) && theme.get(token) === light.get(token)
    )
    // Every other token should actually differ between the palettes.
    expect(identical).toEqual([])
  })

  it('--color-on-swatch and every --color-swatch-* token are identical in both palettes', () => {
    const theme = readThemeTokens()
    const light = readLightOverrideTokens()
    const swatchTokens = [...theme.keys()].filter(isSwatchToken)
    // At least --color-on-swatch must exist, or this assertion would vacuously pass.
    expect(swatchTokens.length).toBeGreaterThan(0)
    const mismatched = swatchTokens.filter(
      (token) => theme.get(token)?.toLowerCase() !== light.get(token)?.toLowerCase()
    )
    expect(mismatched).toEqual([])
  })
})
