import { describe, expect, it, vi } from 'vitest'

// windows.ts imports Electron at module scope for BrowserWindow/screen/shell, which don't
// exist under vitest's node environment. Only `clampBoundsToArea` is under test here — it
// touches none of these — so stub just enough of both modules for the import to succeed.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 0, height: 0 } }) },
  shell: { openExternal: () => {} }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

const { clampBoundsToArea, bottomRightCorner, fitMiniSize, MINI_SIZE, MINI_MAX_SIZE } = await import(
  '../src/main/windows'
)

describe('clampBoundsToArea', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1080 }
  const min = { width: 760, height: 560 }

  it('leaves bounds unchanged when they already fit', () => {
    const bounds = { x: 100, y: 100, width: 1040, height: 720 }
    expect(clampBoundsToArea(bounds, area, min)).toEqual(bounds)
  })

  it('shrinks bounds larger than the work area (e.g. saved on a 2560x1400 monitor)', () => {
    const bounds = { x: 0, y: 0, width: 2560, height: 1400 }
    const result = clampBoundsToArea(bounds, area, min)
    expect(result.width).toBe(area.width)
    expect(result.height).toBe(area.height)
    expect(result.x).toBe(0)
    expect(result.y).toBe(0)
  })

  it('pulls a window whose title bar is off the top of the work area back down', () => {
    const bounds = { x: 100, y: -500, width: 1040, height: 720 }
    const result = clampBoundsToArea(bounds, area, min)
    expect(result.y).toBe(0)
    expect(result.x).toBe(100)
    expect(result.width).toBe(1040)
    expect(result.height).toBe(720)
  })

  it('pulls a window hanging off the right edge back on screen', () => {
    const bounds = { x: 1800, y: 100, width: 1040, height: 720 }
    const result = clampBoundsToArea(bounds, area, min)
    // Window must lie fully inside the area, so x is pulled left just enough.
    expect(result.x).toBe(area.width - 1040)
    expect(result.y).toBe(100)
  })

  it('keeps a window that legitimately sits on a secondary display at negative x', () => {
    const secondary = { x: -1920, y: 0, width: 1920, height: 1080 }
    const bounds = { x: -1800, y: 50, width: 1040, height: 720 }
    const result = clampBoundsToArea(bounds, secondary, min)
    expect(result.x).toBe(-1800)
    expect(result.y).toBe(50)
    expect(result.width).toBe(1040)
    expect(result.height).toBe(720)
  })

  it('never exceeds the work area even when the configured minimum size is larger', () => {
    const smallArea = { x: 0, y: 0, width: 640, height: 480 }
    const bounds = { x: 0, y: 0, width: 500, height: 400 }
    const bigMin = { width: 760, height: 560 }
    const result = clampBoundsToArea(bounds, smallArea, bigMin)
    expect(result.width).toBe(smallArea.width)
    expect(result.height).toBe(smallArea.height)
    expect(result.x).toBe(0)
    expect(result.y).toBe(0)
  })
})

describe('bottomRightCorner', () => {
  it('tucks the widget into the bottom-right of the work area, 16px in', () => {
    // A 1920x1080 display whose taskbar takes the bottom 40px.
    const area = { x: 0, y: 0, width: 1920, height: 1040 }
    expect(bottomRightCorner(area, MINI_SIZE)).toEqual({ x: 1920 - 220 - 16, y: 1040 - 88 - 16 })
  })

  it('works on a secondary display to the left of the primary', () => {
    const area = { x: -1280, y: 0, width: 1280, height: 984 }
    expect(bottomRightCorner(area, MINI_SIZE)).toEqual({ x: -1280 + 1280 - 220 - 16, y: 984 - 88 - 16 })
  })

  it('never places the widget above or left of a tiny work area', () => {
    const area = { x: 100, y: 50, width: 200, height: 60 }
    expect(bottomRightCorner(area, MINI_SIZE)).toEqual({ x: 100, y: 50 })
  })
})

describe('fitMiniSize', () => {
  it('opens at the default size when nothing was saved', () => {
    expect(fitMiniSize(null)).toEqual(MINI_SIZE)
  })

  it('passes a size inside the limits through unchanged', () => {
    expect(fitMiniSize({ width: 360, height: 150 })).toEqual({ width: 360, height: 150 })
  })

  it('never opens smaller than the layout was built for', () => {
    expect(fitMiniSize({ width: 100, height: 40 })).toEqual(MINI_SIZE)
    expect(fitMiniSize({ width: -50, height: -1 })).toEqual(MINI_SIZE)
  })

  it('never opens larger than the maximum, e.g. a size saved before the limit shrank', () => {
    expect(fitMiniSize({ width: 1200, height: 900 })).toEqual(MINI_MAX_SIZE)
  })

  it('clamps each dimension on its own', () => {
    expect(fitMiniSize({ width: 1200, height: 100 })).toEqual({ width: MINI_MAX_SIZE.width, height: 100 })
    expect(fitMiniSize({ width: 300, height: 10 })).toEqual({ width: 300, height: MINI_SIZE.height })
  })

  it('rounds to whole pixels (fractional sizes come from scaled displays)', () => {
    expect(fitMiniSize({ width: 300.6, height: 120.4 })).toEqual({ width: 301, height: 120 })
  })
})
