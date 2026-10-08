import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { getDb } from '@/db/client'
import { reviews } from '@/db/schema'
import type { Role } from '@/lib/auth'
import { ALL_ROLES } from '@/lib/role-policy'
import {
  AADHAAR_WRITE_ROLES,
  CHARGES_ROLES,
  CLINICAL_ROLES,
  DOCUMENT_READ_ROLES,
  IDENTITY_VERIFY_ROLES,
  INSURANCE_CARD_READ_ROLES,
  MASTER_DATA_ADMIN_ROLES,
  PAYER_LOOKUP_ROLES,
  PATIENT_PROFILE_EDIT_ROLES,
  REGISTRATION_ROLES,
  SCHEDULING_ROLES,
  TARIFF_LOOKUP_ROLES,
  TARIFF_MANAGE_ROLES,
  TRIAL_CRITERIA_EDIT_ROLES,
  hasSearchScope,
} from '@/lib/role-policy'
import { PATIENT_PICKER_ROLES, DEMOGRAPHICS_CORRECTION_ROLES } from '@/lib/role-policy' // Wave C
import { CHECK_IN_ROLES, DISCHARGE_ROLES, ENCOUNTER_STATUS_ROLES, FOLLOW_UP_BOOKING_ROLES, FOLLOW_UP_PLAN_ROLES } from '@/lib/role-policy' // SP3
import { BILLING_AUTHORITY_ROLES, BILLING_CONFIG_ROLES, CASH_DESK_ROLES, CHARGE_CAPTURE_ROLES } from '@/lib/role-policy' // SP4
import { gateIt } from '../pages/page-gates-harness'
// SP7
import { PAYER_MASTER_ROLES, RCM_SETTINGS_ROLES, POLICY_READ_ROLES, POLICY_WRITE_ROLES } from '@/lib/role-policy'
import { POST as postRcmPolicy } from '@/app/api/rcm/policies/route'
import { PATCH as patchRcmPolicy } from '@/app/api/rcm/policies/[id]/route'
import { POST as postRcmPolicyCard } from '@/app/api/rcm/policies/[id]/card/route'
import { GET as getRcmPolicyCard } from '@/app/api/rcm/policies/[id]/card/[side]/route'
import { RCM_ROLES, PREAUTH_LOOKUP_ROLES } from '@/lib/role-policy'
import { POST as postRcmPreauth } from '@/app/api/rcm/preauths/route'
import { POST as postRcmPreauthEstimate } from '@/app/api/rcm/preauths/estimate/route'
import { POST as postRcmPreauthAction } from '@/app/api/rcm/preauths/[id]/actions/route'
import { POST as postRcmPreauthDocument } from '@/app/api/rcm/preauths/[id]/documents/route'
import { GET as getRcmPreauthDocument } from '@/app/api/rcm/preauth-documents/[id]/route'
import { GET as getRcmApprovedPreauths } from '@/app/api/rcm/patients/[anonId]/approved-preauths/route'
import { WRITE_OFF_APPROVE_ROLES } from '@/lib/role-policy'
import { POST as postRcmClaim } from '@/app/api/rcm/claims/route'
import { PUT as putRcmClaimInvoices } from '@/app/api/rcm/claims/[id]/invoices/route'
import { POST as postRcmClaimDocument } from '@/app/api/rcm/claims/[id]/documents/route'
import { POST as postRcmClaimAttach } from '@/app/api/rcm/claims/[id]/documents/attach/route'
import { POST as postRcmClaimWaive } from '@/app/api/rcm/claims/[id]/documents/waive/route'
import { DELETE as deleteRcmClaimDocument } from '@/app/api/rcm/claims/[id]/documents/[docId]/route'
import { GET as getRcmClaimPreview } from '@/app/api/rcm/claims/[id]/preview/route'
import { POST as postRcmClaimSubmission } from '@/app/api/rcm/claims/[id]/submissions/route'
import { POST as postRcmClaimAction } from '@/app/api/rcm/claims/[id]/actions/route'
import { POST as postRcmClaimSettlement } from '@/app/api/rcm/claims/[id]/settlements/route'
import { POST as postRcmClaimWriteOff } from '@/app/api/rcm/claims/[id]/write-offs/route'
import { GET as getRcmClaimDocument } from '@/app/api/rcm/claim-documents/[id]/route'
import { POST as postRcmAcknowledge } from '@/app/api/rcm/dispatches/[id]/acknowledge/route'
import { GET as getRcmCopy } from '@/app/api/rcm/submissions/[id]/copy/[copy]/route'
import { GET as getRcmVerify } from '@/app/api/rcm/submissions/[id]/verify/route'
import { POST as postRcmReconcile } from '@/app/api/rcm/settlements/[id]/reconcile/route'
import { POST as postRcmWriteOffDecision } from '@/app/api/rcm/write-offs/[id]/decision/route'
import { POST as postRcmPayer } from '@/app/api/rcm/payers/route'
import { PUT as putRcmPayer } from '@/app/api/rcm/payers/[id]/route'
import { PUT as putRcmPayerContacts } from '@/app/api/rcm/payers/[id]/contacts/route'
import { PUT as putRcmPayerNetworks } from '@/app/api/rcm/payers/[id]/networks/route'
import { PUT as putRcmPayerRequirements } from '@/app/api/rcm/payers/[id]/requirements/route'
import { PUT as putRcmSettings } from '@/app/api/rcm/settings/route'
// end SP7

// Module-scope mutable role, reset in afterEach -- the vi.mock('@/lib/auth', ...)
// + importActual pattern from tests/api/patients.test.ts:27-29, except the
// mocked role is driven by this variable instead of a fixed literal so a
// single describe block can exercise every role. The `requireSession` mock
// closure below only reads `sessionRole` when the route actually calls it
// (i.e. inside a test), by which point this `let` has long since initialized
// -- vi.mock's factory itself runs at module-link time, but the arrow
// function it returns isn't invoked until later.
let sessionRole: Role = 'crc'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: `Test ${sessionRole}`, userId: null })) }
})

// No audit rows from this harness: audit_log is an append-only compliance
// record on the shared DB, and these are synthetic probe calls.
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))

export { ALL_ROLES }
// Named for the allowlist it's computed against, not just "denied" -- Tasks
// 2 and 4 gate different routes against different allowlists (e.g.
// admin-only billing routes, or admin/crc/frontdesk routes), and a
// generically-named constant here is exactly the kind of thing a future
// author copies without checking, silently testing the wrong roles as
// denied.
const deniedFor = (allowed: Role[]): Role[] => ALL_ROLES.filter((r) => !allowed.includes(r))

afterEach(() => {
  sessionRole = 'crc'
})

import { PUT as putUhidPrefix } from '@/app/api/settings/uhid-prefix/route'
import { GET as getWorkbookFull } from '@/app/api/workbook/full/route'
import { GET as getWorkbookExport } from '@/app/api/workbook/export/route'
import { POST as postMockPayment } from '@/app/api/mock-payments/route'
import { GET as listBroadcasts, POST as postBroadcast } from '@/app/api/broadcasts/route'
import { GET as getBroadcast } from '@/app/api/broadcasts/[id]/route'
import { GET as listBroadcastRecipients } from '@/app/api/broadcasts/recipients/route'
import { GET as listReviews, POST as postReview } from '@/app/api/reviews/route'
import { GET as getReview, PUT as putReview } from '@/app/api/reviews/[id]/route'

describe('GET /api/workbook/full', () => {
  it('403s pi and frontdesk', async () => {
    for (const role of deniedFor(['admin', 'crc'])) {
      sessionRole = role
      const res = await getWorkbookFull()
      expect(res.status, `role ${role}`).toBe(403)
    }
  })

  it('returns the xlsx for admin and crc', async () => {
    for (const role of ['admin', 'crc'] as const) {
      sessionRole = role
      const res = await getWorkbookFull()
      expect(res.status, `role ${role}`).toBe(200)
    }
  })

  // Review Focus #2 — the gate must precede the export, not follow it
  it('does not build the workbook for a denied role', async () => {
    const excelExport = await import('@/lib/excel-export')
    const buildWorkbookSpy = vi.spyOn(excelExport, 'buildFullWorkbookXlsx')
    sessionRole = 'frontdesk'
    const res = await getWorkbookFull()
    expect(res.status).toBe(403)
    expect(buildWorkbookSpy).not.toHaveBeenCalled()
    buildWorkbookSpy.mockRestore()
  })
})

describe('GET /api/workbook/export', () => {
  it('403s pi and frontdesk', async () => {
    for (const role of deniedFor(['admin', 'crc'])) {
      sessionRole = role
      const res = await getWorkbookExport()
      expect(res.status, `role ${role}`).toBe(403)
    }
  })

  // Building the real xlsx for every patient across every trial is a
  // genuinely heavy multi-query operation, and the shared dev DB's data
  // volume only grows over time -- the global 15000ms default (already once
  // bumped from vitest's 5000ms, see vitest.config.ts) has been outgrown by
  // this specific test again. A generous override here, not a second global
  // bump, since most tests are nowhere near this heavy.
  it('returns the xlsx for admin and crc', { timeout: 60000 }, async () => {
    for (const role of ['admin', 'crc'] as const) {
      sessionRole = role
      const res = await getWorkbookExport()
      expect(res.status, `role ${role}`).toBe(200)
    }
  })

  it('does not build the workbook for a denied role', async () => {
    const excelExport = await import('@/lib/excel-export')
    const buildWorkbookSpy = vi.spyOn(excelExport, 'buildWorkbookXlsx')
    sessionRole = 'pi'
    const res = await getWorkbookExport()
    expect(res.status).toBe(403)
    expect(buildWorkbookSpy).not.toHaveBeenCalled()
    buildWorkbookSpy.mockRestore()
  })
})

describe('POST /api/mock-payments', () => {
  // /billing/pay's own page gate is admin/crc/billing, matching
  // VirtualCardPaymentForm's only POST target -- every other role 403s.
  it('403s every role outside admin, crc, billing', async () => {
    for (const role of deniedFor(['admin', 'crc', 'billing'])) {
      sessionRole = role
      const res = await postMockPayment(
        new NextRequest('http://localhost/api/mock-payments', { method: 'POST', body: JSON.stringify({}) })
      )
      expect(res.status, `role ${role}`).toBe(403)
    }
  })

  // An intentionally invalid (empty) body so an allowed role's response
  // proves it: the gate must let admin/crc/billing through to the route's
  // own Zod validation, which then 400s on the missing fields -- never
  // recording a payment. Anything other than 403 here shows the gate didn't
  // block them; the 400 itself is the route's own concern, not this test's.
  it('does not 403 admin, crc, or billing', async () => {
    for (const role of ['admin', 'crc', 'billing'] as const) {
      sessionRole = role
      const res = await postMockPayment(
        new NextRequest('http://localhost/api/mock-payments', { method: 'POST', body: JSON.stringify({}) })
      )
      expect(res.status, `role ${role}`).not.toBe(403)
    }
  })
})

// LeftNav.tsx:62 — { href: '/broadcasts', roles: ['admin', 'crc'] }
describe('GET /api/broadcasts', () => {
  it('403s pi and frontdesk', async () => {
    for (const role of deniedFor(['admin', 'crc'])) {
      sessionRole = role
      const res = await listBroadcasts()
      expect(res.status, `role ${role}`).toBe(403)
    }
  })

  it('returns 200 for admin', async () => {
    sessionRole = 'admin'
    const res = await listBroadcasts()
    expect(res.status).toBe(200)
  })
})

// LeftNav.tsx:62 — { href: '/broadcasts', roles: ['admin', 'crc'] }. Nothing
// here sends a real broadcast: an invalid (empty) body proves admin gets past
// the gate to the route's own Zod validation, which then 400s (route.ts:40) --
// never reaching the simulated-delivery insert.
describe('POST /api/broadcasts', () => {
  it('403s pi and frontdesk', async () => {
    for (const role of deniedFor(['admin', 'crc'])) {
      sessionRole = role
      const res = await postBroadcast(
        new NextRequest('http://localhost/api/broadcasts', { method: 'POST', body: JSON.stringify({}) })
      )
      expect(res.status, `role ${role}`).toBe(403)
    }
  })

  it('does not 403 admin', async () => {
    sessionRole = 'admin'
    const res = await postBroadcast(
      new NextRequest('http://localhost/api/broadcasts', { method: 'POST', body: JSON.stringify({}) })
    )
    expect(res.status).toBe(400)
  })
})

