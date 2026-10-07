import type { Role } from '@/lib/auth'

// Named role allowlists shared by page gates, API route gates, and the role
// harnesses. Dependency-free at runtime (only `import type`): many tests
// `vi.mock('@/lib/auth')` with a partial factory, so these constants must
// never live in auth.ts or anything that imports it at runtime.
//
// Every check built on these is an allowlist, so an unknown/future role is
// denied by default.

export const ALL_ROLES = ['crc', 'pi', 'admin', 'frontdesk', 'pharmacy', 'billing', 'labs'] as const

// Compile-time guard: adding a Role without adding it to ALL_ROLES fails tsc.
type MissingFromAllRoles = Exclude<Role, (typeof ALL_ROLES)[number]>
const allRolesIsExhaustive: [MissingFromAllRoles] extends [never] ? true : false = true
void allRolesIsExhaustive

// Chart, patient JSON APIs, FHIR/C-CDA, trials pages + GET, client forms,
// form-submissions, form-templates, discrepancy resolve, staff directory pages.
export const CLINICAL_ROLES: readonly Role[] = ['admin', 'crc', 'pi']

// /patients list + patient detail pages (frontdesk gets a reduced view).
export const PATIENT_DIRECTORY_ROLES: readonly Role[] = ['admin', 'crc', 'pi', 'frontdesk']

// /calendar + /api/appointments*.
export const SCHEDULING_ROLES: readonly Role[] = ['admin', 'crc', 'pi', 'frontdesk']

export const DOCUMENT_READ_ROLES: readonly Role[] = ['admin', 'crc', 'pi', 'frontdesk']

export const INSURANCE_CARD_READ_ROLES: readonly Role[] = ['admin', 'crc', 'pi', 'frontdesk', 'billing']

// GET /api/patients/[anonId]/primary-payer: the billing eligibility modal's
// payer prefill. Returns only the payer id, never the patient detail JSON.
export const PAYER_LOOKUP_ROLES: readonly Role[] = ['admin', 'crc', 'billing']

export const IDENTITY_VERIFY_ROLES: readonly Role[] = ['admin', 'crc', 'frontdesk']

export const TRIAL_CRITERIA_EDIT_ROLES: readonly Role[] = ['admin', 'pi']

export const CHARGES_ROLES: readonly Role[] = ['admin', 'crc', 'billing']

// Whole-workbook downloads (/api/workbook/full, /api/workbook/export). The
// /workbook page itself is CLINICAL_ROLES; pi views it but cannot download.
export const WORKBOOK_EXPORT_ROLES: readonly Role[] = ['admin', 'crc']

// Practice master-data configuration (UHID prefix, and later tariff/department masters).
export const MASTER_DATA_ADMIN_ROLES: readonly Role[] = ['admin']

// SP1 patient master. Registration creates a patient (and its UHID); crc
// edits profiles and writes Aadhaar only through PUT /aadhaar.
export const REGISTRATION_ROLES: readonly Role[] = ['admin', 'frontdesk']
export const PATIENT_PROFILE_EDIT_ROLES: readonly Role[] = ['admin', 'crc', 'frontdesk']
// Aadhaar: who may record/replace/decline it, and who may see the masked
// last 4 (`XXXX XXXX 1234`). Everyone else, the portal included, sees status
// only. No role ever reads the plaintext number back, and no role exports it.
export const AADHAAR_WRITE_ROLES: readonly Role[] = ['admin', 'crc', 'frontdesk']
export const AADHAAR_MASKED_READ_ROLES: readonly Role[] = ['admin', 'crc']

// SP2 tariff master. Manage = every tariff page and write (services, rates,
// packages, room categories, CSV import). Lookup = the price lookup and the
// service search only (GET /api/tariff/resolve, GET /api/tariff/services).
export const TARIFF_MANAGE_ROLES: readonly Role[] = ['admin', 'billing']
export const TARIFF_LOOKUP_ROLES: readonly Role[] = ['admin', 'billing', 'crc', 'frontdesk']

// SP3 follow-up and encounters. View = see follow-ups on the patient page.
// Plan = create/change/cancel the clinical plan. Booking = book, reschedule,
// unbook and log contact attempts. Worklist = the front-desk recall page.
// Clinical notes = may receive planNotes. Check-in and discharge are the
// existing gates, now named. Encounter status = the route gate; per-transition
// roles live in src/lib/encounters/status.ts.
export const FOLLOW_UP_VIEW_ROLES: readonly Role[] = ['admin', 'pi', 'crc', 'frontdesk']
export const FOLLOW_UP_PLAN_ROLES: readonly Role[] = ['admin', 'pi']
export const FOLLOW_UP_BOOKING_ROLES: readonly Role[] = ['admin', 'frontdesk']
export const FOLLOW_UP_WORKLIST_ROLES: readonly Role[] = ['admin', 'crc', 'frontdesk']
export const FOLLOW_UP_CLINICAL_NOTES_ROLES: readonly Role[] = ['admin', 'crc', 'pi']
export const CHECK_IN_ROLES: readonly Role[] = ['frontdesk', 'admin', 'crc']
export const ENCOUNTER_STATUS_ROLES: readonly Role[] = ['admin', 'pi', 'frontdesk', 'crc']
export const DISCHARGE_ROLES: readonly Role[] = ['admin', 'pi']
// end SP3

// Wave B: account self-service and reachability.
// Account = /account (own MFA method, MFA self-reset, "what you can do"):
// every staff role. A named allowlist (not "no gate") so an unknown/future
// role is still denied by default.
export const ACCOUNT_ROLES: readonly Role[] = ALL_ROLES
// end Wave B

export type SearchScopes = { patients: boolean; trials: boolean; formTemplates: boolean }

export function searchScopesFor(role: Role): SearchScopes {
  const clinical = CLINICAL_ROLES.includes(role)
  return {
    patients: PATIENT_DIRECTORY_ROLES.includes(role),
    trials: clinical,
    formTemplates: clinical,
  }
}

export function hasSearchScope(role: Role): boolean {
  const s = searchScopesFor(role)
  return s.patients || s.trials || s.formTemplates
}
