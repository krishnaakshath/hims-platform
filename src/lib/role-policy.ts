import type { Role } from '@/lib/auth'

// Named role allowlists shared by page gates, API route gates, and the role
// harnesses. Dependency-free at runtime (only `import type`): many tests
// `vi.mock('@/lib/auth')` with a partial factory, so these constants must
// never live in auth.ts or anything that imports it at runtime.
//
// Every check built on these is an allowlist, so an unknown/future role is
// denied by default.

export const ALL_ROLES = ['crc', 'pi', 'admin', 'frontdesk', 'pharmacy', 'billing', 'labs',
  'coder', // SP6
  'collector', // SP5
  'rcm', // SP7
] as const

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
export const TARIFF_LOOKUP_ROLES: readonly Role[] = ['admin', 'billing', 'crc', 'frontdesk', 'rcm'] // SP7: + rcm (pre-auth estimate service search)

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

// SP4 charge capture & GST invoices (plan 2026-10-07-sp4-charge-capture.md, RBAC table).
// Capture = capture/preview/void lines, post room rent, create/discard draft invoices,
// every /billing/* SP4 page, invoice print. Authority = manual price override, overriding
// an overridable blocking rule, finalise, cancel by credit note, refund. Cash desk =
// /cash-desk, record advances and receipts, view a patient's ledger, receipt print
// (frontdesk takes money but never overrides, finalises, cancels or refunds). Config =
// billing settings, rule configuration and payer billing flags writes (billing sees them
// read-only: the department being policed does not switch its own controls off).
export const CHARGE_CAPTURE_ROLES: readonly Role[] = CHARGES_ROLES
export const BILLING_AUTHORITY_ROLES: readonly Role[] = ['admin', 'billing']
export const CASH_DESK_ROLES: readonly Role[] = ['admin', 'billing', 'crc', 'frontdesk']
export const BILLING_CONFIG_ROLES: readonly Role[] = MASTER_DATA_ADMIN_ROLES
// end SP4
// SP5 lab LIS & home collection. Worklist and collect are the existing lab
// gates, now named. Result entry is labs (+admin) and verification pi (+admin):
// the spec's role split. The collector role is field staff: it appears only in
// the cancel list (own visit, collector reasons only) and the route list (own
// visits only); every other gate denies it.
export const LAB_WORKLIST_ROLES: readonly Role[] = ['admin', 'pi', 'crc', 'labs']
export const LAB_ORDER_ROLES: readonly Role[] = ['admin', 'pi']
export const LAB_COLLECT_ROLES: readonly Role[] = ['admin', 'pi', 'labs']
export const LAB_RECEIVE_ROLES: readonly Role[] = ['admin', 'labs']
export const LAB_RESULT_ENTRY_ROLES: readonly Role[] = ['admin', 'labs']
export const LAB_VERIFY_ROLES: readonly Role[] = ['admin', 'pi']
export const LAB_REPORT_RELEASE_ROLES: readonly Role[] = ['admin', 'pi', 'labs']
export const LAB_REPORT_READ_ROLES: readonly Role[] = ['admin', 'pi', 'crc', 'labs']
export const LAB_LABEL_ROLES: readonly Role[] = ['admin', 'pi', 'labs', 'frontdesk']
export const LAB_SETUP_ROLES: readonly Role[] = ['admin']
export const HOME_COLLECTION_BOOKING_ROLES: readonly Role[] = ['admin', 'frontdesk', 'labs']
export const HOME_COLLECTION_CANCEL_ROLES: readonly Role[] = ['admin', 'frontdesk', 'labs', 'collector']
export const HOME_COLLECTION_DISPATCH_ROLES: readonly Role[] = ['admin', 'labs']
export const COLLECTOR_ROUTE_ROLES: readonly Role[] = ['admin', 'collector']
export const NOTIFICATION_PREFERENCE_ROLES: readonly Role[] = ['admin', 'crc', 'frontdesk']
// end SP5

// SP6 clinical coding. Coding = /coding* pages (except code systems), the
// workspace, status actions, raising/closing queries and service-code mapping
// writes. Entry = the gate of the diagnosis/procedure write routes (behaviour
// differs by role: a pi proposes, a coder decides). Propose = the chart's
// "propose code" UI. Query respond = reply on a coding query. Lookup = code
// search and service-code lookup (no PHI). Code-system admin = import / set
// current and /coding/code-systems. The coder is deliberately in neither
// CLINICAL_ROLES nor PATIENT_DIRECTORY_ROLES: no chart, no /patients, no
// global search. Per-action status roles live in src/lib/coding/status.ts.
export const CODING_ROLES: readonly Role[] = ['admin', 'coder']
export const CODING_ENTRY_ROLES: readonly Role[] = ['admin', 'coder', 'pi']
// Propose is pi only: the write routes treat admin as a coder (codes directly, code required,
// completed visits only), so admin codes from the coding workspace, not the chart.
export const CODE_PROPOSE_ROLES: readonly Role[] = ['pi']
export const CODING_QUERY_RESPOND_ROLES: readonly Role[] = ['admin', 'pi', 'coder']
export const CODE_LOOKUP_ROLES: readonly Role[] = ['admin', 'coder', 'pi', 'crc', 'billing', 'rcm'] // SP7: + rcm (pre-auth diagnosis/procedure search)
export const CODE_SYSTEM_ADMIN_ROLES: readonly Role[] = ['admin']
// end SP6

