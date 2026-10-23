import { patientRegistrationSchema, guardianProblem, referralProblem } from '@/lib/validation/patient-registration'
import { todayIsoIn } from '@/lib/india-time'

export interface ContactDraft {
  kind: 'next_of_kin' | 'guardian' | 'emergency'
  name: string
  relationship: string
  phone: string
  addressText: string
  // Wave C P2-11: carried through a profile edit so saving contacts never
  // wipes the primary flag already on file (registration does not set it).
  isPrimary?: boolean
}

export interface RegistrationFormState {
  // Demographics
  name: string
  dob: string
  gender: string
  maritalStatus: string
  bloodGroup: string
  occupation: string
  nationality: string
  religion: string
  preferredLanguage: string
  email: string
  phone: string
  // Address
  addressLine1: string
  addressLine2: string
  city: string
  district: string
  stateCode: string
  pinCode: string
  // National identity. The Aadhaar number lives in state only until submit.
  aadhaarMode: 'provided' | 'declined'
  aadhaarNumber: string
  aadhaarConsent: boolean
  aadhaarDeclineReason: string
  aadhaarDeclineNote: string
  abhaMode: 'provided' | 'unavailable'
  abhaNumber: string
  abhaAddress: string
  abhaUnavailableReason: string
  abhaUnavailableNote: string
  // SP8: the ABDM flow that verified abhaNumber ('' when typed by hand)
  abhaFlowId: string
  kycDocType: string
  kycDocNumber: string
  isMlc: boolean
  mlcNumber: string
  contacts: ContactDraft[]
  // Care + insurance (unchanged block)
  currentProvider: string
  primaryPayerId: string
  primaryMemberId: string
  primaryGroupNumber: string
  primaryPlanType: string
  primarySubscriberName: string
  primarySubscriberRelationship: string
  // WS6 T8: referral ('' = not recorded)
  referralSource: string
  referralNote: string
}

export const EMPTY_REGISTRATION_FORM: RegistrationFormState = {
  name: '', dob: '', gender: '', maritalStatus: '', bloodGroup: '', occupation: '', nationality: 'IN',
  religion: '', preferredLanguage: '', email: '', phone: '',
  addressLine1: '', addressLine2: '', city: '', district: '', stateCode: '', pinCode: '',
  aadhaarMode: 'provided', aadhaarNumber: '', aadhaarConsent: false, aadhaarDeclineReason: '', aadhaarDeclineNote: '',
  abhaMode: 'provided', abhaNumber: '', abhaAddress: '', abhaUnavailableReason: '', abhaUnavailableNote: '', abhaFlowId: '',
  kycDocType: '', kycDocNumber: '', isMlc: false, mlcNumber: '', contacts: [],
  currentProvider: '', primaryPayerId: '', primaryMemberId: '', primaryGroupNumber: '', primaryPlanType: '',
  primarySubscriberName: '', primarySubscriberRelationship: '',
  referralSource: '', referralNote: '', // WS6 T8
}

export type SectionProps = {
  form: RegistrationFormState
  update: <K extends keyof RegistrationFormState>(k: K, v: RegistrationFormState[K]) => void
  errors: Record<string, string>
}

const opt = (s: string) => (s.trim() === '' ? undefined : s)

function withoutUndefined<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
}

export function toRegistrationPayload(form: RegistrationFormState): unknown {
  const aadhaar = form.aadhaarMode === 'provided'
    ? { status: 'provided', number: form.aadhaarNumber, consent: form.aadhaarConsent }
    : withoutUndefined({ status: 'declined', reason: form.aadhaarDeclineReason, note: opt(form.aadhaarDeclineNote) })
  const abha = form.abhaMode === 'provided'
    ? withoutUndefined({ status: 'provided', abhaNumber: opt(form.abhaNumber), abhaAddress: opt(form.abhaAddress), flowId: opt(form.abhaFlowId) })
    : withoutUndefined({ status: 'unavailable', reason: form.abhaUnavailableReason, note: opt(form.abhaUnavailableNote) })
  const hasKyc = form.kycDocType !== '' || form.kycDocNumber.trim() !== ''
  const hasPayer = form.primaryPayerId !== ''
  return withoutUndefined({
    name: form.name,
    dob: form.dob,
    gender: form.gender,
    maritalStatus: opt(form.maritalStatus),
    bloodGroup: opt(form.bloodGroup),
    occupation: opt(form.occupation),
    nationality: form.nationality || 'IN',
    religion: opt(form.religion),
    preferredLanguage: opt(form.preferredLanguage),
    email: opt(form.email),
    phone: opt(form.phone),
    addressLine1: form.addressLine1,
    addressLine2: opt(form.addressLine2),
    city: form.city,
    district: form.district,
    stateCode: form.stateCode,
    pinCode: form.pinCode,
    isMlc: form.isMlc,
    mlcNumber: form.isMlc ? opt(form.mlcNumber) : undefined,
    aadhaar,
    abha,
    kyc: hasKyc ? { docType: form.kycDocType, docNumber: form.kycDocNumber } : undefined,
    contacts: form.contacts.map((c) => withoutUndefined({
      kind: c.kind, name: c.name, relationship: c.relationship, phone: c.phone, addressText: opt(c.addressText),
    })),
    currentProvider: opt(form.currentProvider),
    primaryPayerId: hasPayer ? Number(form.primaryPayerId) : undefined,
    primaryMemberId: hasPayer ? opt(form.primaryMemberId) : undefined,
    primaryGroupNumber: hasPayer ? opt(form.primaryGroupNumber) : undefined,
    primaryPlanType: hasPayer ? opt(form.primaryPlanType) : undefined,
    primarySubscriberName: hasPayer ? opt(form.primarySubscriberName) : undefined,
    primarySubscriberRelationship: hasPayer ? opt(form.primarySubscriberRelationship) : undefined,
    // WS6 T8: the note travels only with a source.
    referralSource: opt(form.referralSource),
    referralNote: form.referralSource ? opt(form.referralNote) : undefined,
  })
}