// LeftNav.tsx:62 — { href: '/broadcasts', roles: ['admin', 'crc'] }
describe('GET /api/broadcasts/[id]', () => {
  it('403s pi and frontdesk', async () => {
    for (const role of deniedFor(['admin', 'crc'])) {
      sessionRole = role
      const res = await getBroadcast(
        new NextRequest('http://localhost/api/broadcasts/999999'),
        { params: Promise.resolve({ id: '999999' }) }
      )
      expect(res.status, `role ${role}`).toBe(403)
    }
  })

  it('reaches the handler for admin (404 -- id 999999 does not exist)', async () => {
    sessionRole = 'admin'
    const res = await getBroadcast(
      new NextRequest('http://localhost/api/broadcasts/999999'),
      { params: Promise.resolve({ id: '999999' }) }
    )
    expect(res.status).toBe(404)
  })
})

// LeftNav.tsx:62 — { href: '/broadcasts', roles: ['admin', 'crc'] }
describe('GET /api/broadcasts/recipients', () => {
  it('403s pi and frontdesk', async () => {
    for (const role of deniedFor(['admin', 'crc'])) {
      sessionRole = role
      const res = await listBroadcastRecipients(new NextRequest('http://localhost/api/broadcasts/recipients'))
      expect(res.status, `role ${role}`).toBe(403)
    }
  })

  it('returns 200 for admin', async () => {
    sessionRole = 'admin'
    const res = await listBroadcastRecipients(new NextRequest('http://localhost/api/broadcasts/recipients'))
    expect(res.status).toBe(200)
  })
})

// LeftNav.tsx:63 — { href: '/experience-surveys', roles: ['admin', 'crc'] }
describe('GET /api/reviews', () => {
  it('403s pi and frontdesk', async () => {
    for (const role of deniedFor(['admin', 'crc'])) {
      sessionRole = role
      const res = await listReviews(new NextRequest('http://localhost/api/reviews'))
      expect(res.status, `role ${role}`).toBe(403)
    }
  })

  it('returns 200 for admin', async () => {
    sessionRole = 'admin'
    const res = await listReviews(new NextRequest('http://localhost/api/reviews'))
    expect(res.status).toBe(200)
  })
})

// LeftNav.tsx:63 — { href: '/experience-surveys', roles: ['admin', 'crc'] }.
// An invalid (empty) body proves admin gets past the gate to the route's own
// Zod validation, which then 400s (route.ts:38) -- never recording a survey
// send.
describe('POST /api/reviews', () => {
  it('403s pi and frontdesk', async () => {
    for (const role of deniedFor(['admin', 'crc'])) {
      sessionRole = role
      const res = await postReview(
        new NextRequest('http://localhost/api/reviews', { method: 'POST', body: JSON.stringify({}) })
      )
      expect(res.status, `role ${role}`).toBe(403)
    }
  })

  it('does not 403 admin', async () => {
    sessionRole = 'admin'
    const res = await postReview(
      new NextRequest('http://localhost/api/reviews', { method: 'POST', body: JSON.stringify({}) })
    )
    expect(res.status).toBe(400)
  })
})

// LeftNav.tsx:63 — { href: '/experience-surveys', roles: ['admin', 'crc'] }
describe('GET /api/reviews/[id]', () => {
  it('403s pi and frontdesk', async () => {
    for (const role of deniedFor(['admin', 'crc'])) {
      sessionRole = role
      const res = await getReview(
        new NextRequest('http://localhost/api/reviews/999999'),
        { params: Promise.resolve({ id: '999999' }) }
      )
      expect(res.status, `role ${role}`).toBe(403)
    }
  })

  it('returns 200 for admin', async () => {
    // 999999 is used as a definitely-nonexistent sentinel id elsewhere in
    // this suite (and in tests/lib/queries/reviews.test.ts's own "returns
    // null for a non-existent id") -- a 200 needs a review that actually
    // exists, which the seeded data guarantees at least a few of (see
    // tests/lib/queries/reviews.test.ts's "returns the seeded survey
    // records", length >= 3).
    const [row] = await getDb().select({ id: reviews.id }).from(reviews).limit(1)
    sessionRole = 'admin'
    const res = await getReview(
      new NextRequest(`http://localhost/api/reviews/${row.id}`),
      { params: Promise.resolve({ id: String(row.id) }) }
    )
    expect(res.status).toBe(200)
  })
})

