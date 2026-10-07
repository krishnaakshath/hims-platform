import { z } from 'zod'
import { visitReasonSchema } from '@/lib/visit-reason-schema'
import { INTERVAL_UNITS } from '@/lib/follow-ups/rules'

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}, 'Not a real calendar date')

export const offsetDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/)
  .refine((s) => !Number.isNaN(new Date(s).getTime()), 'Not a real date-time')

const UNIT_DAYS = { days: 1, weeks: 7, months: 30 } as const

export const followUpIntervalSchema = z
  .object({ value: z.number().int().min(1).max(365), unit: z.enum(INTERVAL_UNITS) })
  .strict()
  .refine((i) => i.value * UNIT_DAYS[i.unit] <= 731, 'The interval must be within 2 years.')

export const followUpTimingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('date'), dueDate: isoDateSchema }).strict(),
  z.object({ kind: z.literal('interval'), interval: followUpIntervalSchema }).strict(),
])

export const followUpReasonSchema = visitReasonSchema
export const planNotesSchema = z.string().trim().max(2000)

export const followUpPlanFieldsSchema = z
  .object({
    timing: followUpTimingSchema,
    windowDaysBefore: z.number().int().min(0).max(30).optional(),
    windowDaysAfter: z.number().int().min(0).max(60).optional(),
    reason: followUpReasonSchema,
    planNotes: planNotesSchema.optional(),
  })
  .strict()

const planShape = {
  timing: followUpTimingSchema,
  windowDaysBefore: z.number().int().min(0).max(30),
  windowDaysAfter: z.number().int().min(0).max(60),
  reason: followUpReasonSchema,
}

export const createFollowUpSchema = z
  .object({
    ...planShape,
    windowDaysBefore: planShape.windowDaysBefore.optional(),
    windowDaysAfter: planShape.windowDaysAfter.optional(),
    planNotes: planNotesSchema.optional(),
    patientId: z.string().min(1),
    prescribedByProviderId: z.number().int().positive().optional(),
    departmentId: z.number().int().positive().optional(),
    originatingEncounterId: z.number().int().positive().optional(),
  })
  .strict()
export type CreateFollowUpRequest = z.infer<typeof createFollowUpSchema>

export const updateFollowUpPlanSchema = z
  .object({
    timing: followUpTimingSchema.optional(),
    windowDaysBefore: planShape.windowDaysBefore.optional(),
    windowDaysAfter: planShape.windowDaysAfter.optional(),
    reason: followUpReasonSchema.optional(),
    planNotes: planNotesSchema.nullable().optional(),
    prescribedByProviderId: z.number().int().positive().optional(),
    departmentId: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'At least one field is required')
export type UpdateFollowUpPlanRequest = z.infer<typeof updateFollowUpPlanSchema>

export const reasonOnlySchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict()

export const bookFollowUpSchema = z
  .object({
    providerId: z.number().int().positive(),
    startsAt: offsetDateTimeSchema,
    endsAt: offsetDateTimeSchema,
  })
  .strict()
  .refine((b) => new Date(b.endsAt).getTime() > new Date(b.startsAt).getTime(), { message: 'endsAt must be after startsAt', path: ['endsAt'] })
  .refine((b) => new Date(b.endsAt).getTime() - new Date(b.startsAt).getTime() <= 240 * 60_000, { message: 'The appointment cannot be longer than 4 hours', path: ['endsAt'] })
export type BookFollowUpRequest = z.infer<typeof bookFollowUpSchema>

export const CONTACT_CHANNELS = ['phone', 'sms', 'whatsapp', 'email', 'in_person'] as const
export const CONTACT_OUTCOMES = ['reached_booked', 'reached_will_call_back', 'reached_declined', 'no_answer', 'wrong_number', 'message_left'] as const

export const contactAttemptSchema = z
  .object({
    channel: z.enum(CONTACT_CHANNELS),
    outcome: z.enum(CONTACT_OUTCOMES),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
export type ContactAttemptRequest = z.infer<typeof contactAttemptSchema>
