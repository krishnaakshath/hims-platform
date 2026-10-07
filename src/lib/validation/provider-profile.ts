import { z } from 'zod'
import { isIndianStateCode } from '@/lib/india/reference'

/** Upper bound for a consultation fee: ₹1,00,000 in integer paise. */
export const MAX_CONSULTATION_FEE_PAISE = 100_000_00

export const REGISTRATION_NUMBER_PATTERN = /^[A-Za-z0-9/-]{1,20}$/

export const providerProfileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  departmentId: z.number().int().positive().nullable().optional(),
  registrationCouncil: z.enum(['nmc', 'smc']).nullable().optional(),
  registrationStateCode: z.string().nullable().optional(),
  registrationNumber: z.string().trim().regex(REGISTRATION_NUMBER_PATTERN, 'Invalid registration number').nullable().optional(),
  consultationFeePaise: z.number().int().min(0).max(MAX_CONSULTATION_FEE_PAISE).nullable().optional(),
}).strict().superRefine((v, ctx) => {
  if (Object.keys(v).length === 0) ctx.addIssue({ code: 'custom', message: 'At least one field is required' })
  const state = v.registrationStateCode
  if (state != null && !isIndianStateCode(state)) {
    ctx.addIssue({ code: 'custom', path: ['registrationStateCode'], message: 'Select a valid state or union territory' })
    return
  }
  if (v.registrationCouncil === 'smc' && state == null) {
    ctx.addIssue({ code: 'custom', path: ['registrationStateCode'], message: 'A state is required for a State Medical Council' })
  }
  if (v.registrationCouncil !== 'smc' && state != null) {
    ctx.addIssue({ code: 'custom', path: ['registrationStateCode'], message: 'A state applies only to a State Medical Council' })
  }
})

export type ProviderProfileInput = z.infer<typeof providerProfileSchema>
