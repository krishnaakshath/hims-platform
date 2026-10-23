// WS1 T4: request bodies for the consultation workspace's diagnosis and referral writes.
import { z } from 'zod'

export const addDiagnosisSchema = z.object({
  codeId: z.number().int().positive().optional(),
  text: z.string().trim().min(2).max(300).optional(),
  diagnosisType: z.enum(['primary', 'secondary', 'provisional']),
  onProblemList: z.boolean().optional(),
}).strict().refine((b) => b.codeId !== undefined || b.text !== undefined, { message: 'Choose a code or type a diagnosis' })
export type AddDiagnosis = z.infer<typeof addDiagnosisSchema>

export const patchDiagnosisSchema = z.object({
  diagnosisType: z.enum(['primary', 'secondary', 'provisional']).optional(),
  onProblemList: z.boolean().optional(),
}).strict()
export type PatchDiagnosis = z.infer<typeof patchDiagnosisSchema>

// + code_not_valid_for_patient (fix round 1): SP6's sex/age checks refused the code for this patient.
export type DiagnosisError = 'code_not_current' | 'coding_locked' | 'primary_exists' | 'not_found' | 'code_not_valid_for_patient'

export const referralSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('internal'),
    toDepartmentId: z.number().int().positive().optional(),
    toProviderId: z.number().int().positive().optional(),
    reason: z.string().trim().min(5).max(1000),
    urgency: z.enum(['routine', 'urgent', 'emergency']),
  }).strict(),
  z.object({
    kind: z.literal('external'),
    externalFacility: z.string().trim().min(2).max(200),
    externalDoctor: z.string().trim().max(120).optional(),
    reason: z.string().trim().min(5).max(1000),
    urgency: z.enum(['routine', 'urgent', 'emergency']),
  }).strict(),
])
export type ReferralInput = z.infer<typeof referralSchema>

/** An internal referral must name a department or a doctor (the table's check says the same). */
export function referralHasTarget(input: ReferralInput): boolean {
  return input.kind === 'external' || input.toDepartmentId !== undefined || input.toProviderId !== undefined
}
