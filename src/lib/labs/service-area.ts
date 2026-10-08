// Pure, client-safe home-collection service area helpers.
import { isValidPinCode } from '@/lib/india/reference'

/** Split a pasted PIN list on whitespace, commas and semicolons; both lists de-duplicated and sorted. */
export function parsePinList(text: string): { pins: string[]; invalid: string[] } {
  const pins = new Set<string>()
  const invalid = new Set<string>()
  for (const token of text.split(/[\s,;]+/)) {
    if (!token) continue
    if (isValidPinCode(token)) pins.add(token)
    else invalid.add(token)
  }
  return { pins: [...pins].sort(), invalid: [...invalid].sort() }
}

/** A patient (or address) is local only when its PIN is in the active service-area set. */
export function isLocalPin(pin: string | null | undefined, active: ReadonlySet<string>): boolean {
  if (pin == null) return false
  const p = pin.trim()
  return p.length > 0 && active.has(p)
}
