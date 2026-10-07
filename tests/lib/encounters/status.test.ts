import { describe, it, expect } from 'vitest'
import { canTransitionEncounter, encounterStatusRequestSchema, defaultEncounterVisitType, ENCOUNTER_TRANSITION_ROLES } from '@/lib/encounters/status'

describe('encounter status', () => {
  it('allows only the documented transitions', () => {
    expect(canTransitionEncounter('checked_in', 'in_consultation')).toBe(true); expect(canTransitionEncounter('in_consultation', 'cancelled')).toBe(false)
    expect(canTransitionEncounter('completed', 'checked_in')).toBe(false)
    expect(canTransitionEncounter('checked_in', 'completed')).toBe(true); expect(canTransitionEncounter('cancelled', 'completed')).toBe(false)
  })
  it('cancel needs a reason', () => {
    expect(encounterStatusRequestSchema.safeParse({ to: 'cancelled' }).success).toBe(false)
    expect(encounterStatusRequestSchema.safeParse({ to: 'cancelled', cancelReason: 'left' }).success).toBe(true)
    expect(encounterStatusRequestSchema.safeParse({ to: 'completed' }).success).toBe(true)
    expect(encounterStatusRequestSchema.safeParse({ to: 'checked_in' }).success).toBe(false)
    expect(encounterStatusRequestSchema.safeParse({ to: 'completed', extra: 1 }).success).toBe(false)
  })
  it('defaults the visit type', () => {
    expect(defaultEncounterVisitType({ urgency: 'emergency', followUpLinked: true })).toBe('follow_up')
    expect(defaultEncounterVisitType({ urgency: 'emergency', followUpLinked: false })).toBe('emergency')
    expect(defaultEncounterVisitType({ urgency: 'routine', followUpLinked: false })).toBe('new')
  })
  it('per-transition roles', () => {
    expect(ENCOUNTER_TRANSITION_ROLES.cancelled).toEqual(['admin', 'frontdesk', 'crc'])
    expect(ENCOUNTER_TRANSITION_ROLES.completed).toEqual(['admin', 'pi'])
  })
})
