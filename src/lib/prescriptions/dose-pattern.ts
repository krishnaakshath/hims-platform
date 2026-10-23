// WS1 T6: the Indian dose pattern ("1-0-1" = one in the morning, none in the afternoon, one at
// night; four slots add the evening) and the prescribed quantity it implies. Pure.

export interface DosePattern {
  /** Units per slot, morning first: 3 slots (morning, afternoon, night) or 4 (+ evening before night). */
  slots: number[]
  /** Number of non-zero slots: the doses per day (what medication_episodes.frequency_per_day stores). */
  perDay: number
  /** The canonical text, half written as "½" (e.g. "½-0-½"); what medication_episodes.dose_pattern stores. */
  label: string
}

const SLOT_VALUES: Record<string, number> = { '0': 0, '1': 1, '2': 2, '½': 0.5, '0.5': 0.5 }
const slotText = (n: number) => (n === 0.5 ? '½' : String(n))

/** 3 or 4 dash-separated slots, each 0, 1, 2, ½ or 0.5, at least one non-zero; else null. */
export function parseDosePattern(raw: string): DosePattern | null {
  const parts = raw.split('-').map((p) => p.trim())
  if (parts.length !== 3 && parts.length !== 4) return null
  const slots: number[] = []
  for (const p of parts) {
    if (!Object.hasOwn(SLOT_VALUES, p)) return null
    slots.push(SLOT_VALUES[p])
  }
  const perDay = slots.filter((s) => s > 0).length
  if (perDay === 0) return null
  return { slots, perDay, label: slots.map(slotText).join('-') }
}

export type MedicationForm = 'tablet' | 'capsule' | 'liquid' | 'injection' | 'other'

/** Units to dispense for a course: countable forms (tablet, capsule) only, never for SOS. */
export function prescribedQuantity(i: {
  pattern: DosePattern | null
  frequencyPerDay: number | null
  durationDays: number
  form: MedicationForm
  isSos: boolean
}): number | null {
  if (i.isSos) return null
  if (i.form !== 'tablet' && i.form !== 'capsule') return null
  if (i.pattern) return Math.ceil(i.pattern.slots.reduce((a, b) => a + b, 0) * i.durationDays)
  if (i.frequencyPerDay != null) return i.frequencyPerDay * i.durationDays
  return null
}
