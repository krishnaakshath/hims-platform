// WS1 T6: request schemas for a multi-drug prescription (POST /api/encounters/[id]/prescriptions).
import { z } from 'zod'
import { parseDosePattern } from './dose-pattern'

export const ROUTES = ['oral', 'iv', 'im', 'sc', 'topical', 'inhaled', 'sublingual', 'rectal', 'vaginal', 'eye', 'ear', 'nasal', 'other'] as const
export const FOOD_TIMINGS = ['before_food', 'after_food', 'with_food', 'any'] as const

export const prescriptionItemSchema = z.object({
  medicationId: z.number().int().positive().nullable(),
  name: z.string().trim().min(1).max(200),
  genericName: z.string().trim().max(200).optional(),
  medicationClass: z.string().trim().min(1).max(100),
  dose: z.string().trim().min(1).max(100),
  dosePattern: z.string().trim().max(20).optional(),
  // Structural bounds on an integer field, not dosing-safety validation (as the legacy route).
  frequencyPerDay: z.number().int().min(1).max(6).optional(),
  isSos: z.boolean().default(false),
  durationDays: z.number().int().min(1).max(365),
  route: z.enum(ROUTES),
  foodTiming: z.enum(FOOD_TIMINGS).optional(),
  instructions: z.string().trim().max(500).optional(),
  allergyOverrideReason: z.string().trim().min(5).max(300).optional(),
}).strict().superRefine((item, ctx) => {
  // A pattern, when sent, must be valid; otherwise a frequency or SOS says how often.
  if (item.dosePattern !== undefined && item.dosePattern !== '') {
    if (!parseDosePattern(item.dosePattern)) ctx.addIssue({ code: 'custom', path: ['dosePattern'], message: 'Use a pattern like 1-0-1' })
    return
  }
  if (item.frequencyPerDay === undefined && !item.isSos) {
    ctx.addIssue({ code: 'custom', path: ['dosePattern'], message: 'Give a dose pattern, a frequency or SOS' })
  }
})

export type PrescriptionItem = z.infer<typeof prescriptionItemSchema>

export const createPrescriptionSetSchema = z.object({
  items: z.array(prescriptionItemSchema).min(1).max(15),
  advice: z.string().trim().max(1000).optional(),
}).strict()
