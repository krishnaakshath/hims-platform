// WS1 T7: the one-line dose text on a printed prescription. Pure.
import { parseDosePattern } from './dose-pattern'

const SLOT_NAMES_3 = ['morning', 'afternoon', 'night']
const SLOT_NAMES_4 = ['morning', 'afternoon', 'evening', 'night']
const FOOD_TEXT: Record<string, string> = {
  before_food: 'before food',
  after_food: 'after food',
  with_food: 'with food',
}

export interface DoseLineInput {
  dosePattern: string | null
  isSos: boolean
  frequencyPerDay: number | null
  durationDays: number | null
  foodTiming: string | null
}

/** "1-0-1 (morning, night) × 5 days, after food"; legacy rows: "2 times daily × 10 days". */
export function formatDoseLine(r: DoseLineInput): string {
  const parts: string[] = []
  const pattern = r.dosePattern ? parseDosePattern(r.dosePattern) : null
  let head: string | null = null
  if (r.isSos) head = 'SOS (when needed)'
  else if (pattern) {
    const names = pattern.slots.length === 4 ? SLOT_NAMES_4 : SLOT_NAMES_3
    const when = pattern.slots.flatMap((s, i) => (s > 0 ? [names[i]] : [])).join(', ')
    head = `${pattern.label} (${when})`
  } else if (r.frequencyPerDay != null) head = `${r.frequencyPerDay} times daily`
  const days = r.durationDays != null ? `× ${r.durationDays} day${r.durationDays === 1 ? '' : 's'}` : null
  const main = [head, days].filter(Boolean).join(' ')
  if (main) parts.push(main)
  const food = r.foodTiming ? FOOD_TEXT[r.foodTiming] : undefined
  if (food) parts.push(food)
  return parts.join(', ')
}
