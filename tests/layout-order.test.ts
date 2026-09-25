/**
 * `movePanel` — the pure step behind Settings → Layout's Move left/right buttons. The shell
 * trusts `LayoutSettings`' invariants (order is a permutation; the last panel flexes and so is
 * never collapsed), so every move has to preserve them, not leave them to a later validator.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, PANEL_IDS } from '@shared/types'
import type { LayoutSettings, PanelId } from '@shared/types'
import { movePanel } from '../src/renderer/src/components/shell/layoutMath'

function layout(order: PanelId[], collapsed: PanelId[] = []): LayoutSettings {
  return { ...DEFAULT_LAYOUT, order, collapsed }
}

const PERMUTATIONS: PanelId[][] = [
  ['projects', 'timer', 'main'],
  ['projects', 'main', 'timer'],
  ['timer', 'projects', 'main'],
  ['timer', 'main', 'projects'],
  ['main', 'projects', 'timer'],
  ['main', 'timer', 'projects']
]

describe('movePanel', () => {
  it('swaps a panel with its left or right neighbour', () => {
    expect(movePanel(layout(['projects', 'timer', 'main']), 'timer', 'left').order).toEqual([
      'timer',
      'projects',
      'main'
    ])
    expect(movePanel(layout(['projects', 'timer', 'main']), 'timer', 'right').order).toEqual([
      'projects',
      'main',
      'timer'
    ])
  })

  it('is a no-op past either end, returning the same object', () => {
    const l = layout(['projects', 'timer', 'main'])
    expect(movePanel(l, 'projects', 'left')).toBe(l)
    expect(movePanel(l, 'main', 'right')).toBe(l)
  })

  it.each(PERMUTATIONS)('keeps every order a permutation, from %s %s %s', (...order) => {
    for (const id of PANEL_IDS) {
      for (const dir of ['left', 'right'] as const) {
        const next = movePanel(layout(order), id, dir)
        expect([...next.order].sort()).toEqual([...PANEL_IDS].sort())
      }
    }
  })

  it('un-collapses a panel that the move makes the flexing (last) one', () => {
    const next = movePanel(layout(['projects', 'timer', 'main'], ['timer']), 'timer', 'right')
    expect(next.order.at(-1)).toBe('timer')
    expect(next.collapsed).not.toContain('timer')
  })

  it('keeps other collapsed panels collapsed', () => {
    const next = movePanel(layout(['projects', 'timer', 'main'], ['projects']), 'timer', 'right')
    expect(next.collapsed).toEqual(['projects'])
  })

  it('never leaves the last panel collapsed, from any start', () => {
    for (const order of PERMUTATIONS) {
      const collapsible = order.slice(0, -1)
      for (const id of PANEL_IDS) {
        for (const dir of ['left', 'right'] as const) {
          const next = movePanel(layout(order, collapsible), id, dir)
          expect(next.collapsed).not.toContain(next.order.at(-1))
        }
      }
    }
  })

  it('leaves widths alone', () => {
    const l = layout(['projects', 'timer', 'main'])
    expect(movePanel(l, 'timer', 'left').widths).toBe(l.widths)
  })
})
