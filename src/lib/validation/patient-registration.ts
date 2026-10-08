import { z } from 'zod'
import { normalizeAadhaar, isValidAadhaar, containsAadhaarLike } from '@/lib/india/aadhaar'
import { normalizeAbhaNumber, isValidAbhaNumber, normalizeAbhaAddress, isValidAbhaAddress } from '@/lib/india/abha'
import {
  isIndianStateCode, isValidPinCode, KYC_DOC_TYPES, AADHAAR_DECLINE_REASONS, ABHA_UNAVAILABLE_REASONS,
  CONTACT_RELATIONSHIPS, LANGUAGES, GENDERS, MARITAL_STATUSES, BLOOD_GROUPS,
} from '@/lib/india/reference'
import { normalizePhone } from '@/lib/india/phone'
import { todayIsoIn, ageOnDate } from '@/lib/india-time'

// Pure and client-safe. Allowed-value lists come from reference.ts; the DB
// stores the Aadhaar decline / ABHA reasons as plain text, so they are
// enforced here.
const codes = <T extends readonly { code: string }[]>(list: T) => list.map((x) => x.code) as [T[number]['code'], ...T[number]['code'][]]

// Free-text notes (Aadhaar decline, ABHA unavailable) must never hold an
// Aadhaar number. Fixed message: never echo the submitted text.
const note = z.string().trim().min(1).max(500).refine((v) => !containsAadhaarLike(v), 'Do not enter an Aadhaar number in the note')

export const aadhaarInputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('provided'),
    // Fixed messages; never echo the submitted value.
    number: z.string().transform(normalizeAadhaar).refine(isValidAadhaar, 'Enter a valid 12-digit Aadhaar number'),
    consent: z.literal(true, 'Patient consent is required to record Aadhaar'),
  }),
  z.object({
    status: z.literal('declined'),
    reason: z.enum(codes(AADHAAR_DECLINE_REASONS)),
    note: note.optional(),
  }).superRefine((v, ctx) => {
    if (v.reason === 'other' && !v.note) ctx.addIssue({ code: 'custom', path: ['note'], message: 'A note is required when the reason is other' })
  }),
])

export const abhaInputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('provided'),
    abhaNumber: z.string().transform(normalizeAbhaNumber).refine(isValidAbhaNumber, 'Enter a valid 14-digit ABHA number').optional(),
    abhaAddress: z.string().transform(normalizeAbhaAddress).refine(isValidAbhaAddress, 'Enter a valid ABHA address').optional(),
    // SP8: the ABDM verification flow that produced this ABHA (registration stamps it verified).
    flowId: z.uuid().optional(),
  }).superRefine((v, ctx) => {
    if (!v.abhaNumber && !v.abhaAddress) ctx.addIssue({ code: 'custom', path: ['abhaNumber'], message: 'Provide an ABHA number or ABHA address' })
  }),
  z.object({
    status: z.literal('unavailable'),
    reason: z.enum(codes(ABHA_UNAVAILABLE_REASONS)),
    note: note.optional(),
  }).superRefine((v, ctx) => {
    if (v.reason === 'other' && !v.note) ctx.addIssue({ code: 'custom', path: ['note'], message: 'A note is required when the reason is other' })
  }),
])

const phoneWith = (opts: { allowLandline?: boolean }) => z.string().transform((s, ctx) => {
  const n = normalizePhone(s, opts)
  if (n === null) { ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number' }); return z.NEVER }
  return n
})
const phoneField = phoneWith({})
// Contacts may be reached on an STD landline; the patient's own mobile may not.
const contactPhoneField = phoneWith({ allowLandline: true })

// Aadhaar must enter only through the consent flow, never free text (names,
// addresses, notes, KYC document numbers). Fixed message; never echoes input.
export const NO_AADHAAR_MESSAGE = 'Do not enter an Aadhaar number in this field'
export const noAadhaar = (s: string) => !containsAadhaarLike(s)
const safeText = (schema: z.ZodString) => schema.refine(noAadhaar, NO_AADHAAR_MESSAGE)

export const contactInputSchema = z.object({
  kind: z.enum(['next_of_kin', 'guardian', 'emergency']),
  name: safeText(z.string().trim().min(1).max(120)),
  relationship: z.enum(CONTACT_RELATIONSHIPS),
  phone: contactPhoneField,
  addressText: safeText(z.string().max(300)).optional(),
  isPrimary: z.boolean().optional(),
})

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as YYYY-MM-DD')
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number)
    const dt = new Date(Date.UTC(y, m - 1, d))
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  }, 'Enter a valid date')
  .refine((s) => s <= todayIsoIn(), 'Date of birth cannot be in the future')

