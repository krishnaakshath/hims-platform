import { z } from 'zod'
import type { Role } from '@/lib/auth'

export const ENCOUNTER_TYPES = ['opd', 'ipd', 'lab'] as const
export type EncounterType = (typeof ENCOUNTER_TYPES)[number]
export const ENCOUNTER_VISIT_TYPES = ['new', 'follow_up', 'review', 'emergency'] as const
export type EncounterVisitType = (typeof ENCOUNTER_VISIT_TYPES)[number]
export const ENCOUNTER_STATUSES = ['checked_in', 'in_consultation', 'completed', 'cancelled'] as const
export type EncounterStatus = (typeof ENCOUNTER_STATUSES)[number]

export const ENCOUNTER_TRANSITIONS: Record<EncounterStatus, readonly EncounterStatus[]> = {
  checked_in: ['in_consultation', 'completed', 'cancelled'],
  in_consultation: ['completed'],
  completed: [],
  cancelled: [],
}

export function canTransitionEncounter(from: EncounterStatus, to: EncounterStatus): boolean {
  return ENCOUNTER_TRANSITIONS[from].includes(to)
}

export const ENCOUNTER_TRANSITION_ROLES: Record<'in_consultation' | 'completed' | 'cancelled', readonly Role[]> = {
  in_consultation: ['admin', 'pi'],
  completed: ['admin', 'pi'],
  cancelled: ['admin', 'frontdesk', 'crc'],
}

export function defaultEncounterVisitType(i: { urgency: 'routine' | 'urgent' | 'emergency'; followUpLinked: boolean }): EncounterVisitType {
  if (i.followUpLinked) return 'follow_up'
  return i.urgency === 'emergency' ? 'emergency' : 'new'
}

export const encounterStatusRequestSchema = z
  .object({
    to: z.enum(['in_consultation', 'completed', 'cancelled']),
    cancelReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((r) => r.to !== 'cancelled' || r.cancelReason !== undefined, { message: 'A cancel reason is required', path: ['cancelReason'] })
