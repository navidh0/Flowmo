/**
 * Turns a browser `KeyboardEvent` into an Electron accelerator string ('Control+Alt+P').
 *
 * Only used while the user is actively recording a new combination — the stored setting is
 * always already a valid accelerator string, so nothing here needs to parse one back.
 */

const KEY_NAME_MAP: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  Enter: 'Return',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert'
}

/** True while the key itself is only a modifier — a combo isn't finished yet. */
export function isModifierKey(key: string): boolean {
  return key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta'
}

/**
 * Returns null when the event carries no key Electron can bind (a lone modifier, or a key
 * this mapper doesn't recognise) — the caller should keep listening rather than finalise.
 */
export function acceleratorFromEvent(event: KeyboardEvent): string | null {
  if (isModifierKey(event.key)) return null

  const parts: string[] = []
  if (event.ctrlKey) parts.push('Control')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Super')

  let key = KEY_NAME_MAP[event.key]
  if (!key) {
    if (/^F\d{1,2}$/.test(event.key)) {
      key = event.key
    } else if (event.key.length === 1) {
      // Letters, digits, and punctuation Electron accepts literally.
      key = event.key.toUpperCase()
    } else {
      return null
    }
  }

  parts.push(key)
  return parts.join('+')
}