/** Dotted-path -> first message, from zod issues. Empty when the payload is valid. */
export function fieldErrors(payload: unknown): Record<string, string> {
  const r = patientRegistrationSchema.safeParse(payload)
  if (r.success) return {}
  const out: Record<string, string> = {}
  for (const issue of r.error.issues) {
    const key = issue.path.join('.')
    if (!(key in out)) out[key] = issue.message
  }
  // WS6 T8: zod runs the cross-field rules only once every field parses; the stepped form
  // needs them per step, so they are checked here too (same messages as the schema).
  const p = (payload && typeof payload === 'object' ? payload : {}) as { referralSource?: string; referralNote?: string; dob?: unknown; contacts?: unknown }
  const referral = referralProblem(p.referralSource, p.referralNote)
  if (referral && !('referralNote' in out)) out.referralNote = referral
  if (typeof p.dob === 'string' && !('dob' in out) && Array.isArray(p.contacts) && !('contacts' in out)) {
    const guardian = guardianProblem(p.contacts as { kind: string }[], p.dob, todayIsoIn())
    if (guardian) out.contacts = guardian
  }
  return out
}

/** Server 400 body (`details` is zod's flatten(): top-level keys only) -> errors map. */
export function serverFieldErrors(body: unknown): Record<string, string> {
  const fe = (body as { details?: { fieldErrors?: Record<string, string[] | undefined> } } | null)?.details?.fieldErrors
  const out: Record<string, string> = {}
  if (fe && typeof fe === 'object') for (const [k, v] of Object.entries(fe)) if (v?.[0]) out[k] = v[0]
  return out
}

/** First error found under any of the given keys (a path, or its top-level fallback). */
export function pickError(errors: Record<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) if (errors[k]) return errors[k]
  return undefined
}

// WS6 T8: registration in steps. Each validation error belongs to the step that shows its field
// (keyed by the first segment of its dotted path); anything not listed for steps 1-2 is step 3.
export const REGISTRATION_STEPS = ['Identity', 'Contact & address', 'IDs & insurance', 'Review'] as const
const STEP_ROOTS: readonly (readonly string[])[] = [
  ['name', 'dob', 'gender', 'maritalStatus', 'bloodGroup', 'occupation', 'nationality', 'religion', 'preferredLanguage', 'email', 'phone', 'referralSource', 'referralNote'],
  ['addressLine1', 'addressLine2', 'city', 'district', 'stateCode', 'pinCode', 'contacts'],
]

/** The step (0-based) whose fields carry this error key. */
export function stepOfErrorKey(key: string): number {
  const root = key.split('.')[0]
  const i = STEP_ROOTS.findIndex((roots) => roots.includes(root))
  return i === -1 ? 2 : i
}

/** The errors that belong to one step. The Review step (3) owns none. */
export function errorsForStep(errors: Record<string, string>, step: number): Record<string, string> {
  return Object.fromEntries(Object.entries(errors).filter(([k]) => stepOfErrorKey(k) === step))
}

/** The payload key a form field validates under (`aadhaarNumber` -> `aadhaar`, ...). */
export function errorRootOf(formKey: keyof RegistrationFormState): string {
  if (formKey.startsWith('aadhaar')) return 'aadhaar'
  if (formKey.startsWith('abha')) return 'abha'
  if (formKey.startsWith('kyc')) return 'kyc'
  return formKey
}
// end WS6 T8
