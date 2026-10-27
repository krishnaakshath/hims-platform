// WS3 T2: the admission form's request body (POST /api/inpatient/admissions), spec 3.1.
import { z } from 'zod'
import { normalizePhone } from '@/lib/india/phone'
import { visitReasonSchema } from '@/lib/visit-reason-schema'
import { OVERRIDE_REASON_MIN } from './admission-rules'
import { ADMISSION_COVERAGE_MODES } from '@/lib/insurance/coverage'

const positiveInt = z.number().int().positive()

const attendantPhoneSchema = z.string().max(40).transform((s, ctx) => {
  const phone = normalizePhone(s)
  if (!phone) {
    ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number' })
    return z.NEVER
  }
  return phone
})

export const admitPatientSchema = z.object({
  // A chart id or a UHID; the route resolves it to the chart id.
  patientId: z.string().min(1).max(40),
  attendingProviderId: positiveInt,
  roomId: positiveInt,
  admissionType: z.enum(['elective', 'emergency', 'transfer_in']),
  reason: visitReasonSchema,
  // A WHO ICD-10 code from the picker, or free text when no code is chosen (spec 3.1 item 3).
  provisionalDiagnosis: z.union([
    z.object({ codeId: positiveInt }).strict(),
    z.object({ text: z.string().trim().min(3).max(200) }).strict(),
  ]),
  expectedStayDays: z.number().int().min(1).max(365),
  attendant: z.object({
    name: z.string().trim().min(1).max(100),
    relationship: z.string().trim().min(1).max(40),
    phone: attendantPhoneSchema,
  }).strict().nullable(),
  policyId: positiveInt.nullable(),
  preauthId: positiveInt.nullable(),
  // WS12 T9: how the stay is paid. Omitted: cashless with a policy, self-pay without.
  coverageMode: z.enum(ADMISSION_COVERAGE_MODES).optional(),
  depositRequiredPaise: z.number().int().min(0).max(1_000_000_000),
  wardGenderOverrideReason: z.string().trim().min(OVERRIDE_REASON_MIN).max(300).nullable(),
  openOpdVisit: z.enum(['complete', 'keep']).nullable(),
}).strict().superRefine((b, ctx) => {
  if (b.coverageMode === 'self_pay' && (b.policyId !== null || b.preauthId !== null)) ctx.addIssue({ code: 'custom', path: ['coverageMode'], message: 'Self-pay takes no policy or pre-authorisation' })
  if ((b.coverageMode === 'cashless' || b.coverageMode === 'reimbursement') && b.policyId === null) ctx.addIssue({ code: 'custom', path: ['policyId'], message: 'Choose the policy' })
})

export type AdmitPatientRequest = z.infer<typeof admitPatientSchema>