export const demographicsShape = {
  name: safeText(z.string().trim().min(1).max(200)),
  dob: isoDate,
  gender: z.enum(codes(GENDERS)),
  maritalStatus: z.enum(codes(MARITAL_STATUSES)).optional(),
  bloodGroup: z.enum(codes(BLOOD_GROUPS)).optional(),
  occupation: safeText(z.string().max(100)).optional(),
  nationality: z.string().regex(/^[A-Z]{2}$/, 'Use an ISO alpha-2 country code').default('IN'),
  religion: safeText(z.string().max(60)).optional(),
  preferredLanguage: z.enum(codes(LANGUAGES)).optional(),
  email: z.email().optional(),
  phone: phoneField.optional(),
  addressLine1: safeText(z.string().trim().min(1).max(200)),
  addressLine2: safeText(z.string().max(200)).optional(),
  city: safeText(z.string().trim().min(1).max(100)),
  district: safeText(z.string().trim().min(1).max(100)),
  stateCode: z.string().refine(isIndianStateCode, 'Select a valid state or union territory'),
  pinCode: z.string().refine(isValidPinCode, 'Enter a valid 6-digit PIN code'),
  isMlc: z.boolean().default(false),
  mlcNumber: safeText(z.string().max(50)).optional(),
}

const GUARDIAN_MSG = 'A guardian contact is required for a patient under 18'
export function guardianProblem(contacts: { kind: string }[], dobIso: string, todayIso: string): string | null {
  if (ageOnDate(dobIso, todayIso) < 18 && !contacts.some((c) => c.kind === 'guardian')) return GUARDIAN_MSG
  return null
}

export const patientRegistrationSchema = z.object({
  ...demographicsShape,
  aadhaar: aadhaarInputSchema,
  abha: abhaInputSchema,
  kyc: z.object({ docType: z.enum(KYC_DOC_TYPES), docNumber: safeText(z.string().trim().min(1).max(40)) }).optional(),
  contacts: z.array(contactInputSchema).max(5).default([]),
  currentProvider: z.string().optional(),
  primaryPayerId: z.number().int().optional(),
  primaryMemberId: z.string().optional(),
  primaryGroupNumber: z.string().optional(),
  primaryPlanType: z.enum(['ppo', 'hmo', 'epo', 'pos', 'medicare', 'medicaid']).optional(),
  primarySubscriberName: z.string().optional(),
  primarySubscriberRelationship: z.enum(['self', 'spouse', 'child', 'other']).optional(),
}).strict().superRefine((v, ctx) => {
  const g = guardianProblem(v.contacts, v.dob, todayIsoIn())
  if (g) ctx.addIssue({ code: 'custom', path: ['contacts'], message: g })
  if (!v.isMlc && v.mlcNumber) ctx.addIssue({ code: 'custom', path: ['mlcNumber'], message: 'MLC number requires the MLC flag' })
})

// Name and date of birth are fixed at registration; everything else is
// optional here, and the optional-at-registration fields may be sent as null
// to clear them. Partial updates must not inject defaults (nationality / isMlc).
const NULLABLE_ON_UPDATE = ['maritalStatus', 'bloodGroup', 'occupation', 'religion', 'preferredLanguage', 'email', 'phone', 'addressLine2', 'mlcNumber'] as const
const { name: _name, dob: _dob, ...editableDemographics } = demographicsShape // eslint-disable-line @typescript-eslint/no-unused-vars
const partialDemographics = Object.fromEntries(
  Object.entries(editableDemographics).map(([k, v]) => {
    const base = (v instanceof z.ZodDefault ? v.unwrap() : v) as z.ZodType
    const unwrapped = base instanceof z.ZodOptional ? (base.unwrap() as z.ZodType) : base
    return [k, ((NULLABLE_ON_UPDATE as readonly string[]).includes(k) ? unwrapped.nullable() : unwrapped).optional()]
  }),
) as unknown as {
  [K in keyof typeof editableDemographics]: K extends (typeof NULLABLE_ON_UPDATE)[number]
    ? z.ZodOptional<z.ZodNullable<z.ZodType<NonNullable<z.output<(typeof editableDemographics)[K]>>>>>
    : z.ZodOptional<z.ZodType<z.output<(typeof editableDemographics)[K]>>>
}

export const patientProfileUpdateSchema = z.object({
  ...partialDemographics,
  abha: abhaInputSchema.optional(),
}).strict().refine((v) => Object.values(v).some((x) => x !== undefined), 'At least one field is required')

export const contactsReplaceSchema = z.object({ contacts: z.array(contactInputSchema).max(5) }).strict()

export type PatientRegistrationInput = z.output<typeof patientRegistrationSchema>
export type PatientProfileUpdateInput = z.output<typeof patientProfileUpdateSchema>
export type AadhaarInput = z.output<typeof aadhaarInputSchema>
export type AbhaInput = z.output<typeof abhaInputSchema>
export type ContactInput = z.output<typeof contactInputSchema>

// Wave C P1-11: admin-only correction of the two fields fixed at registration
// (a typo in the name or DOB), always with a reason that is audited.
export const demographicsCorrectionSchema = z.object({
  name: demographicsShape.name.optional(),
  dob: demographicsShape.dob.optional(),
  reason: safeText(z.string().trim().min(5, 'Give a reason of at least 5 characters').max(500)),
}).strict().refine((v) => v.name !== undefined || v.dob !== undefined, 'Change the name or the date of birth')

export type DemographicsCorrectionInput = z.output<typeof demographicsCorrectionSchema>