// LeftNav.tsx:63 — { href: '/experience-surveys', roles: ['admin', 'crc'] }.
// This is staff recording a survey response on behalf of a patient, not a
// patient-facing endpoint (spec §7.2) -- nothing here records a real survey
// response: an invalid (empty) body proves admin gets past the gate to the
// route's own Zod validation, which then 400s (route.ts:35).
describe('PUT /api/reviews/[id]', () => {
  it('403s pi and frontdesk', async () => {
    for (const role of deniedFor(['admin', 'crc'])) {
      sessionRole = role
      const res = await putReview(
        new NextRequest('http://localhost/api/reviews/999999', { method: 'PUT', body: JSON.stringify({}) }),
        { params: Promise.resolve({ id: '999999' }) }
      )
      expect(res.status, `role ${role}`).toBe(403)
    }
  })

  it('does not 403 admin', async () => {
    sessionRole = 'admin'
    const res = await putReview(
      new NextRequest('http://localhost/api/reviews/999999', { method: 'PUT', body: JSON.stringify({}) }),
      { params: Promise.resolve({ id: '999999' }) }
    )
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// POLICY.md table: every role-gated API route x all 7 roles.
//
// Allowed-role calls use ids/bodies that cannot match or write anything
// (2147483000 / RD-ZZZZ / probe-no-trial, `{}` bodies that fail validation),
// so an allowed role proves only that the gate let it through (any status
// but 403). Rows tagged `gap: 'Tn'` are known-open until Task n and run as
// `it.fails`; RBAC_SHOW_GAPS=1 runs them as normal tests (the red list).
// ---------------------------------------------------------------------------

import { GET as listPatients, POST as postPatient } from '@/app/api/patients/route'
import { GET as getPatient } from '@/app/api/patients/[anonId]/route'
import { GET as getCcda } from '@/app/api/patients/[anonId]/ccda/route'
import { GET as getFhirAllergyIntolerance } from '@/app/api/patients/[anonId]/fhir/AllergyIntolerance/route'
import { GET as getFhirBundle } from '@/app/api/patients/[anonId]/fhir/Bundle/route'
import { GET as getFhirCondition } from '@/app/api/patients/[anonId]/fhir/Condition/route'
import { GET as getFhirMedicationDispense } from '@/app/api/patients/[anonId]/fhir/MedicationDispense/route'
import { GET as getFhirMedicationRequest } from '@/app/api/patients/[anonId]/fhir/MedicationRequest/route'
import { GET as getFhirObservation } from '@/app/api/patients/[anonId]/fhir/Observation/route'
import { GET as getFhirPatient } from '@/app/api/patients/[anonId]/fhir/Patient/route'
import { PUT as putIdentity } from '@/app/api/patients/[anonId]/identity/route'
import { PATCH as patchProfile } from '@/app/api/patients/[anonId]/profile/route'
import { PUT as putContacts } from '@/app/api/patients/[anonId]/contacts/route'
import { PUT as putAadhaar } from '@/app/api/patients/[anonId]/aadhaar/route'
import { GET as getPrimaryPayer } from '@/app/api/patients/[anonId]/primary-payer/route'
import { GET as getInsuranceCardSide } from '@/app/api/patients/[anonId]/insurance-card/[side]/route'
import { POST as resolveDiscrepancy } from '@/app/api/discrepancies/[id]/resolve/route'
import { GET as listAdmissionMedications } from '@/app/api/inpatient/admissions/[id]/medications/route'
import { GET as downloadDocument } from '@/app/api/documents/[id]/download/route'
import { GET as listTrials } from '@/app/api/trials/route'
import { PUT as putTrialCriteria } from '@/app/api/trials/[trialId]/criteria/route'
import { GET as listFormSubmissions, POST as postFormSubmission } from '@/app/api/form-submissions/route'
import { GET as getFormSubmission, PUT as putFormSubmission } from '@/app/api/form-submissions/[id]/route'
import { GET as listFormTemplates, POST as postFormTemplate } from '@/app/api/form-templates/route'
import { GET as getFormTemplate, PUT as putFormTemplate } from '@/app/api/form-templates/[id]/route'
import { GET as listAppointments, POST as postAppointment } from '@/app/api/appointments/route'
import { PUT as putAppointment } from '@/app/api/appointments/[id]/route'
import { GET as listCharges } from '@/app/api/charges/route'
import { GET as getCharge } from '@/app/api/charges/[id]/route'
import { GET as listStaff } from '@/app/api/staff/route'
import { GET as getStaffMember } from '@/app/api/staff/[id]/route'
import { GET as listDepartmentsRoute, POST as postDepartment } from '@/app/api/departments/route'
import { PATCH as patchDepartment } from '@/app/api/departments/[id]/route'
import { PUT as putProvider } from '@/app/api/providers/[id]/route'
import { GET as search } from '@/app/api/search/route'
import { GET as patientLookup } from '@/app/api/patients/lookup/route' // Wave C
import { PATCH as patchDemographics } from '@/app/api/patients/[anonId]/demographics/route' // Wave C
import { GET as listTariffServices, POST as postTariffService } from '@/app/api/tariff/services/route'
import { PATCH as patchTariffService } from '@/app/api/tariff/services/[id]/route'
import { GET as listRoomCategoriesRoute, POST as postRoomCategory } from '@/app/api/tariff/room-categories/route'
import { PATCH as patchRoomCategory } from '@/app/api/tariff/room-categories/[id]/route'
import { PUT as putRoomCategory } from '@/app/api/tariff/rooms/[id]/category/route'
import { POST as postTariffRate } from '@/app/api/tariff/rates/route'
import { PATCH as patchTariffRate } from '@/app/api/tariff/rates/[id]/route'
import { POST as reviseTariffRate } from '@/app/api/tariff/rates/[id]/revise/route'
import { PUT as putPackageItems } from '@/app/api/tariff/packages/[id]/items/route'
import { GET as resolveTariff } from '@/app/api/tariff/resolve/route'
import { POST as postTariffImport } from '@/app/api/tariff/import/route'
// SP3
import { POST as postCheckIn } from '@/app/api/front-desk/check-in/route'
import { POST as postEncounterStatus } from '@/app/api/encounters/[id]/status/route'
import { POST as postFollowUp } from '@/app/api/follow-ups/route'
import { PATCH as patchFollowUp } from '@/app/api/follow-ups/[id]/route'
import { POST as cancelFollowUp } from '@/app/api/follow-ups/[id]/cancel/route'
import { PUT as putFollowUpBooking } from '@/app/api/follow-ups/[id]/booking/route'
import { POST as unbookFollowUp } from '@/app/api/follow-ups/[id]/unbook/route'
import { POST as postFollowUpContact } from '@/app/api/follow-ups/[id]/contact-attempts/route'
import { POST as postDischarge } from '@/app/api/inpatient/admissions/[id]/discharge/route'
// SP4
import { PUT as putBillingSettings } from '@/app/api/billing/settings/route'
import { PUT as putBillingRule } from '@/app/api/billing/rules/[code]/route'
import { PUT as putPayerFlags } from '@/app/api/billing/payers/[id]/route'
import { POST as postChargeLine } from '@/app/api/billing/charge-lines/route'
import { POST as previewChargeLineRoute } from '@/app/api/billing/charge-lines/preview/route'
import { POST as voidChargeLineRoute } from '@/app/api/billing/charge-lines/[id]/void/route'
import { POST as postRoomRentRoute } from '@/app/api/billing/admissions/[id]/room-rent/route'
import { POST as postDraftInvoice } from '@/app/api/billing/invoices/route'
import { POST as finaliseInvoiceRoute } from '@/app/api/billing/invoices/[id]/finalise/route'
import { POST as discardInvoiceRoute } from '@/app/api/billing/invoices/[id]/discard/route'
import { POST as cancelInvoiceRoute } from '@/app/api/billing/invoices/[id]/cancel/route'
import { POST as postPaymentRoute } from '@/app/api/billing/payments/route'
import { POST as postRefundRoute } from '@/app/api/billing/refunds/route'
// end SP4
// SP5
import { LAB_SETUP_ROLES, NOTIFICATION_PREFERENCE_ROLES } from '@/lib/role-policy'
import { LAB_ORDER_ROLES } from '@/lib/role-policy'
import { POST as postLabRequisition } from '@/app/api/patients/[anonId]/lab-orders/route'
import { POST as postLabServiceArea } from '@/app/api/settings/lab-service-area/route'
import { PATCH as patchLabServiceArea } from '@/app/api/settings/lab-service-area/[id]/route'
import { POST as postCollectionWindow } from '@/app/api/settings/home-collection-windows/route'
import { PATCH as patchCollectionWindow } from '@/app/api/settings/home-collection-windows/[id]/route'
import { PATCH as patchLabTestSetup } from '@/app/api/lab-tests/[id]/route'
import { PUT as putNotificationPreference } from '@/app/api/patients/[anonId]/notification-preference/route'
import { LAB_COLLECT_ROLES, LAB_RECEIVE_ROLES, LAB_RESULT_ENTRY_ROLES, LAB_VERIFY_ROLES, LAB_WORKLIST_ROLES } from '@/lib/role-policy'
import { GET as listLabWorklist } from '@/app/api/lab-orders/route'
import { POST as postLabCollect } from '@/app/api/lab-orders/[id]/collect/route'
import { POST as postLabReceive } from '@/app/api/lab-orders/receive/route'
import { POST as postLabResult } from '@/app/api/lab-orders/[id]/result/route'
import { POST as postLabVerify } from '@/app/api/lab-orders/[id]/verify/route'
import { POST as postLabCancel } from '@/app/api/lab-orders/[id]/cancel/route'
import { POST as postLabImaging } from '@/app/api/lab-orders/[id]/imaging/route'
import { HOME_COLLECTION_BOOKING_ROLES, HOME_COLLECTION_CANCEL_ROLES, HOME_COLLECTION_DISPATCH_ROLES } from '@/lib/role-policy'
import { POST as postHomeCollection } from '@/app/api/home-collections/route'
import { GET as getHomeCollectionContextRoute } from '@/app/api/home-collections/context/route'
import { GET as getHomeCollectionAvailability } from '@/app/api/home-collections/availability/route'
import { PATCH as patchHomeCollection } from '@/app/api/home-collections/[id]/route'
import { POST as cancelHomeCollectionRoute } from '@/app/api/home-collections/[id]/cancel/route'
import { PUT as putHomeCollectionCollector } from '@/app/api/home-collections/[id]/collector/route'
import { COLLECTOR_ROUTE_ROLES } from '@/lib/role-policy'
import { POST as collectHomeCollectionRoute } from '@/app/api/home-collections/[id]/collect/route'
import { LAB_REPORT_READ_ROLES, LAB_REPORT_RELEASE_ROLES } from '@/lib/role-policy'
import { POST as releaseLabReportRoute } from '@/app/api/lab-requisitions/[id]/report/route'
import { GET as downloadLabReport } from '@/app/api/lab-reports/[id]/download/route'
// end SP5
// SP6: the clinical-note write routes (the coder must never write or sign a note)
import { POST as postNote } from '@/app/api/patients/[anonId]/notes/route'
import { PUT as signNoteRoute } from '@/app/api/patients/[anonId]/notes/[id]/sign/route'
// end SP6
// SP6: code systems and code search
import { CODE_LOOKUP_ROLES, CODE_SYSTEM_ADMIN_ROLES, CODING_ROLES } from '@/lib/role-policy'
import { GET as getCodes } from '@/app/api/coding/codes/route'
import { GET as listCodeSystemsRoute } from '@/app/api/coding/code-systems/route'
import { POST as postCodeImport } from '@/app/api/coding/code-systems/import/route'
import { PATCH as patchCodeSystem } from '@/app/api/coding/code-systems/[id]/route'
// end SP6
// SP6: encounter coding entries, status actions and coding queries
import { CODING_ENTRY_ROLES, CODING_QUERY_RESPOND_ROLES } from '@/lib/role-policy'
import { POST as postCodingDx } from '@/app/api/coding/encounters/[id]/diagnoses/route'
import { PATCH as patchCodingDx, DELETE as deleteCodingDx } from '@/app/api/coding/encounters/[id]/diagnoses/[diagnosisId]/route'
import { POST as postCodingProc } from '@/app/api/coding/encounters/[id]/procedures/route'
import { PATCH as patchCodingProc, DELETE as deleteCodingProc } from '@/app/api/coding/encounters/[id]/procedures/[procedureId]/route'
import { POST as postCodingStatus } from '@/app/api/coding/encounters/[id]/status/route'
import { POST as postCodingQuery } from '@/app/api/coding/encounters/[id]/queries/route'
import { PATCH as patchCodingQuery } from '@/app/api/coding/queries/[queryId]/route'
import { POST as postCodingQueryResponse } from '@/app/api/coding/queries/[queryId]/responses/route'
// end SP6
// SP6: service <-> procedure-code map
import { GET as getServiceCodes, PUT as putServiceCodes } from '@/app/api/coding/services/[serviceId]/procedure-codes/route'
// end SP6
// SP6: FHIR Procedure and Encounter exports
import { GET as getFhirProcedure } from '@/app/api/patients/[anonId]/fhir/Procedure/route'
import { GET as getFhirEncounter } from '@/app/api/patients/[anonId]/fhir/Encounter/route'
// end SP6

export type ApiGateCase = { name: string; call: () => Promise<Response>; allowed: Role[]; gap?: string }

const BOGUS_ID = '2147483000'
const BOGUS_PATIENT = 'RD-ZZZZ'
const url = (path: string) => `http://localhost${path}`
const get = (path: string) => new NextRequest(url(path))
const send = (method: 'POST' | 'PUT' | 'PATCH', path: string, body: unknown = {}) =>
  new NextRequest(url(path), { method, body: typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) })
const del = (path: string) => new NextRequest(url(path), { method: 'DELETE' }) // SP6

// A handler that THROWS after the gate (e.g. drizzle rejecting an empty
// `.set({})` for an allowed role's `{}` body) still proves the gate let that
// role through; it is reported as a 500, which a denied role can never pass.
async function settle(fn: () => Promise<Response>): Promise<Response> {
  try { return await fn() } catch { return new Response(null, { status: 500 }) }
}

const fhir = (resource: string, handler: typeof getFhirPatient): ApiGateCase => ({
  name: `GET /api/patients/[anonId]/fhir/${resource}`,
  call: () => handler(get(`/api/patients/${BOGUS_PATIENT}/fhir/${resource}`), ctx({ anonId: BOGUS_PATIENT })),
  allowed: [...CLINICAL_ROLES],
})

export const API_GATES: ApiGateCase[] = [
  // POLICY.md: patient JSON APIs -- CLINICAL_ROLES (ruling 1: frontdesk denied)
  { name: 'GET /api/patients', call: () => listPatients(get('/api/patients')), allowed: [...CLINICAL_ROLES] },
  // REGISTRATION_ROLES -- admin/frontdesk only (route.ts comment: crc removed by product direction)
  { name: 'POST /api/patients', call: () => settle(() => postPatient(send('POST', '/api/patients'))), allowed: [...REGISTRATION_ROLES] },
  {
    name: 'GET /api/patients/[anonId]',
    call: () => getPatient(get(`/api/patients/${BOGUS_PATIENT}`), ctx({ anonId: BOGUS_PATIENT })),
    allowed: [...CLINICAL_ROLES],
  },
  // POLICY.md: FHIR/C-CDA -- CLINICAL_ROLES (no frontdesk)
  {
    name: 'GET /api/patients/[anonId]/ccda',
    call: () => getCcda(get(`/api/patients/${BOGUS_PATIENT}/ccda`), ctx({ anonId: BOGUS_PATIENT })),
    allowed: [...CLINICAL_ROLES],
    },
  fhir('AllergyIntolerance', getFhirAllergyIntolerance),
  fhir('Bundle', getFhirBundle),
  fhir('Condition', getFhirCondition),
  fhir('MedicationDispense', getFhirMedicationDispense),
  fhir('MedicationRequest', getFhirMedicationRequest),
  fhir('Observation', getFhirObservation),
  fhir('Patient', getFhirPatient),
  // SP6: same CLINICAL_ROLES gate as the other FHIR exports (the coder is denied)
  fhir('Procedure', getFhirProcedure),
  fhir('Encounter', getFhirEncounter),
  // end SP6
  // POLICY.md: Identity PUT -- admin, crc, frontdesk
  {
    name: 'PUT /api/patients/[anonId]/identity',
    call: () => putIdentity(send('PUT', `/api/patients/${BOGUS_PATIENT}/identity`), ctx({ anonId: BOGUS_PATIENT })),
    allowed: [...IDENTITY_VERIFY_ROLES],
    },
  // SP1 patient master updates: profile + contacts -- PATIENT_PROFILE_EDIT_ROLES;
  // Aadhaar -- AADHAAR_WRITE_ROLES (crc's only Aadhaar write path). An allowed
  // role's `{}` body fails validation before any query.
  { name: 'PATCH /api/patients/[anonId]/profile', call: () => settle(() => patchProfile(send('PATCH', `/api/patients/${BOGUS_PATIENT}/profile`), ctx({ anonId: BOGUS_PATIENT }))), allowed: [...PATIENT_PROFILE_EDIT_ROLES] },
  { name: 'PUT /api/patients/[anonId]/contacts', call: () => settle(() => putContacts(send('PUT', `/api/patients/${BOGUS_PATIENT}/contacts`), ctx({ anonId: BOGUS_PATIENT }))), allowed: [...PATIENT_PROFILE_EDIT_ROLES] },
  { name: 'PUT /api/patients/[anonId]/aadhaar', call: () => settle(() => putAadhaar(send('PUT', `/api/patients/${BOGUS_PATIENT}/aadhaar`), ctx({ anonId: BOGUS_PATIENT }))), allowed: [...AADHAAR_WRITE_ROLES] },
  // Controller ruling (Task 3, option b): billing's eligibility modal reads
  // only the primary payer id -- admin, crc, billing.
  {
    name: 'GET /api/patients/[anonId]/primary-payer',
    call: () => getPrimaryPayer(get(`/api/patients/${BOGUS_PATIENT}/primary-payer`), ctx({ anonId: BOGUS_PATIENT })),
    allowed: [...PAYER_LOOKUP_ROLES],
  },
  // POLICY.md: insurance-card images -- admin, crc, pi, frontdesk, billing
  {
    name: 'GET /api/patients/[anonId]/insurance-card/[side]',
    call: () => getInsuranceCardSide(get(`/api/patients/${BOGUS_PATIENT}/insurance-card/front`), ctx({ anonId: BOGUS_PATIENT, side: 'front' })),
    allowed: [...INSURANCE_CARD_READ_ROLES],
    },
  {
    name: 'GET /api/patients/[anonId]/insurance-card/[side] (back)',
    call: () => getInsuranceCardSide(get(`/api/patients/${BOGUS_PATIENT}/insurance-card/back`), ctx({ anonId: BOGUS_PATIENT, side: 'back' })),
    allowed: [...INSURANCE_CARD_READ_ROLES],
    },
  // POLICY.md: discrepancy resolve -- admin, crc, pi
  {
    name: 'POST /api/discrepancies/[id]/resolve',
    call: () => resolveDiscrepancy(send('POST', `/api/discrepancies/${BOGUS_ID}/resolve`), ctx({ id: BOGUS_ID })),
    allowed: [...CLINICAL_ROLES],
    },
  // Controller ruling 7: MAR read is clinical -- admin, crc, pi (no frontdesk)
  {
    name: 'GET /api/inpatient/admissions/[id]/medications',
    call: () => listAdmissionMedications(get(`/api/inpatient/admissions/${BOGUS_ID}/medications`), ctx({ id: BOGUS_ID })),
    allowed: [...CLINICAL_ROLES],
    },
  // POLICY.md: documents -- DOCUMENT_READ_ROLES, plus labs for lab-order
  // documents only (ruling 4). The bogus id has no labOrderId, so labs is
  // listed as allowed here only because the role gate itself admits labs;
  // the lab-document rule is tested in documents-download.test.ts.
  {
    name: 'GET /api/documents/[id]/download',
    call: () => downloadDocument(get(`/api/documents/${BOGUS_ID}/download`), ctx({ id: BOGUS_ID })),
    allowed: [...DOCUMENT_READ_ROLES, 'labs'],
  },
  // POLICY.md: trials -- crc, pi, admin (ruling 6: GET /api/trials too)
  { name: 'GET /api/trials', call: () => listTrials(get('/api/trials')), allowed: [...CLINICAL_ROLES] },
  // POLICY.md: criteria PUT -- pi, admin only
  {
    name: 'PUT /api/trials/[trialId]/criteria',
    call: () => settle(() => putTrialCriteria(send('PUT', '/api/trials/probe-no-trial/criteria'), ctx({ trialId: 'probe-no-trial' }))),
    allowed: [...TRIAL_CRITERIA_EDIT_ROLES],
  },
  // POLICY.md: client forms / form-submissions -- crc, pi, admin
  { name: 'GET /api/form-submissions', call: () => listFormSubmissions(get('/api/form-submissions')), allowed: [...CLINICAL_ROLES] },
  { name: 'POST /api/form-submissions', call: () => postFormSubmission(send('POST', '/api/form-submissions')), allowed: [...CLINICAL_ROLES] },
  {
    name: 'GET /api/form-submissions/[id]',
    call: () => getFormSubmission(get(`/api/form-submissions/${BOGUS_ID}`), ctx({ id: BOGUS_ID })),
    allowed: [...CLINICAL_ROLES],
  },
  {
    name: 'PUT /api/form-submissions/[id]',
    call: () => putFormSubmission(send('PUT', `/api/form-submissions/${BOGUS_ID}`), ctx({ id: BOGUS_ID })),
    allowed: [...CLINICAL_ROLES],
  },
  // POLICY.md: form templates API -- admin, crc, pi (match the page gate)
  { name: 'GET /api/form-templates', call: () => listFormTemplates(), allowed: [...CLINICAL_ROLES] },
  { name: 'POST /api/form-templates', call: () => postFormTemplate(send('POST', '/api/form-templates')), allowed: [...CLINICAL_ROLES] },
  {
    name: 'GET /api/form-templates/[id]',
    call: () => getFormTemplate(get(`/api/form-templates/${BOGUS_ID}`), ctx({ id: BOGUS_ID })),
    allowed: [...CLINICAL_ROLES],
  },
  {
    name: 'PUT /api/form-templates/[id]',
    call: () => settle(() => putFormTemplate(send('PUT', `/api/form-templates/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))),
    allowed: [...CLINICAL_ROLES],
  },
  // POLICY.md: appointments + calendar -- SCHEDULING_ROLES. GET without
  // from/to 400s for an allowed role before any query.
  { name: 'GET /api/appointments', call: () => listAppointments(get('/api/appointments')), allowed: [...SCHEDULING_ROLES] },
  { name: 'POST /api/appointments', call: () => postAppointment(send('POST', '/api/appointments')), allowed: [...SCHEDULING_ROLES] },
  {
    name: 'PUT /api/appointments/[id]',
    call: () => putAppointment(send('PUT', `/api/appointments/${BOGUS_ID}`), ctx({ id: BOGUS_ID })),
    allowed: [...SCHEDULING_ROLES],
  },
  // POLICY.md: charges -- admin, crc, billing (POST/PATCH already gated)
  { name: 'GET /api/charges', call: () => listCharges(), allowed: [...CHARGES_ROLES] },
  {
    name: 'GET /api/charges/[id]',
    call: () => getCharge(get(`/api/charges/${BOGUS_ID}`), ctx({ id: BOGUS_ID })),
    allowed: [...CHARGES_ROLES],
  },
  // Controller ruling (Task 8): staff directory GETs -- CLINICAL_ROLES (frontdesk denied).
  { name: 'GET /api/staff', call: () => listStaff(), allowed: [...CLINICAL_ROLES] },
  {
    name: 'GET /api/staff/[id]',
    call: () => getStaffMember(get(`/api/staff/${BOGUS_ID}`), ctx({ id: BOGUS_ID })),
    allowed: [...CLINICAL_ROLES],
  },
  // MASTER_DATA_ADMIN_ROLES -- UHID prefix is practice configuration
  { name: 'PUT /api/settings/uhid-prefix', call: () => settle(() => putUhidPrefix(send('PUT', '/api/settings/uhid-prefix'))), allowed: [...MASTER_DATA_ADMIN_ROLES] },
  // Departments master: any staff role reads; MASTER_DATA_ADMIN_ROLES writes
  { name: 'GET /api/departments', call: () => settle(() => listDepartmentsRoute(get('/api/departments'))), allowed: [...ALL_ROLES] },
  { name: 'POST /api/departments', call: () => settle(() => postDepartment(send('POST', '/api/departments'))), allowed: [...MASTER_DATA_ADMIN_ROLES] },
  { name: 'PATCH /api/departments/[id]', call: () => settle(() => patchDepartment(send('PATCH', `/api/departments/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...MASTER_DATA_ADMIN_ROLES] },
  // Provider profile (NMC/SMC, fee, department): MASTER_DATA_ADMIN_ROLES
  { name: 'PUT /api/providers/[id]', call: () => settle(() => putProvider(send('PUT', `/api/providers/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...MASTER_DATA_ADMIN_ROLES] },
  // SP2 tariff master: TARIFF_LOOKUP_ROLES read the service search and room
  // categories; every write is TARIFF_MANAGE_ROLES.
  { name: 'GET /api/tariff/services', call: () => settle(() => listTariffServices(get('/api/tariff/services'))), allowed: [...TARIFF_LOOKUP_ROLES] },
  { name: 'POST /api/tariff/services', call: () => settle(() => postTariffService(send('POST', '/api/tariff/services'))), allowed: [...TARIFF_MANAGE_ROLES] },
  { name: 'PATCH /api/tariff/services/[id]', call: () => settle(() => patchTariffService(send('PATCH', `/api/tariff/services/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...TARIFF_MANAGE_ROLES] },
  { name: 'GET /api/tariff/room-categories', call: () => settle(() => listRoomCategoriesRoute(get('/api/tariff/room-categories'))), allowed: [...TARIFF_LOOKUP_ROLES] },
  { name: 'POST /api/tariff/room-categories', call: () => settle(() => postRoomCategory(send('POST', '/api/tariff/room-categories'))), allowed: [...TARIFF_MANAGE_ROLES] },
  { name: 'PATCH /api/tariff/room-categories/[id]', call: () => settle(() => patchRoomCategory(send('PATCH', `/api/tariff/room-categories/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...TARIFF_MANAGE_ROLES] },
  { name: 'PUT /api/tariff/rooms/[id]/category', call: () => settle(() => putRoomCategory(send('PUT', `/api/tariff/rooms/${BOGUS_ID}/category`), ctx({ id: BOGUS_ID }))), allowed: [...TARIFF_MANAGE_ROLES] },
  { name: 'POST /api/tariff/rates', call: () => settle(() => postTariffRate(send('POST', '/api/tariff/rates'))), allowed: [...TARIFF_MANAGE_ROLES] },
  { name: 'POST /api/tariff/rates/[id]/revise', call: () => settle(() => reviseTariffRate(send('POST', `/api/tariff/rates/${BOGUS_ID}/revise`), ctx({ id: BOGUS_ID }))), allowed: [...TARIFF_MANAGE_ROLES] },
  { name: 'PATCH /api/tariff/rates/[id]', call: () => settle(() => patchTariffRate(send('PATCH', `/api/tariff/rates/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...TARIFF_MANAGE_ROLES] },
  { name: 'PUT /api/tariff/packages/[id]/items', call: () => settle(() => putPackageItems(send('PUT', `/api/tariff/packages/${BOGUS_ID}/items`), ctx({ id: BOGUS_ID }))), allowed: [...TARIFF_MANAGE_ROLES] },
  { name: 'GET /api/tariff/resolve', call: () => settle(() => resolveTariff(get('/api/tariff/resolve'))), allowed: [...TARIFF_LOOKUP_ROLES] },
  { name: 'POST /api/tariff/import', call: () => settle(() => postTariffImport(send('POST', '/api/tariff/import'))), allowed: [...TARIFF_MANAGE_ROLES] },
  // SP3: check-in opens an encounter (CHECK_IN_ROLES); the visit status route is
  // ENCOUNTER_STATUS_ROLES (per-transition roles are tested in encounter-status.test.ts).
  // An allowed role's `{}` body fails validation before any query.
  { name: 'POST /api/front-desk/check-in', call: () => settle(() => postCheckIn(send('POST', '/api/front-desk/check-in'))), allowed: [...CHECK_IN_ROLES] },
  { name: 'POST /api/encounters/[id]/status', call: () => settle(() => postEncounterStatus(send('POST', `/api/encounters/${BOGUS_ID}/status`), ctx({ id: BOGUS_ID }))), allowed: [...ENCOUNTER_STATUS_ROLES] },
  // SP3 follow-up plan (FOLLOW_UP_PLAN_ROLES): an allowed role's `{}` body fails validation before any query.
  { name: 'POST /api/follow-ups', call: () => settle(() => postFollowUp(send('POST', '/api/follow-ups'))), allowed: [...FOLLOW_UP_PLAN_ROLES] },
  { name: 'PATCH /api/follow-ups/[id]', call: () => settle(() => patchFollowUp(send('PATCH', `/api/follow-ups/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...FOLLOW_UP_PLAN_ROLES] },
  { name: 'POST /api/follow-ups/[id]/cancel', call: () => settle(() => cancelFollowUp(send('POST', `/api/follow-ups/${BOGUS_ID}/cancel`), ctx({ id: BOGUS_ID }))), allowed: [...FOLLOW_UP_PLAN_ROLES] },
  // SP3 follow-up booking and recall (FOLLOW_UP_BOOKING_ROLES): `{}` fails validation before any query.
  { name: 'PUT /api/follow-ups/[id]/booking', call: () => settle(() => putFollowUpBooking(send('PUT', `/api/follow-ups/${BOGUS_ID}/booking`), ctx({ id: BOGUS_ID }))), allowed: [...FOLLOW_UP_BOOKING_ROLES] },
  { name: 'POST /api/follow-ups/[id]/unbook', call: () => settle(() => unbookFollowUp(send('POST', `/api/follow-ups/${BOGUS_ID}/unbook`), ctx({ id: BOGUS_ID }))), allowed: [...FOLLOW_UP_BOOKING_ROLES] },
  { name: 'POST /api/follow-ups/[id]/contact-attempts', call: () => settle(() => postFollowUpContact(send('POST', `/api/follow-ups/${BOGUS_ID}/contact-attempts`), ctx({ id: BOGUS_ID }))), allowed: [...FOLLOW_UP_BOOKING_ROLES] },
  // SP3 discharge (DISCHARGE_ROLES): `{}` fails validation before any query.
  { name: 'POST /api/inpatient/admissions/[id]/discharge', call: () => settle(() => postDischarge(send('POST', `/api/inpatient/admissions/${BOGUS_ID}/discharge`), ctx({ id: BOGUS_ID }))), allowed: [...DISCHARGE_ROLES] },
  // SP4 billing configuration (BILLING_CONFIG_ROLES): `{}` fails validation before any query.
  { name: 'PUT /api/billing/settings', call: () => settle(() => putBillingSettings(send('PUT', '/api/billing/settings'))), allowed: [...BILLING_CONFIG_ROLES] },
  { name: 'PUT /api/billing/rules/[code]', call: () => settle(() => putBillingRule(send('PUT', '/api/billing/rules/duplicate_charge'), ctx({ code: 'duplicate_charge' }))), allowed: [...BILLING_CONFIG_ROLES] },
  { name: 'PUT /api/billing/payers/[id]', call: () => settle(() => putPayerFlags(send('PUT', `/api/billing/payers/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...BILLING_CONFIG_ROLES] },
  // SP4 charge lines (CHARGE_CAPTURE_ROLES): `{}` fails validation before any query.
  { name: 'POST /api/billing/charge-lines', call: () => settle(() => postChargeLine(send('POST', '/api/billing/charge-lines'))), allowed: [...CHARGE_CAPTURE_ROLES] },
  { name: 'POST /api/billing/charge-lines/preview', call: () => settle(() => previewChargeLineRoute(send('POST', '/api/billing/charge-lines/preview'))), allowed: [...CHARGE_CAPTURE_ROLES] },
  { name: 'POST /api/billing/charge-lines/[id]/void', call: () => settle(() => voidChargeLineRoute(send('POST', `/api/billing/charge-lines/${BOGUS_ID}/void`), ctx({ id: BOGUS_ID }))), allowed: [...CHARGE_CAPTURE_ROLES] },
  // SP4 room rent (CHARGE_CAPTURE_ROLES): the bogus admission is a 404 for an allowed role.
  { name: 'POST /api/billing/admissions/[id]/room-rent', call: () => settle(() => postRoomRentRoute(send('POST', `/api/billing/admissions/${BOGUS_ID}/room-rent`), ctx({ id: BOGUS_ID }))), allowed: [...CHARGE_CAPTURE_ROLES] },
  // SP4 invoices: drafts and discards for CHARGE_CAPTURE_ROLES, finalise and cancel for BILLING_AUTHORITY_ROLES (bogus ids are 404s).
  { name: 'POST /api/billing/invoices', call: () => settle(() => postDraftInvoice(send('POST', '/api/billing/invoices'))), allowed: [...CHARGE_CAPTURE_ROLES] },
  { name: 'POST /api/billing/invoices/[id]/discard', call: () => settle(() => discardInvoiceRoute(send('POST', `/api/billing/invoices/${BOGUS_ID}/discard`), ctx({ id: BOGUS_ID }))), allowed: [...CHARGE_CAPTURE_ROLES] },
  { name: 'POST /api/billing/invoices/[id]/finalise', call: () => settle(() => finaliseInvoiceRoute(send('POST', `/api/billing/invoices/${BOGUS_ID}/finalise`), ctx({ id: BOGUS_ID }))), allowed: [...BILLING_AUTHORITY_ROLES] },
  { name: 'POST /api/billing/invoices/[id]/cancel', call: () => settle(() => cancelInvoiceRoute(send('POST', `/api/billing/invoices/${BOGUS_ID}/cancel`), ctx({ id: BOGUS_ID }))), allowed: [...BILLING_AUTHORITY_ROLES] },
  // SP4 cash desk: receipts for CASH_DESK_ROLES, refunds for BILLING_AUTHORITY_ROLES (`{}` fails validation).
  { name: 'POST /api/billing/payments', call: () => settle(() => postPaymentRoute(send('POST', '/api/billing/payments'))), allowed: [...CASH_DESK_ROLES] },
  { name: 'POST /api/billing/refunds', call: () => settle(() => postRefundRoute(send('POST', '/api/billing/refunds'))), allowed: [...BILLING_AUTHORITY_ROLES] },
  // end SP4
  // SP5 lab setup (LAB_SETUP_ROLES): an allowed role's `{}` body fails validation before any query.
  { name: 'POST /api/settings/lab-service-area', call: () => settle(() => postLabServiceArea(send('POST', '/api/settings/lab-service-area'))), allowed: [...LAB_SETUP_ROLES] },
  { name: 'PATCH /api/settings/lab-service-area/[id]', call: () => settle(() => patchLabServiceArea(send('PATCH', `/api/settings/lab-service-area/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...LAB_SETUP_ROLES] },
  { name: 'POST /api/settings/home-collection-windows', call: () => settle(() => postCollectionWindow(send('POST', '/api/settings/home-collection-windows'))), allowed: [...LAB_SETUP_ROLES] },
  { name: 'PATCH /api/settings/home-collection-windows/[id]', call: () => settle(() => patchCollectionWindow(send('PATCH', `/api/settings/home-collection-windows/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...LAB_SETUP_ROLES] },
  { name: 'PATCH /api/lab-tests/[id]', call: () => settle(() => patchLabTestSetup(send('PATCH', `/api/lab-tests/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...LAB_SETUP_ROLES] },
  // SP5 notification opt-out (NOTIFICATION_PREFERENCE_ROLES): `{}` fails validation before any query.
  { name: 'PUT /api/patients/[anonId]/notification-preference', call: () => settle(() => putNotificationPreference(send('PUT', `/api/patients/${BOGUS_PATIENT}/notification-preference`), ctx({ anonId: BOGUS_PATIENT }))), allowed: [...NOTIFICATION_PREFERENCE_ROLES] },
  // SP5 doctor's order (LAB_ORDER_ROLES): `{}` fails validation before any query.
  { name: 'POST /api/patients/[anonId]/lab-orders', call: () => settle(() => postLabRequisition(send('POST', `/api/patients/${BOGUS_PATIENT}/lab-orders`), ctx({ anonId: BOGUS_PATIENT }))), allowed: [...LAB_ORDER_ROLES] },
  // SP5 lab lifecycle (Task 8): the bogus id is not found / `{}` fails validation for an allowed role.
  { name: 'GET /api/lab-orders', call: () => settle(() => listLabWorklist()), allowed: [...LAB_WORKLIST_ROLES] },
  { name: 'POST /api/lab-orders/[id]/collect', call: () => settle(() => postLabCollect(send('POST', `/api/lab-orders/${BOGUS_ID}/collect`), ctx({ id: BOGUS_ID }))), allowed: [...LAB_COLLECT_ROLES] },
  { name: 'POST /api/lab-orders/receive', call: () => settle(() => postLabReceive(send('POST', '/api/lab-orders/receive'))), allowed: [...LAB_RECEIVE_ROLES] },
  { name: 'POST /api/lab-orders/[id]/result', call: () => settle(() => postLabResult(send('POST', `/api/lab-orders/${BOGUS_ID}/result`), ctx({ id: BOGUS_ID }))), allowed: [...LAB_RESULT_ENTRY_ROLES] },
  { name: 'POST /api/lab-orders/[id]/verify', call: () => settle(() => postLabVerify(send('POST', `/api/lab-orders/${BOGUS_ID}/verify`), ctx({ id: BOGUS_ID }))), allowed: [...LAB_VERIFY_ROLES] },
  { name: 'POST /api/lab-orders/[id]/cancel', call: () => settle(() => postLabCancel(send('POST', `/api/lab-orders/${BOGUS_ID}/cancel`), ctx({ id: BOGUS_ID }))), allowed: [...LAB_ORDER_ROLES] },
  { name: 'POST /api/lab-orders/[id]/imaging', call: () => settle(() => postLabImaging(send('POST', `/api/lab-orders/${BOGUS_ID}/imaging`), ctx({ id: BOGUS_ID }))), allowed: [...LAB_COLLECT_ROLES] },
  // SP5 home collection (Task 11): no ?patient / ?date and `{}` bodies fail validation before any query.
  { name: 'GET /api/home-collections/context', call: () => settle(() => getHomeCollectionContextRoute(get('/api/home-collections/context'))), allowed: [...HOME_COLLECTION_BOOKING_ROLES] },
  { name: 'GET /api/home-collections/availability', call: () => settle(() => getHomeCollectionAvailability(get('/api/home-collections/availability'))), allowed: [...HOME_COLLECTION_BOOKING_ROLES] },
  { name: 'POST /api/home-collections', call: () => settle(() => postHomeCollection(send('POST', '/api/home-collections'))), allowed: [...HOME_COLLECTION_BOOKING_ROLES] },
  { name: 'PATCH /api/home-collections/[id]', call: () => settle(() => patchHomeCollection(send('PATCH', `/api/home-collections/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...HOME_COLLECTION_BOOKING_ROLES] },
  { name: 'POST /api/home-collections/[id]/cancel', call: () => settle(() => cancelHomeCollectionRoute(send('POST', `/api/home-collections/${BOGUS_ID}/cancel`), ctx({ id: BOGUS_ID }))), allowed: [...HOME_COLLECTION_CANCEL_ROLES] },
  { name: 'PUT /api/home-collections/[id]/collector', call: () => settle(() => putHomeCollectionCollector(send('PUT', `/api/home-collections/${BOGUS_ID}/collector`), ctx({ id: BOGUS_ID }))), allowed: [...HOME_COLLECTION_DISPATCH_ROLES] },
  // SP5 collector route (Task 12): `{}` fails validation before any query.
  { name: 'POST /api/home-collections/[id]/collect', call: () => settle(() => collectHomeCollectionRoute(send('POST', `/api/home-collections/${BOGUS_ID}/collect`), ctx({ id: BOGUS_ID }))), allowed: [...COLLECTOR_ROUTE_ROLES] },
  // SP5 lab reports (Task 14): release has no body (the bogus requisition is not found); download 404s the bogus id.
  { name: 'POST /api/lab-requisitions/[id]/report', call: () => settle(() => releaseLabReportRoute(send('POST', `/api/lab-requisitions/${BOGUS_ID}/report`), ctx({ id: BOGUS_ID }))), allowed: [...LAB_REPORT_RELEASE_ROLES] },
  { name: 'GET /api/lab-reports/[id]/download', call: () => settle(() => downloadLabReport(get(`/api/lab-reports/${BOGUS_ID}/download`), ctx({ id: BOGUS_ID }))), allowed: [...LAB_REPORT_READ_ROLES] },
  // end SP5
  // SP6 (ruling 4): clinical notes are written and signed by pi/admin only -- the coder reads
  // signed notes in the coding workspace but is 403'd here. Inline allowlists in both routes.
  { name: 'POST /api/patients/[anonId]/notes', call: () => settle(() => postNote(send('POST', `/api/patients/${BOGUS_PATIENT}/notes`), ctx({ anonId: BOGUS_PATIENT }))), allowed: ['admin', 'pi'] },
  { name: 'PUT /api/patients/[anonId]/notes/[id]/sign', call: () => settle(() => signNoteRoute(send('PUT', `/api/patients/${BOGUS_PATIENT}/notes/${BOGUS_ID}/sign`), ctx({ anonId: BOGUS_PATIENT, id: BOGUS_ID }))), allowed: ['admin', 'pi'] },
  // end SP6
  // SP6 code systems: code search (no PHI) for CODE_LOOKUP_ROLES, the version list for CODING_ROLES,
  // import / set current for CODE_SYSTEM_ADMIN_ROLES. Allowed roles' bodies fail validation before any write.
  { name: 'GET /api/coding/codes', call: () => settle(() => getCodes(get('/api/coding/codes'))), allowed: [...CODE_LOOKUP_ROLES] },
  { name: 'GET /api/coding/code-systems', call: () => settle(() => listCodeSystemsRoute()), allowed: [...CODING_ROLES] },
  { name: 'POST /api/coding/code-systems/import', call: () => settle(() => postCodeImport(send('POST', '/api/coding/code-systems/import'))), allowed: [...CODE_SYSTEM_ADMIN_ROLES] },
  { name: 'PATCH /api/coding/code-systems/[id]', call: () => settle(() => patchCodeSystem(send('PATCH', `/api/coding/code-systems/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...CODE_SYSTEM_ADMIN_ROLES] },
  // end SP6
  // SP6 encounter coding: entry writes for CODING_ENTRY_ROLES (pi proposes, coder/admin code), status
  // actions and raise/close queries for CODING_ROLES, replies for CODING_QUERY_RESPOND_ROLES.
  { name: 'POST /api/coding/encounters/[id]/diagnoses', call: () => settle(() => postCodingDx(send('POST', `/api/coding/encounters/${BOGUS_ID}/diagnoses`), ctx({ id: BOGUS_ID }))), allowed: [...CODING_ENTRY_ROLES] },
  { name: 'PATCH /api/coding/encounters/[id]/diagnoses/[diagnosisId]', call: () => settle(() => patchCodingDx(send('PATCH', `/api/coding/encounters/${BOGUS_ID}/diagnoses/${BOGUS_ID}`), ctx({ id: BOGUS_ID, diagnosisId: BOGUS_ID }))), allowed: [...CODING_ENTRY_ROLES] },
  { name: 'DELETE /api/coding/encounters/[id]/diagnoses/[diagnosisId]', call: () => settle(() => deleteCodingDx(del(`/api/coding/encounters/${BOGUS_ID}/diagnoses/${BOGUS_ID}`), ctx({ id: BOGUS_ID, diagnosisId: BOGUS_ID }))), allowed: [...CODING_ENTRY_ROLES] },
  { name: 'POST /api/coding/encounters/[id]/procedures', call: () => settle(() => postCodingProc(send('POST', `/api/coding/encounters/${BOGUS_ID}/procedures`), ctx({ id: BOGUS_ID }))), allowed: [...CODING_ENTRY_ROLES] },
  { name: 'PATCH /api/coding/encounters/[id]/procedures/[procedureId]', call: () => settle(() => patchCodingProc(send('PATCH', `/api/coding/encounters/${BOGUS_ID}/procedures/${BOGUS_ID}`), ctx({ id: BOGUS_ID, procedureId: BOGUS_ID }))), allowed: [...CODING_ENTRY_ROLES] },
  { name: 'DELETE /api/coding/encounters/[id]/procedures/[procedureId]', call: () => settle(() => deleteCodingProc(del(`/api/coding/encounters/${BOGUS_ID}/procedures/${BOGUS_ID}`), ctx({ id: BOGUS_ID, procedureId: BOGUS_ID }))), allowed: [...CODING_ENTRY_ROLES] },
  { name: 'POST /api/coding/encounters/[id]/status', call: () => settle(() => postCodingStatus(send('POST', `/api/coding/encounters/${BOGUS_ID}/status`), ctx({ id: BOGUS_ID }))), allowed: [...CODING_ROLES] },
  { name: 'POST /api/coding/encounters/[id]/queries', call: () => settle(() => postCodingQuery(send('POST', `/api/coding/encounters/${BOGUS_ID}/queries`), ctx({ id: BOGUS_ID }))), allowed: [...CODING_ROLES] },
  { name: 'PATCH /api/coding/queries/[queryId]', call: () => settle(() => patchCodingQuery(send('PATCH', `/api/coding/queries/${BOGUS_ID}`), ctx({ queryId: BOGUS_ID }))), allowed: [...CODING_ROLES] },
  { name: 'POST /api/coding/queries/[queryId]/responses', call: () => settle(() => postCodingQueryResponse(send('POST', `/api/coding/queries/${BOGUS_ID}/responses`), ctx({ queryId: BOGUS_ID }))), allowed: [...CODING_QUERY_RESPOND_ROLES] },
  // end SP6
  // SP6 service <-> procedure-code map: lookup (no PHI) for CODE_LOOKUP_ROLES, replace for CODING_ROLES.
  // An allowed PUT's `{}` body fails validation before any write.
  { name: 'GET /api/coding/services/[serviceId]/procedure-codes', call: () => settle(() => getServiceCodes(get(`/api/coding/services/${BOGUS_ID}/procedure-codes`), ctx({ serviceId: BOGUS_ID }))), allowed: [...CODE_LOOKUP_ROLES] },
  { name: 'PUT /api/coding/services/[serviceId]/procedure-codes', call: () => settle(() => putServiceCodes(send('PUT', `/api/coding/services/${BOGUS_ID}/procedure-codes`), ctx({ serviceId: BOGUS_ID }))), allowed: [...CODING_ROLES] },
  // end SP6
  // POLICY.md: global search -- only roles with a search scope
  { name: 'GET /api/search', call: () => search(get('/api/search?q=')), allowed: ALL_ROLES.filter(hasSearchScope) },
  // Wave C P0-04: patient picker -- PATIENT_PICKER_ROLES (directory roles + pharmacy + billing; never labs)
  { name: 'GET /api/patients/lookup', call: () => patientLookup(get('/api/patients/lookup?q=')), allowed: [...PATIENT_PICKER_ROLES] },
  // Wave C P1-11: name/DOB correction -- DEMOGRAPHICS_CORRECTION_ROLES (admin); `{}` fails validation before any query.
  { name: 'PATCH /api/patients/[anonId]/demographics', call: () => settle(() => patchDemographics(send('PATCH', `/api/patients/${BOGUS_PATIENT}/demographics`), ctx({ anonId: BOGUS_PATIENT }))), allowed: [...DEMOGRAPHICS_CORRECTION_ROLES] },
  // SP7 insurer/TPA master (PAYER_MASTER_ROLES) and hospital identifiers (RCM_SETTINGS_ROLES): `{}` fails validation before any query.
  { name: 'POST /api/rcm/payers', call: () => settle(() => postRcmPayer(send('POST', '/api/rcm/payers'))), allowed: [...PAYER_MASTER_ROLES] },
  { name: 'PUT /api/rcm/payers/[id]', call: () => settle(() => putRcmPayer(send('PUT', `/api/rcm/payers/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...PAYER_MASTER_ROLES] },
  { name: 'PUT /api/rcm/payers/[id]/contacts', call: () => settle(() => putRcmPayerContacts(send('PUT', `/api/rcm/payers/${BOGUS_ID}/contacts`), ctx({ id: BOGUS_ID }))), allowed: [...PAYER_MASTER_ROLES] },
  { name: 'PUT /api/rcm/payers/[id]/networks', call: () => settle(() => putRcmPayerNetworks(send('PUT', `/api/rcm/payers/${BOGUS_ID}/networks`), ctx({ id: BOGUS_ID }))), allowed: [...PAYER_MASTER_ROLES] },
  { name: 'PUT /api/rcm/payers/[id]/requirements', call: () => settle(() => putRcmPayerRequirements(send('PUT', `/api/rcm/payers/${BOGUS_ID}/requirements`), ctx({ id: BOGUS_ID }))), allowed: [...PAYER_MASTER_ROLES] },
  { name: 'PUT /api/rcm/settings', call: () => settle(() => putRcmSettings(send('PUT', '/api/rcm/settings'))), allowed: [...RCM_SETTINGS_ROLES] },
  // SP7 patient policies (POLICY_WRITE_ROLES) and card images (POLICY_READ_ROLES): `{}` / a non-multipart body fails before any query.
  { name: 'POST /api/rcm/policies', call: () => settle(() => postRcmPolicy(send('POST', '/api/rcm/policies'))), allowed: [...POLICY_WRITE_ROLES] },
  { name: 'PATCH /api/rcm/policies/[id]', call: () => settle(() => patchRcmPolicy(send('PATCH', `/api/rcm/policies/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...POLICY_WRITE_ROLES] },
  { name: 'POST /api/rcm/policies/[id]/card', call: () => settle(() => postRcmPolicyCard(send('POST', `/api/rcm/policies/${BOGUS_ID}/card`), ctx({ id: BOGUS_ID }))), allowed: [...POLICY_WRITE_ROLES] },
  { name: 'GET /api/rcm/policies/[id]/card/[side]', call: () => settle(() => getRcmPolicyCard(get(`/api/rcm/policies/${BOGUS_ID}/card/front`), ctx({ id: BOGUS_ID, side: 'front' }))), allowed: [...POLICY_READ_ROLES] },
  // SP7 pre-auths (RCM_ROLES) and the charge-capture picker (PREAUTH_LOOKUP_ROLES).
  { name: 'POST /api/rcm/preauths', call: () => settle(() => postRcmPreauth(send('POST', '/api/rcm/preauths'))), allowed: [...RCM_ROLES] },
  { name: 'POST /api/rcm/preauths/estimate', call: () => settle(() => postRcmPreauthEstimate(send('POST', '/api/rcm/preauths/estimate'))), allowed: [...RCM_ROLES] },
  { name: 'POST /api/rcm/preauths/[id]/actions', call: () => settle(() => postRcmPreauthAction(send('POST', `/api/rcm/preauths/${BOGUS_ID}/actions`), ctx({ id: BOGUS_ID }))), allowed: [...RCM_ROLES] },
  { name: 'POST /api/rcm/preauths/[id]/documents', call: () => settle(() => postRcmPreauthDocument(send('POST', `/api/rcm/preauths/${BOGUS_ID}/documents`), ctx({ id: BOGUS_ID }))), allowed: [...RCM_ROLES] },
  { name: 'GET /api/rcm/preauth-documents/[id]', call: () => settle(() => getRcmPreauthDocument(get(`/api/rcm/preauth-documents/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...RCM_ROLES] },
  { name: 'GET /api/rcm/patients/[anonId]/approved-preauths', call: () => settle(() => getRcmApprovedPreauths(get(`/api/rcm/patients/${BOGUS_PATIENT}/approved-preauths?onDate=2026-10-01`), ctx({ anonId: BOGUS_PATIENT }))), allowed: [...PREAUTH_LOOKUP_ROLES] },
  // SP7 claims, documents, submissions, insurer updates, settlements and write-offs (RCM_ROLES; the write-off decision is WRITE_OFF_APPROVE_ROLES).
  { name: 'POST /api/rcm/claims', call: () => settle(() => postRcmClaim(send('POST', `/api/rcm/claims`))), allowed: [...RCM_ROLES] },
  { name: 'PUT /api/rcm/claims/[id]/invoices', call: () => settle(() => putRcmClaimInvoices(send('PUT', `/api/rcm/claims/${BOGUS_ID}/invoices`), ctx({ id: BOGUS_ID }))), allowed: [...RCM_ROLES] },
  { name: 'POST /api/rcm/claims/[id]/documents', call: () => settle(() => postRcmClaimDocument(send('POST', `/api/rcm/claims/${BOGUS_ID}/documents`), ctx({ id: BOGUS_ID }))), allowed: [...RCM_ROLES] },
  { name: 'POST /api/rcm/claims/[id]/documents/attach', call: () => settle(() => postRcmClaimAttach(send('POST', `/api/rcm/claims/${BOGUS_ID}/documents/attach`), ctx({ id: BOGUS_ID }))), allowed: [...RCM_ROLES] },
  { name: 'POST /api/rcm/claims/[id]/documents/waive', call: () => settle(() => postRcmClaimWaive(send('POST', `/api/rcm/claims/${BOGUS_ID}/documents/waive`), ctx({ id: BOGUS_ID }))), allowed: [...RCM_ROLES] },
  { name: 'DELETE /api/rcm/claims/[id]/documents/[docId]', call: () => settle(() => deleteRcmClaimDocument(del(`/api/rcm/claims/${BOGUS_ID}/documents/${BOGUS_ID}`), ctx({ id: BOGUS_ID, docId: BOGUS_ID }))), allowed: [...RCM_ROLES] },
  { name: 'GET /api/rcm/claims/[id]/preview', call: () => settle(() => getRcmClaimPreview(get(`/api/rcm/claims/${BOGUS_ID}/preview`), ctx({ id: BOGUS_ID }))), allowed: [...RCM_ROLES] },
  { name: 'POST /api/rcm/claims/[id]/submissions', call: () => settle(() => postRcmClaimSubmission(send('POST', `/api/rcm/claims/${BOGUS_ID}/submissions`), ctx({ id: BOGUS_ID }))), allowed: [...RCM_ROLES] },
  { name: 'POST /api/rcm/claims/[id]/actions', call: () => settle(() => postRcmClaimAction(send('POST', `/api/rcm/claims/${BOGUS_ID}/actions`), ctx({ id: BOGUS_ID }))), allowed: [...RCM_ROLES] },
  { name: 'POST /api/rcm/claims/[id]/settlements', call: () => settle(() => postRcmClaimSettlement(send('POST', `/api/rcm/claims/${BOGUS_ID}/settlements`), ctx({ id: BOGUS_ID }))), allowed: [...RCM_ROLES] },
  { name: 'POST /api/rcm/claims/[id]/write-offs', call: () => settle(() => postRcmClaimWriteOff(send('POST', `/api/rcm/claims/${BOGUS_ID}/write-offs`), ctx({ id: BOGUS_ID }))), allowed: [...RCM_ROLES] },
  { name: 'GET /api/rcm/claim-documents/[id]', call: () => settle(() => getRcmClaimDocument(get(`/api/rcm/claim-documents/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...RCM_ROLES] },
  { name: 'POST /api/rcm/dispatches/[id]/acknowledge', call: () => settle(() => postRcmAcknowledge(send('POST', `/api/rcm/dispatches/${BOGUS_ID}/acknowledge`), ctx({ id: BOGUS_ID }))), allowed: [...RCM_ROLES] },
  { name: 'GET /api/rcm/submissions/[id]/copy/[copy]', call: () => settle(() => getRcmCopy(get(`/api/rcm/submissions/${BOGUS_ID}/copy/rcm`), ctx({ id: BOGUS_ID, copy: 'rcm' }))), allowed: [...RCM_ROLES] },
  { name: 'GET /api/rcm/submissions/[id]/verify', call: () => settle(() => getRcmVerify(get(`/api/rcm/submissions/${BOGUS_ID}/verify`), ctx({ id: BOGUS_ID }))), allowed: [...RCM_ROLES] },
  { name: 'POST /api/rcm/settlements/[id]/reconcile', call: () => settle(() => postRcmReconcile(send('POST', `/api/rcm/settlements/${BOGUS_ID}/reconcile`), ctx({ id: BOGUS_ID }))), allowed: [...RCM_ROLES] },
  { name: 'POST /api/rcm/write-offs/[id]/decision', call: () => settle(() => postRcmWriteOffDecision(send('POST', `/api/rcm/write-offs/${BOGUS_ID}/decision`), ctx({ id: BOGUS_ID }))), allowed: [...WRITE_OFF_APPROVE_ROLES] },
  // end SP7
]

// Deny-before-parse: for the SP1 write routes a denied role sending a body
// that is not even JSON must still get the plain 403 -- a 400 here would mean
// the body was read before the gate.
const NOT_JSON = '{not json'
const SP1_WRITE_GATES: { name: string; call: () => Promise<Response>; allowed: readonly Role[] }[] = [
  { name: 'PATCH /api/patients/[anonId]/profile', call: () => patchProfile(send('PATCH', `/api/patients/${BOGUS_PATIENT}/profile`, NOT_JSON), ctx({ anonId: BOGUS_PATIENT })), allowed: PATIENT_PROFILE_EDIT_ROLES },
  { name: 'PUT /api/patients/[anonId]/contacts', call: () => putContacts(send('PUT', `/api/patients/${BOGUS_PATIENT}/contacts`, NOT_JSON), ctx({ anonId: BOGUS_PATIENT })), allowed: PATIENT_PROFILE_EDIT_ROLES },
  { name: 'PUT /api/patients/[anonId]/aadhaar', call: () => putAadhaar(send('PUT', `/api/patients/${BOGUS_PATIENT}/aadhaar`, NOT_JSON), ctx({ anonId: BOGUS_PATIENT })), allowed: AADHAAR_WRITE_ROLES },
  { name: 'POST /api/departments', call: () => postDepartment(send('POST', '/api/departments', NOT_JSON)), allowed: MASTER_DATA_ADMIN_ROLES },
  { name: 'PATCH /api/departments/[id]', call: () => patchDepartment(send('PATCH', `/api/departments/${BOGUS_ID}`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: MASTER_DATA_ADMIN_ROLES },
  { name: 'PUT /api/providers/[id]', call: () => putProvider(send('PUT', `/api/providers/${BOGUS_ID}`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: MASTER_DATA_ADMIN_ROLES },
  { name: 'PUT /api/settings/uhid-prefix', call: () => putUhidPrefix(send('PUT', '/api/settings/uhid-prefix', NOT_JSON)), allowed: MASTER_DATA_ADMIN_ROLES },
  // Wave B P1-09: identity verification now has a UI; pin its deny-before-parse too.
  { name: 'PUT /api/patients/[anonId]/identity', call: () => putIdentity(send('PUT', `/api/patients/${BOGUS_PATIENT}/identity`, NOT_JSON), ctx({ anonId: BOGUS_PATIENT })), allowed: IDENTITY_VERIFY_ROLES },
]
// SP2 tariff writes: the same deny-before-parse contract.
const SP2_WRITE_GATES: typeof SP1_WRITE_GATES = [
  { name: 'POST /api/tariff/services', call: () => postTariffService(send('POST', '/api/tariff/services', NOT_JSON)), allowed: TARIFF_MANAGE_ROLES },
  { name: 'PATCH /api/tariff/services/[id]', call: () => patchTariffService(send('PATCH', `/api/tariff/services/${BOGUS_ID}`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: TARIFF_MANAGE_ROLES },
  { name: 'POST /api/tariff/room-categories', call: () => postRoomCategory(send('POST', '/api/tariff/room-categories', NOT_JSON)), allowed: TARIFF_MANAGE_ROLES },
  { name: 'PATCH /api/tariff/room-categories/[id]', call: () => patchRoomCategory(send('PATCH', `/api/tariff/room-categories/${BOGUS_ID}`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: TARIFF_MANAGE_ROLES },
  { name: 'PUT /api/tariff/rooms/[id]/category', call: () => putRoomCategory(send('PUT', `/api/tariff/rooms/${BOGUS_ID}/category`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: TARIFF_MANAGE_ROLES },
  { name: 'POST /api/tariff/rates', call: () => postTariffRate(send('POST', '/api/tariff/rates', NOT_JSON)), allowed: TARIFF_MANAGE_ROLES },
  { name: 'POST /api/tariff/rates/[id]/revise', call: () => reviseTariffRate(send('POST', `/api/tariff/rates/${BOGUS_ID}/revise`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: TARIFF_MANAGE_ROLES },
  { name: 'PATCH /api/tariff/rates/[id]', call: () => patchTariffRate(send('PATCH', `/api/tariff/rates/${BOGUS_ID}`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: TARIFF_MANAGE_ROLES },
  { name: 'PUT /api/tariff/packages/[id]/items', call: () => putPackageItems(send('PUT', `/api/tariff/packages/${BOGUS_ID}/items`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: TARIFF_MANAGE_ROLES },
  // The import route 415s anything but application/json, so this row declares it: the 400 then proves the body was parsed only after the gate.
  { name: 'POST /api/tariff/import', call: () => postTariffImport(new NextRequest(url('/api/tariff/import'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: NOT_JSON })), allowed: TARIFF_MANAGE_ROLES },
]
// SP3 writes: the same deny-before-parse contract.
const SP3_WRITE_GATES: typeof SP1_WRITE_GATES = [
  { name: 'POST /api/front-desk/check-in', call: () => postCheckIn(send('POST', '/api/front-desk/check-in', NOT_JSON)), allowed: CHECK_IN_ROLES },
  { name: 'POST /api/encounters/[id]/status', call: () => postEncounterStatus(send('POST', `/api/encounters/${BOGUS_ID}/status`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: ENCOUNTER_STATUS_ROLES },
  { name: 'POST /api/follow-ups', call: () => postFollowUp(send('POST', '/api/follow-ups', NOT_JSON)), allowed: FOLLOW_UP_PLAN_ROLES },
  { name: 'PATCH /api/follow-ups/[id]', call: () => patchFollowUp(send('PATCH', `/api/follow-ups/${BOGUS_ID}`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: FOLLOW_UP_PLAN_ROLES },
  { name: 'POST /api/follow-ups/[id]/cancel', call: () => cancelFollowUp(send('POST', `/api/follow-ups/${BOGUS_ID}/cancel`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: FOLLOW_UP_PLAN_ROLES },
  { name: 'PUT /api/follow-ups/[id]/booking', call: () => putFollowUpBooking(send('PUT', `/api/follow-ups/${BOGUS_ID}/booking`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: FOLLOW_UP_BOOKING_ROLES },
  { name: 'POST /api/follow-ups/[id]/unbook', call: () => unbookFollowUp(send('POST', `/api/follow-ups/${BOGUS_ID}/unbook`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: FOLLOW_UP_BOOKING_ROLES },
  { name: 'POST /api/follow-ups/[id]/contact-attempts', call: () => postFollowUpContact(send('POST', `/api/follow-ups/${BOGUS_ID}/contact-attempts`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: FOLLOW_UP_BOOKING_ROLES },
  { name: 'POST /api/inpatient/admissions/[id]/discharge', call: () => postDischarge(send('POST', `/api/inpatient/admissions/${BOGUS_ID}/discharge`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: DISCHARGE_ROLES },
]
// SP4 billing writes: the same deny-before-parse contract.
const SP4_WRITE_GATES: typeof SP1_WRITE_GATES = [
  { name: 'PUT /api/billing/settings', call: () => putBillingSettings(send('PUT', '/api/billing/settings', NOT_JSON)), allowed: BILLING_CONFIG_ROLES },
  { name: 'PUT /api/billing/rules/[code]', call: () => putBillingRule(send('PUT', '/api/billing/rules/duplicate_charge', NOT_JSON), ctx({ code: 'duplicate_charge' })), allowed: BILLING_CONFIG_ROLES },
  { name: 'PUT /api/billing/payers/[id]', call: () => putPayerFlags(send('PUT', `/api/billing/payers/${BOGUS_ID}`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: BILLING_CONFIG_ROLES },
  { name: 'POST /api/billing/charge-lines', call: () => postChargeLine(send('POST', '/api/billing/charge-lines', NOT_JSON)), allowed: CHARGE_CAPTURE_ROLES },
  { name: 'POST /api/billing/charge-lines/preview', call: () => previewChargeLineRoute(send('POST', '/api/billing/charge-lines/preview', NOT_JSON)), allowed: CHARGE_CAPTURE_ROLES },
  { name: 'POST /api/billing/charge-lines/[id]/void', call: () => voidChargeLineRoute(send('POST', `/api/billing/charge-lines/${BOGUS_ID}/void`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: CHARGE_CAPTURE_ROLES },
  { name: 'POST /api/billing/admissions/[id]/room-rent', call: () => postRoomRentRoute(send('POST', `/api/billing/admissions/${BOGUS_ID}/room-rent`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: CHARGE_CAPTURE_ROLES },
  { name: 'POST /api/billing/invoices', call: () => postDraftInvoice(send('POST', '/api/billing/invoices', NOT_JSON)), allowed: CHARGE_CAPTURE_ROLES },
  { name: 'POST /api/billing/invoices/[id]/discard', call: () => discardInvoiceRoute(send('POST', `/api/billing/invoices/${BOGUS_ID}/discard`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: CHARGE_CAPTURE_ROLES },
  { name: 'POST /api/billing/invoices/[id]/finalise', call: () => finaliseInvoiceRoute(send('POST', `/api/billing/invoices/${BOGUS_ID}/finalise`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: BILLING_AUTHORITY_ROLES },
  { name: 'POST /api/billing/invoices/[id]/cancel', call: () => cancelInvoiceRoute(send('POST', `/api/billing/invoices/${BOGUS_ID}/cancel`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: BILLING_AUTHORITY_ROLES },
  { name: 'POST /api/billing/payments', call: () => postPaymentRoute(send('POST', '/api/billing/payments', NOT_JSON)), allowed: CASH_DESK_ROLES },
  { name: 'POST /api/billing/refunds', call: () => postRefundRoute(send('POST', '/api/billing/refunds', NOT_JSON)), allowed: BILLING_AUTHORITY_ROLES },
]
// end SP4
// SP5 writes: the same deny-before-parse contract.
const SP5_WRITE_GATES: typeof SP1_WRITE_GATES = [
  { name: 'POST /api/settings/lab-service-area', call: () => postLabServiceArea(send('POST', '/api/settings/lab-service-area', NOT_JSON)), allowed: LAB_SETUP_ROLES },
  { name: 'PATCH /api/settings/lab-service-area/[id]', call: () => patchLabServiceArea(send('PATCH', `/api/settings/lab-service-area/${BOGUS_ID}`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: LAB_SETUP_ROLES },
  { name: 'POST /api/settings/home-collection-windows', call: () => postCollectionWindow(send('POST', '/api/settings/home-collection-windows', NOT_JSON)), allowed: LAB_SETUP_ROLES },
  { name: 'PATCH /api/settings/home-collection-windows/[id]', call: () => patchCollectionWindow(send('PATCH', `/api/settings/home-collection-windows/${BOGUS_ID}`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: LAB_SETUP_ROLES },
  { name: 'PATCH /api/lab-tests/[id]', call: () => patchLabTestSetup(send('PATCH', `/api/lab-tests/${BOGUS_ID}`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: LAB_SETUP_ROLES },
  { name: 'PUT /api/patients/[anonId]/notification-preference', call: () => putNotificationPreference(send('PUT', `/api/patients/${BOGUS_PATIENT}/notification-preference`, NOT_JSON), ctx({ anonId: BOGUS_PATIENT })), allowed: NOTIFICATION_PREFERENCE_ROLES },
  { name: 'POST /api/patients/[anonId]/lab-orders', call: () => postLabRequisition(send('POST', `/api/patients/${BOGUS_PATIENT}/lab-orders`, NOT_JSON), ctx({ anonId: BOGUS_PATIENT })), allowed: LAB_ORDER_ROLES },
  { name: 'POST /api/lab-orders/receive', call: () => postLabReceive(send('POST', '/api/lab-orders/receive', NOT_JSON)), allowed: LAB_RECEIVE_ROLES },
  { name: 'POST /api/lab-orders/[id]/result', call: () => postLabResult(send('POST', `/api/lab-orders/${BOGUS_ID}/result`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: LAB_RESULT_ENTRY_ROLES },
  { name: 'POST /api/lab-orders/[id]/cancel', call: () => postLabCancel(send('POST', `/api/lab-orders/${BOGUS_ID}/cancel`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: LAB_ORDER_ROLES },
  { name: 'POST /api/home-collections', call: () => postHomeCollection(send('POST', '/api/home-collections', NOT_JSON)), allowed: HOME_COLLECTION_BOOKING_ROLES },
  { name: 'PATCH /api/home-collections/[id]', call: () => patchHomeCollection(send('PATCH', `/api/home-collections/${BOGUS_ID}`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: HOME_COLLECTION_BOOKING_ROLES },
  { name: 'POST /api/home-collections/[id]/cancel', call: () => cancelHomeCollectionRoute(send('POST', `/api/home-collections/${BOGUS_ID}/cancel`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: HOME_COLLECTION_CANCEL_ROLES },
  { name: 'PUT /api/home-collections/[id]/collector', call: () => putHomeCollectionCollector(send('PUT', `/api/home-collections/${BOGUS_ID}/collector`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: HOME_COLLECTION_DISPATCH_ROLES },
  { name: 'POST /api/home-collections/[id]/collect', call: () => collectHomeCollectionRoute(send('POST', `/api/home-collections/${BOGUS_ID}/collect`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: COLLECTOR_ROUTE_ROLES },
]
// end SP5
// SP6 writes: the same deny-before-parse contract.
const SP6_WRITE_GATES: typeof SP1_WRITE_GATES = [
  // The import route 415s anything but application/json, so this row declares it (as the tariff import row does).
  { name: 'POST /api/coding/code-systems/import', call: () => postCodeImport(new NextRequest(url('/api/coding/code-systems/import'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: NOT_JSON })), allowed: CODE_SYSTEM_ADMIN_ROLES },
  { name: 'PATCH /api/coding/code-systems/[id]', call: () => patchCodeSystem(send('PATCH', `/api/coding/code-systems/${BOGUS_ID}`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: CODE_SYSTEM_ADMIN_ROLES },
  { name: 'POST /api/coding/encounters/[id]/diagnoses', call: () => postCodingDx(send('POST', `/api/coding/encounters/${BOGUS_ID}/diagnoses`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: CODING_ENTRY_ROLES },
  { name: 'PATCH /api/coding/encounters/[id]/diagnoses/[diagnosisId]', call: () => patchCodingDx(send('PATCH', `/api/coding/encounters/${BOGUS_ID}/diagnoses/${BOGUS_ID}`, NOT_JSON), ctx({ id: BOGUS_ID, diagnosisId: BOGUS_ID })), allowed: CODING_ENTRY_ROLES },
  { name: 'POST /api/coding/encounters/[id]/procedures', call: () => postCodingProc(send('POST', `/api/coding/encounters/${BOGUS_ID}/procedures`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: CODING_ENTRY_ROLES },
  { name: 'PATCH /api/coding/encounters/[id]/procedures/[procedureId]', call: () => patchCodingProc(send('PATCH', `/api/coding/encounters/${BOGUS_ID}/procedures/${BOGUS_ID}`, NOT_JSON), ctx({ id: BOGUS_ID, procedureId: BOGUS_ID })), allowed: CODING_ENTRY_ROLES },
  { name: 'POST /api/coding/encounters/[id]/status', call: () => postCodingStatus(send('POST', `/api/coding/encounters/${BOGUS_ID}/status`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: CODING_ROLES },
  { name: 'POST /api/coding/encounters/[id]/queries', call: () => postCodingQuery(send('POST', `/api/coding/encounters/${BOGUS_ID}/queries`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: CODING_ROLES },
  { name: 'PATCH /api/coding/queries/[queryId]', call: () => patchCodingQuery(send('PATCH', `/api/coding/queries/${BOGUS_ID}`, NOT_JSON), ctx({ queryId: BOGUS_ID })), allowed: CODING_ROLES },
  { name: 'POST /api/coding/queries/[queryId]/responses', call: () => postCodingQueryResponse(send('POST', `/api/coding/queries/${BOGUS_ID}/responses`, NOT_JSON), ctx({ queryId: BOGUS_ID })), allowed: CODING_QUERY_RESPOND_ROLES },
  { name: 'PUT /api/coding/services/[serviceId]/procedure-codes', call: () => putServiceCodes(send('PUT', `/api/coding/services/${BOGUS_ID}/procedure-codes`, NOT_JSON), ctx({ serviceId: BOGUS_ID })), allowed: CODING_ROLES }, // SP6 Task 14
]
// end SP6
// Wave C writes: the same deny-before-parse contract.
const WAVE_C_WRITE_GATES: typeof SP1_WRITE_GATES = [
  { name: 'PATCH /api/patients/[anonId]/demographics', call: () => patchDemographics(send('PATCH', `/api/patients/${BOGUS_PATIENT}/demographics`, NOT_JSON), ctx({ anonId: BOGUS_PATIENT })), allowed: DEMOGRAPHICS_CORRECTION_ROLES },
]
// SP7 writes: the same deny-before-parse contract.
const SP7_WRITE_GATES: typeof SP1_WRITE_GATES = [
  { name: 'POST /api/rcm/payers', call: () => postRcmPayer(send('POST', '/api/rcm/payers', NOT_JSON)), allowed: PAYER_MASTER_ROLES },
  { name: 'PUT /api/rcm/payers/[id]', call: () => putRcmPayer(send('PUT', `/api/rcm/payers/${BOGUS_ID}`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: PAYER_MASTER_ROLES },
  { name: 'PUT /api/rcm/payers/[id]/contacts', call: () => putRcmPayerContacts(send('PUT', `/api/rcm/payers/${BOGUS_ID}/contacts`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: PAYER_MASTER_ROLES },
  { name: 'PUT /api/rcm/payers/[id]/networks', call: () => putRcmPayerNetworks(send('PUT', `/api/rcm/payers/${BOGUS_ID}/networks`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: PAYER_MASTER_ROLES },
  { name: 'PUT /api/rcm/payers/[id]/requirements', call: () => putRcmPayerRequirements(send('PUT', `/api/rcm/payers/${BOGUS_ID}/requirements`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: PAYER_MASTER_ROLES },
  { name: 'PUT /api/rcm/settings', call: () => putRcmSettings(send('PUT', '/api/rcm/settings', NOT_JSON)), allowed: RCM_SETTINGS_ROLES },
  { name: 'POST /api/rcm/policies', call: () => postRcmPolicy(send('POST', '/api/rcm/policies', NOT_JSON)), allowed: POLICY_WRITE_ROLES },
  { name: 'PATCH /api/rcm/policies/[id]', call: () => patchRcmPolicy(send('PATCH', `/api/rcm/policies/${BOGUS_ID}`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: POLICY_WRITE_ROLES },
  // Multipart route: a non-multipart body is the 400 an allowed role gets, after the gate.
  { name: 'POST /api/rcm/policies/[id]/card', call: () => postRcmPolicyCard(send('POST', `/api/rcm/policies/${BOGUS_ID}/card`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: POLICY_WRITE_ROLES },
  { name: 'POST /api/rcm/preauths', call: () => postRcmPreauth(send('POST', '/api/rcm/preauths', NOT_JSON)), allowed: RCM_ROLES },
  { name: 'POST /api/rcm/preauths/estimate', call: () => postRcmPreauthEstimate(send('POST', '/api/rcm/preauths/estimate', NOT_JSON)), allowed: RCM_ROLES },
  { name: 'POST /api/rcm/preauths/[id]/actions', call: () => postRcmPreauthAction(send('POST', `/api/rcm/preauths/${BOGUS_ID}/actions`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: RCM_ROLES },
  { name: 'POST /api/rcm/preauths/[id]/documents', call: () => postRcmPreauthDocument(send('POST', `/api/rcm/preauths/${BOGUS_ID}/documents`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: RCM_ROLES },
  { name: 'POST /api/rcm/claims', call: () => postRcmClaim(send('POST', `/api/rcm/claims`, NOT_JSON)), allowed: RCM_ROLES },
  { name: 'PUT /api/rcm/claims/[id]/invoices', call: () => putRcmClaimInvoices(send('PUT', `/api/rcm/claims/${BOGUS_ID}/invoices`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: RCM_ROLES },
  { name: 'POST /api/rcm/claims/[id]/documents', call: () => postRcmClaimDocument(send('POST', `/api/rcm/claims/${BOGUS_ID}/documents`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: RCM_ROLES },
  { name: 'POST /api/rcm/claims/[id]/documents/attach', call: () => postRcmClaimAttach(send('POST', `/api/rcm/claims/${BOGUS_ID}/documents/attach`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: RCM_ROLES },
  { name: 'POST /api/rcm/claims/[id]/documents/waive', call: () => postRcmClaimWaive(send('POST', `/api/rcm/claims/${BOGUS_ID}/documents/waive`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: RCM_ROLES },
  // DELETE has no body: a non-numeric id is the 400 an allowed role gets, after the gate.
  { name: 'DELETE /api/rcm/claims/[id]/documents/[docId]', call: () => deleteRcmClaimDocument(del('/api/rcm/claims/x/documents/x'), ctx({ id: 'x', docId: 'x' })), allowed: RCM_ROLES },
  { name: 'POST /api/rcm/claims/[id]/submissions', call: () => postRcmClaimSubmission(send('POST', `/api/rcm/claims/${BOGUS_ID}/submissions`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: RCM_ROLES },
  { name: 'POST /api/rcm/claims/[id]/actions', call: () => postRcmClaimAction(send('POST', `/api/rcm/claims/${BOGUS_ID}/actions`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: RCM_ROLES },
  { name: 'POST /api/rcm/claims/[id]/settlements', call: () => postRcmClaimSettlement(send('POST', `/api/rcm/claims/${BOGUS_ID}/settlements`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: RCM_ROLES },
  { name: 'POST /api/rcm/claims/[id]/write-offs', call: () => postRcmClaimWriteOff(send('POST', `/api/rcm/claims/${BOGUS_ID}/write-offs`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: RCM_ROLES },
  { name: 'POST /api/rcm/dispatches/[id]/acknowledge', call: () => postRcmAcknowledge(send('POST', `/api/rcm/dispatches/${BOGUS_ID}/acknowledge`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: RCM_ROLES },
  { name: 'POST /api/rcm/settlements/[id]/reconcile', call: () => postRcmReconcile(send('POST', `/api/rcm/settlements/${BOGUS_ID}/reconcile`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: RCM_ROLES },
  { name: 'POST /api/rcm/write-offs/[id]/decision', call: () => postRcmWriteOffDecision(send('POST', `/api/rcm/write-offs/${BOGUS_ID}/decision`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: WRITE_OFF_APPROVE_ROLES },
]
// end SP7
describe.each([...SP1_WRITE_GATES, ...SP2_WRITE_GATES, ...SP3_WRITE_GATES, ...SP4_WRITE_GATES, ...SP6_WRITE_GATES, ...WAVE_C_WRITE_GATES, ...SP5_WRITE_GATES, ...SP7_WRITE_GATES])('$name (deny before parse)', (c) => {
  it('403s a denied role sending an unparseable body; an allowed role gets a 400', async () => {
    for (const role of ALL_ROLES) {
      sessionRole = role
      const res = await c.call()
      if (c.allowed.includes(role)) {
        expect.soft(res.status, `${c.name} allowed ${role}`).toBe(400)
      } else {
        expect.soft(res.status, `${c.name} must deny ${role} before parsing`).toBe(403)
        expect.soft(await res.json()).toEqual({ error: 'Forbidden' })
      }
    }
  })
})

// Every gap tag was removed by the task that closed it. A row re-tagged
// later would silently run as `it.fails`; this keeps the table honest.
it('no API_GATES row still carries a gap tag', () => {
  expect(API_GATES.filter((r) => r.gap).map((r) => r.name)).toEqual([])
})

// A gap-tagged row's allowed half always runs as a plain `it` (a wrong 403
// for an allowed role is visible immediately); only the deny half is the
// known-open gap and runs under `it.fails`.
describe.each(API_GATES)('$name', (c) => {
  it('admits every allowed role', async () => {
    for (const role of ALL_ROLES.filter((r) => c.allowed.includes(r))) {
      sessionRole = role
      const res = await c.call()
      expect.soft(res.status, `${c.name} must admit ${role}`).not.toBe(403)
    }
  })

  // expect.soft so a red run lists every offending role, not just the first.
  gateIt(c)('403s every role outside the policy with no data in the body', async () => {
    for (const role of ALL_ROLES.filter((r) => !c.allowed.includes(r))) {
      sessionRole = role
      const res = await c.call()
      expect.soft(res.status, `${c.name} must deny ${role}`).toBe(403)
      if (res.status === 403) expect.soft(await res.json(), `${c.name} 403 body for ${role}`).toEqual({ error: 'Forbidden' })
    }
  })
})
