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