// SP7 RCM, insurer/TPA and claims (plan 2026-10-07-sp7-rcm-claims.md, RBAC table).
// RCM = every /rcm page except settings; claims, pre-auths, their documents, insurer
// updates, settlements, reconciliation, write-off requests and the pre-auth estimate.
// Payer master = insurer/TPA profile, contacts, network and document-requirement writes.
// Settings = the hospital ROHINI / HFR identifiers. Policy read/write = a patient's
// policies and policy-card images. Pre-auth lookup = the approved pre-auths of a patient
// (the charge-capture picker). Write-off approve = the second person on a write-off.
// Claim ABHA read = ABHA on a claim whose payer requires it. rcm is deliberately in
// neither CLINICAL_ROLES nor PATIENT_DIRECTORY_ROLES nor any SP4 billing list.
export const RCM_ROLES: readonly Role[] = ['admin', 'rcm']
export const PAYER_MASTER_ROLES: readonly Role[] = ['admin', 'rcm']
export const RCM_SETTINGS_ROLES: readonly Role[] = ['admin']
export const POLICY_READ_ROLES: readonly Role[] = ['admin', 'rcm', 'frontdesk', 'billing', 'crc']
export const POLICY_WRITE_ROLES: readonly Role[] = ['admin', 'rcm', 'frontdesk']
export const PREAUTH_LOOKUP_ROLES: readonly Role[] = ['admin', 'rcm', 'billing', 'crc']
export const WRITE_OFF_APPROVE_ROLES: readonly Role[] = ['admin']
export const CLAIM_ABHA_READ_ROLES: readonly Role[] = ['admin', 'rcm']
// end SP7

// Wave B: account self-service and reachability.
// Account = /account (own MFA method, MFA self-reset, "what you can do"):
// every staff role. A named allowlist (not "no gate") so an unknown/future
// role is still denied by default.
export const ACCOUNT_ROLES: readonly Role[] = ALL_ROLES
// end Wave B

// Wave C: patient identification and front-desk flow.
// Picker = the patient typeahead (GET /api/patients/lookup) used by check-in,
// booking, the pharmacy counter and billing's eligibility check: the
// directory roles plus the two counters that already look a patient up by
// id (pharmacy dispensing, billing eligibility/charges). Labs is not a
// picker role (its worklist is its lookup). Results are a minimal projection
// (name, UHID, chart id, age, gender); the mobile number is returned only to
// PATIENT_DIRECTORY_ROLES, the roles that already see it on /patients.
export const PATIENT_PICKER_ROLES: readonly Role[] = ['admin', 'crc', 'pi', 'frontdesk', 'pharmacy', 'billing']
export const PATIENT_PICKER_PHONE_ROLES: readonly Role[] = PATIENT_DIRECTORY_ROLES
// OPD token slip (/print/token/[encounterId]) = whoever may check in.
// Registration slip / UHID card (/print/registration/[anonId]) = registration roles.
// Name / date-of-birth correction after registration (P1-11): admin only.
export const DEMOGRAPHICS_CORRECTION_ROLES: readonly Role[] = ['admin']
// Clearing the MLC flag once set (P2-11): admin only; anyone who edits a
// profile may still set it.
export const MLC_UNFLAG_ROLES: readonly Role[] = ['admin']
// end Wave C

// Global search (TopBanner). Patients only for PATIENT_DIRECTORY_ROLES (no
// directory for pharmacy/billing/labs); services = the tariff catalogue for
// TARIFF_MANAGE_ROLES (Wave B P1-24). Pharmacy and labs have no global
// search: their counter lookup and worklist are their search.
export type SearchScopes = { patients: boolean; trials: boolean; formTemplates: boolean; services: boolean }

export function searchScopesFor(role: Role): SearchScopes {
  const clinical = CLINICAL_ROLES.includes(role)
  return {
    patients: PATIENT_DIRECTORY_ROLES.includes(role),
    trials: clinical,
    formTemplates: clinical,
    services: TARIFF_MANAGE_ROLES.includes(role),
  }
}

export function hasSearchScope(role: Role): boolean {
  const s = searchScopesFor(role)
  return s.patients || s.trials || s.formTemplates || s.services
}
