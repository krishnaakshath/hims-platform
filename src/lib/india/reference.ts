// Pure, client-safe Indian reference data. Codes mirror the DB enums in
// src/db/schema.ts (deliberately not imported, to keep this client-safe).
type Coded<C extends string = string> = { readonly code: C; readonly label: string }

export const INDIAN_STATES = [
  { code: 'IN-AN', label: 'Andaman and Nicobar Islands' },
  { code: 'IN-AP', label: 'Andhra Pradesh' },
  { code: 'IN-AR', label: 'Arunachal Pradesh' },
  { code: 'IN-AS', label: 'Assam' },
  { code: 'IN-BR', label: 'Bihar' },
  { code: 'IN-CH', label: 'Chandigarh' },
  { code: 'IN-CG', label: 'Chhattisgarh' },
  { code: 'IN-DH', label: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: 'IN-DL', label: 'Delhi' },
  { code: 'IN-GA', label: 'Goa' },
  { code: 'IN-GJ', label: 'Gujarat' },
  { code: 'IN-HR', label: 'Haryana' },
  { code: 'IN-HP', label: 'Himachal Pradesh' },
  { code: 'IN-JK', label: 'Jammu and Kashmir' },
  { code: 'IN-JH', label: 'Jharkhand' },
  { code: 'IN-KA', label: 'Karnataka' },
  { code: 'IN-KL', label: 'Kerala' },
  { code: 'IN-LA', label: 'Ladakh' },
  { code: 'IN-LD', label: 'Lakshadweep' },
  { code: 'IN-MP', label: 'Madhya Pradesh' },
  { code: 'IN-MH', label: 'Maharashtra' },
  { code: 'IN-MN', label: 'Manipur' },
  { code: 'IN-ML', label: 'Meghalaya' },
  { code: 'IN-MZ', label: 'Mizoram' },
  { code: 'IN-NL', label: 'Nagaland' },
  { code: 'IN-OD', label: 'Odisha' },
  { code: 'IN-PY', label: 'Puducherry' },
  { code: 'IN-PB', label: 'Punjab' },
  { code: 'IN-RJ', label: 'Rajasthan' },
  { code: 'IN-SK', label: 'Sikkim' },
  { code: 'IN-TN', label: 'Tamil Nadu' },
  { code: 'IN-TS', label: 'Telangana' },
  { code: 'IN-TR', label: 'Tripura' },
  { code: 'IN-UP', label: 'Uttar Pradesh' },
  { code: 'IN-UK', label: 'Uttarakhand' },
  { code: 'IN-WB', label: 'West Bengal' },
] as const satisfies readonly Coded[]

const STATE_BY_CODE = new Map<string, string>(INDIAN_STATES.map((s) => [s.code, s.label]))

export function isIndianStateCode(code: string): boolean {
  return STATE_BY_CODE.has(code)
}
export function stateName(code: string): string | null {
  return STATE_BY_CODE.get(code) ?? null
}
export function isValidPinCode(pin: string): boolean {
  return /^[1-9][0-9]{5}$/.test(pin)
}

export const GENDERS = [
  { code: 'male', label: 'Male' },
  { code: 'female', label: 'Female' },
  { code: 'transgender', label: 'Transgender' },
  { code: 'other', label: 'Other' },
  { code: 'unknown', label: 'Unknown' },
] as const satisfies readonly Coded[]

export const MARITAL_STATUSES = [
  { code: 'single', label: 'Single' },
  { code: 'married', label: 'Married' },
  { code: 'divorced', label: 'Divorced' },
  { code: 'widowed', label: 'Widowed' },
  { code: 'separated', label: 'Separated' },
  { code: 'unknown', label: 'Unknown' },
] as const satisfies readonly Coded[]

export const BLOOD_GROUPS = [
  { code: 'A+', label: 'A+' },
  { code: 'A-', label: 'A-' },
  { code: 'B+', label: 'B+' },
  { code: 'B-', label: 'B-' },
  { code: 'AB+', label: 'AB+' },
  { code: 'AB-', label: 'AB-' },
  { code: 'O+', label: 'O+' },
  { code: 'O-', label: 'O-' },
  { code: 'unknown', label: 'Unknown' },
] as const satisfies readonly Coded[]

// Aadhaar is deliberately absent: it is captured via its own consented flow.
export const KYC_DOC_TYPES = ['passport', 'drivers_license', 'voter_id', 'pan', 'ration_card'] as const
export const KYC_DOC_LABELS: Record<(typeof KYC_DOC_TYPES)[number], string> = {
  passport: 'Passport',
  drivers_license: 'Driving licence',
  voter_id: 'Voter ID (EPIC)',
  pan: 'PAN card',
  ration_card: 'Ration card',
}

export const AADHAAR_DECLINE_REASONS = [
  { code: 'patient_declined', label: 'Patient declined' },
  { code: 'not_available', label: 'Aadhaar not available' },
  { code: 'minor_no_aadhaar', label: 'Minor without Aadhaar' },
  { code: 'emergency', label: 'Emergency' },
  { code: 'foreign_national', label: 'Foreign national' },
  { code: 'other', label: 'Other' },
] as const satisfies readonly Coded[]

export const ABHA_UNAVAILABLE_REASONS = [
  { code: 'not_created', label: 'ABHA not created yet' },
  { code: 'patient_declined', label: 'Patient declined' },
  { code: 'emergency', label: 'Emergency' },
  { code: 'other', label: 'Other' },
] as const satisfies readonly Coded[]

export const CONTACT_RELATIONSHIPS = ['spouse', 'parent', 'child', 'sibling', 'guardian', 'relative', 'friend', 'other'] as const

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
  { code: 'bn', label: 'Bengali' },
  { code: 'te', label: 'Telugu' },
  { code: 'mr', label: 'Marathi' },
  { code: 'ta', label: 'Tamil' },
  { code: 'ur', label: 'Urdu' },
  { code: 'gu', label: 'Gujarati' },
  { code: 'kn', label: 'Kannada' },
  { code: 'ml', label: 'Malayalam' },
  { code: 'or', label: 'Odia' },
  { code: 'pa', label: 'Punjabi' },
  { code: 'as', label: 'Assamese' },
] as const satisfies readonly Coded[]
