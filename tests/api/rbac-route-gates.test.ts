import { describe, it, expect, vi, afterEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs' // Wave I
import { join, relative, sep } from 'node:path' // Wave I
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
import { GET as getRcmClaimRegister } from '@/app/api/rcm/reports/claims-csv/route'
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
import { GET as priceSheet } from '@/app/api/tariff/services/[id]/price-sheet/route' // Wave G
import { GET as getNotifications } from '@/app/api/notifications/route' // Wave G
import { POST as markNotificationsRead } from '@/app/api/notifications/read/route' // Wave G
import { NOTIFICATION_FEED_ROLES } from '@/lib/role-policy' // Wave G
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
// Wave F
import { GET as getEncounterRegisterExport } from '@/app/api/encounters/register/export/route'
import { ENCOUNTER_REGISTER_EXPORT_ROLES } from '@/lib/role-policy'
// end Wave F

// Wave I (P2-14): the rest of the gated routes
import { PUT as putMfaMethodRoute } from '@/app/api/account/mfa-method/route'
import { POST as resetOwnMfaRoute } from '@/app/api/account/mfa/reset/route'
import { POST as startTelemedicine } from '@/app/api/appointments/[id]/telemedicine/route'
import { GET as getAuditLog } from '@/app/api/audit-log/route'
import { PATCH as confirmBookingRequest } from '@/app/api/booking-requests/[id]/confirm/route'
import { PATCH as declineBookingRequest } from '@/app/api/booking-requests/[id]/decline/route'
import { PATCH as patchCarePlanGoal } from '@/app/api/care-plan-goals/[id]/route'
import { POST as postChargeRoute } from '@/app/api/charges/route'
import { PATCH as patchChargeRoute } from '@/app/api/charges/[id]/route'
import { GET as listConsentDocuments, POST as postConsentDocument } from '@/app/api/consent-documents/route'
import { GET as getConsentDocument, PUT as putConsentDocument } from '@/app/api/consent-documents/[id]/route'
import { POST as postDocumentRoute } from '@/app/api/documents/route'
import { PATCH as patchDocumentRoute, DELETE as deleteDocumentRoute } from '@/app/api/documents/[id]/route'
import { GET as listFolders, POST as postFolderRoute } from '@/app/api/form-template-folders/route'
import { PUT as putFolderRoute, DELETE as deleteFolderRoute } from '@/app/api/form-template-folders/[id]/route'
import { GET as listTemplateConsents, POST as attachTemplateConsent } from '@/app/api/form-templates/[id]/consents/route'
import { DELETE as detachTemplateConsent } from '@/app/api/form-templates/[id]/consents/[consentDocumentId]/route'
import { POST as acknowledgeDeclineRoute } from '@/app/api/front-desk/assignments/[id]/acknowledge-decline/route'
import { POST as declineAssignmentRoute } from '@/app/api/front-desk/assignments/[id]/decline/route'
import { POST as scheduleAssignmentRoute } from '@/app/api/front-desk/assignments/[id]/schedule/route'
import { POST as eligibilityCheckRoute } from '@/app/api/front-desk/eligibility-check/route'
import { GET as frontDeskPatientLookup } from '@/app/api/front-desk/patient-lookup/route'
import { POST as orderAdmissionMedication } from '@/app/api/inpatient/admissions/[id]/medications/route'
import { POST as administerAdmissionMedication } from '@/app/api/inpatient/admissions/[id]/medications/[medId]/administer/route'
import { POST as transferAdmissionRoute } from '@/app/api/inpatient/admissions/[id]/transfer/route'
import { POST as blockRoomRoute } from '@/app/api/inpatient/rooms/[id]/block/route'
import { POST as markRoomCleanRoute } from '@/app/api/inpatient/rooms/[id]/mark-clean/route'
import { POST as unblockRoomRoute } from '@/app/api/inpatient/rooms/[id]/unblock/route'
import { GET as getLabsPatient } from '@/app/api/labs/patients/[patientId]/route'
import { GET as getNavBadgesRoute } from '@/app/api/nav-badges/route'
import { DELETE as deletePatientRoute } from '@/app/api/patients/[anonId]/route'
import { POST as postCarePlanRoute } from '@/app/api/patients/[anonId]/care-plans/route'
import { POST as postInsuranceCardRoute } from '@/app/api/patients/[anonId]/insurance-card/route'
import { POST as issuePortalPassword, DELETE as revokePortalPassword } from '@/app/api/patients/[anonId]/portal-password/route'
import { POST as postPrescriptionRoute } from '@/app/api/patients/[anonId]/prescriptions/route'
import { PATCH as patchPrescriptionRoute } from '@/app/api/patients/[anonId]/prescriptions/[id]/route'
import { POST as resetPatientMfaRoute } from '@/app/api/patients/[anonId]/reset-mfa/route'
import { POST as confirmScreeningRoute } from '@/app/api/patients/[anonId]/screening/confirm/route'
import { GET as listPayersRoute } from '@/app/api/payers/route'
import { POST as dispenseRoute } from '@/app/api/pharmacy/dispense/route'
import { POST as chargeDispenseRoute } from '@/app/api/pharmacy/dispenses/[dispenseId]/charge/route'
import { GET as listMedicationsRoute, POST as postMedicationRoute } from '@/app/api/pharmacy/medications/route'
import { GET as getPharmacyPatient } from '@/app/api/pharmacy/patients/[patientId]/route'
import { PUT as putAutoClassifyRoute } from '@/app/api/settings/auto-classify/route'
import { PUT as putPracticeInfoRoute } from '@/app/api/settings/practice-info/route'
import { PUT as putQueuePinRoute } from '@/app/api/settings/queue-display-pin/route'
import { POST as postStaffRoute } from '@/app/api/staff/route'
import { PATCH as patchStaffRoute } from '@/app/api/staff/[id]/route'
import { POST as postCredentialRoute } from '@/app/api/staff/[id]/credentials/route'
import { PATCH as patchCredentialRoute } from '@/app/api/staff/[id]/credentials/[credentialId]/route'
import { POST as endTelemedicineRoute } from '@/app/api/telemedicine/[sessionId]/end/route'
import { GET as pollSignalRoute, POST as postSignalRoute } from '@/app/api/telemedicine/[sessionId]/signal/route'
import { GET as listAdverseEvents, POST as postAdverseEventRoute, PATCH as notifyAdverseEventRoute } from '@/app/api/trials/[trialId]/adverse-events/route'
import { GET as listDrugAccountability, POST as postDrugAccountabilityRoute } from '@/app/api/trials/[trialId]/drug-accountability/route'
import { GET as listRegulatoryDocuments, POST as postRegulatoryDocumentRoute } from '@/app/api/trials/[trialId]/regulatory-documents/route'
import { GET as listUsersRoute, POST as postUserRoute } from '@/app/api/users/route'
import { POST as resetUserMfaRoute } from '@/app/api/users/[id]/reset-mfa/route'
import { ACCOUNT_ROLES, PAYER_LIST_ROLES, PHARMACY_STOCK_READ_ROLES } from '@/lib/role-policy'
import { GET as getReportCsv } from '@/app/api/reports/[report]/csv/route'
import { HOSPITAL_REPORTS } from '@/lib/reports/catalog'
// end Wave I

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
  // Wave G P1-05: the price lookup's rate card -- TARIFF_LOOKUP_ROLES, like resolve.
  { name: 'GET /api/tariff/services/[id]/price-sheet', call: () => settle(() => priceSheet(get(`/api/tariff/services/${BOGUS_ID}/price-sheet`), ctx({ id: BOGUS_ID }))), allowed: [...TARIFF_LOOKUP_ROLES] },
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
  // Wave G P2-01: notification feed and mark-read -- NOTIFICATION_FEED_ROLES (every staff role; content is per role).
  { name: 'GET /api/notifications', call: () => settle(() => getNotifications()), allowed: [...NOTIFICATION_FEED_ROLES] },
  { name: 'POST /api/notifications/read', call: () => settle(() => markNotificationsRead(send('POST', '/api/notifications/read'))), allowed: [...NOTIFICATION_FEED_ROLES] },
  // Wave C P1-11: name/DOB correction -- DEMOGRAPHICS_CORRECTION_ROLES (admin); `{}` fails validation before any query.
  { name: 'PATCH /api/patients/[anonId]/demographics', call: () => settle(() => patchDemographics(send('PATCH', `/api/patients/${BOGUS_PATIENT}/demographics`), ctx({ anonId: BOGUS_PATIENT }))), allowed: [...DEMOGRAPHICS_CORRECTION_ROLES] },
  // Wave F P1-04: OPD register CSV export -- ENCOUNTER_REGISTER_EXPORT_ROLES (admin, crc), narrower than the /encounters page.
  { name: 'GET /api/encounters/register/export', call: () => settle(() => getEncounterRegisterExport(get('/api/encounters/register/export?from=2031-03-10&to=2031-03-10'))), allowed: [...ENCOUNTER_REGISTER_EXPORT_ROLES] },
  // end Wave F
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
  // SP7 claim register CSV (RCM_ROLES): no range is a 400 before any query.
  { name: 'GET /api/rcm/reports/claims-csv', call: () => settle(() => getRcmClaimRegister(get('/api/rcm/reports/claims-csv'))), allowed: [...RCM_ROLES] },
  // end SP7
  // Wave I (P2-14): every remaining staff-gated handler. Write bodies are
  // unparseable (an allowed role gets a 400 after the gate, nothing is
  // written); bodyless writes name ids that cannot exist.
  ...((): ApiGateCase[] => {
    const ADMIN: Role[] = ['admin']
    const ADMIN_CRC_PI: Role[] = ['admin', 'crc', 'pi']
    const PI_ADMIN: Role[] = ['pi', 'admin']
    const TRIAL = 'probe-no-trial'
    const w = (method: 'POST' | 'PUT' | 'PATCH', path: string) => send(method, path, NOT_JSON)
    return [
      { name: 'PUT /api/account/mfa-method', call: () => settle(() => putMfaMethodRoute(w('PUT', '/api/account/mfa-method'))), allowed: [...ACCOUNT_ROLES] },
      { name: 'POST /api/account/mfa/reset', call: () => settle(() => resetOwnMfaRoute(w('POST', '/api/account/mfa/reset'))), allowed: [...ACCOUNT_ROLES] },
      { name: 'POST /api/appointments/[id]/telemedicine', call: () => settle(() => startTelemedicine(w('POST', `/api/appointments/${BOGUS_ID}/telemedicine`), ctx({ id: BOGUS_ID }))), allowed: ['admin', 'pi'] },
      { name: 'GET /api/audit-log', call: () => settle(() => getAuditLog(get('/api/audit-log'))), allowed: ADMIN },
      { name: 'PATCH /api/booking-requests/[id]/confirm', call: () => settle(() => confirmBookingRequest(w('PATCH', `/api/booking-requests/${BOGUS_ID}/confirm`), ctx({ id: BOGUS_ID }))), allowed: ['admin', 'crc', 'frontdesk'] },
      { name: 'PATCH /api/booking-requests/[id]/decline', call: () => settle(() => declineBookingRequest(w('PATCH', `/api/booking-requests/${BOGUS_ID}/decline`), ctx({ id: BOGUS_ID }))), allowed: ['admin', 'crc', 'frontdesk'] },
      { name: 'PATCH /api/care-plan-goals/[id]', call: () => settle(() => patchCarePlanGoal(w('PATCH', `/api/care-plan-goals/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: PI_ADMIN },
      { name: 'POST /api/charges', call: () => settle(() => postChargeRoute(w('POST', '/api/charges'))), allowed: [...CHARGES_ROLES] },
      { name: 'PATCH /api/charges/[id]', call: () => settle(() => patchChargeRoute(w('PATCH', `/api/charges/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...CHARGES_ROLES] },
      { name: 'GET /api/consent-documents', call: () => settle(() => listConsentDocuments()), allowed: ADMIN_CRC_PI },
      { name: 'POST /api/consent-documents', call: () => settle(() => postConsentDocument(w('POST', '/api/consent-documents'))), allowed: ADMIN_CRC_PI },
      { name: 'GET /api/consent-documents/[id]', call: () => settle(() => getConsentDocument(get(`/api/consent-documents/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: ADMIN_CRC_PI },
      { name: 'PUT /api/consent-documents/[id]', call: () => settle(() => putConsentDocument(w('PUT', `/api/consent-documents/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: ADMIN_CRC_PI },
      // Multipart upload: a non-multipart body is the 400 an allowed role gets, after the gate.
      { name: 'POST /api/documents', call: () => settle(() => postDocumentRoute(w('POST', '/api/documents'))), allowed: ['admin', 'crc', 'frontdesk'] },
      { name: 'PATCH /api/documents/[id]', call: () => settle(() => patchDocumentRoute(w('PATCH', `/api/documents/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: ['admin', 'crc', 'frontdesk'] },
      { name: 'DELETE /api/documents/[id]', call: () => settle(() => deleteDocumentRoute(del(`/api/documents/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: ADMIN },
      { name: 'GET /api/form-template-folders', call: () => settle(() => listFolders()), allowed: ADMIN_CRC_PI },
      { name: 'POST /api/form-template-folders', call: () => settle(() => postFolderRoute(w('POST', '/api/form-template-folders'))), allowed: ADMIN_CRC_PI },
      { name: 'PUT /api/form-template-folders/[id]', call: () => settle(() => putFolderRoute(w('PUT', `/api/form-template-folders/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: ADMIN_CRC_PI },
      { name: 'DELETE /api/form-template-folders/[id]', call: () => settle(() => deleteFolderRoute(del(`/api/form-template-folders/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: ADMIN_CRC_PI },
      { name: 'GET /api/form-templates/[id]/consents', call: () => settle(() => listTemplateConsents(get(`/api/form-templates/${BOGUS_ID}/consents`), ctx({ id: BOGUS_ID }))), allowed: ADMIN_CRC_PI },
      { name: 'POST /api/form-templates/[id]/consents', call: () => settle(() => attachTemplateConsent(w('POST', `/api/form-templates/${BOGUS_ID}/consents`), ctx({ id: BOGUS_ID }))), allowed: ADMIN_CRC_PI },
      { name: 'DELETE /api/form-templates/[id]/consents/[consentDocumentId]', call: () => settle(() => detachTemplateConsent(del(`/api/form-templates/${BOGUS_ID}/consents/${BOGUS_ID}`), ctx({ id: BOGUS_ID, consentDocumentId: BOGUS_ID }))), allowed: ADMIN_CRC_PI },
      { name: 'POST /api/front-desk/assignments/[id]/acknowledge-decline', call: () => settle(() => acknowledgeDeclineRoute(send('POST', `/api/front-desk/assignments/${BOGUS_ID}/acknowledge-decline`), ctx({ id: BOGUS_ID }))), allowed: ['frontdesk', 'admin', 'crc'] },
      { name: 'POST /api/front-desk/assignments/[id]/decline', call: () => settle(() => declineAssignmentRoute(w('POST', `/api/front-desk/assignments/${BOGUS_ID}/decline`), ctx({ id: BOGUS_ID }))), allowed: ['pi'] },
      { name: 'POST /api/front-desk/assignments/[id]/schedule', call: () => settle(() => scheduleAssignmentRoute(w('POST', `/api/front-desk/assignments/${BOGUS_ID}/schedule`), ctx({ id: BOGUS_ID }))), allowed: ['pi'] },
      { name: 'POST /api/front-desk/eligibility-check', call: () => settle(() => eligibilityCheckRoute(w('POST', '/api/front-desk/eligibility-check'))), allowed: ['billing', 'admin', 'crc'] },
      { name: 'GET /api/front-desk/patient-lookup', call: () => settle(() => frontDeskPatientLookup(get('/api/front-desk/patient-lookup?q=zzzz-probe'))), allowed: ['frontdesk', 'admin', 'crc'] },
      { name: 'POST /api/inpatient/admissions/[id]/medications', call: () => settle(() => orderAdmissionMedication(w('POST', `/api/inpatient/admissions/${BOGUS_ID}/medications`), ctx({ id: BOGUS_ID }))), allowed: PI_ADMIN },
      { name: 'POST /api/inpatient/admissions/[id]/medications/[medId]/administer', call: () => settle(() => administerAdmissionMedication(w('POST', `/api/inpatient/admissions/${BOGUS_ID}/medications/${BOGUS_ID}/administer`), ctx({ id: BOGUS_ID, medId: BOGUS_ID }))), allowed: PI_ADMIN },
      { name: 'POST /api/inpatient/admissions/[id]/transfer', call: () => settle(() => transferAdmissionRoute(w('POST', `/api/inpatient/admissions/${BOGUS_ID}/transfer`), ctx({ id: BOGUS_ID }))), allowed: ['frontdesk', 'admin', 'crc', 'pi'] },
      { name: 'POST /api/inpatient/rooms/[id]/block', call: () => settle(() => blockRoomRoute(w('POST', `/api/inpatient/rooms/${BOGUS_ID}/block`), ctx({ id: BOGUS_ID }))), allowed: ADMIN },
      { name: 'POST /api/inpatient/rooms/[id]/mark-clean', call: () => settle(() => markRoomCleanRoute(send('POST', `/api/inpatient/rooms/${BOGUS_ID}/mark-clean`), ctx({ id: BOGUS_ID }))), allowed: ['frontdesk', 'admin', 'crc'] },
      { name: 'POST /api/inpatient/rooms/[id]/unblock', call: () => settle(() => unblockRoomRoute(send('POST', `/api/inpatient/rooms/${BOGUS_ID}/unblock`), ctx({ id: BOGUS_ID }))), allowed: ADMIN },
      { name: 'GET /api/labs/patients/[patientId]', call: () => settle(() => getLabsPatient(get(`/api/labs/patients/${BOGUS_PATIENT}`), ctx({ patientId: BOGUS_PATIENT }))), allowed: ['admin', 'pi', 'crc', 'labs'] },
      { name: 'GET /api/nav-badges', call: () => settle(() => getNavBadgesRoute()), allowed: [...ALL_ROLES] },
      { name: 'DELETE /api/patients/[anonId]', call: () => settle(() => deletePatientRoute(del(`/api/patients/${BOGUS_PATIENT}`), ctx({ anonId: BOGUS_PATIENT }))), allowed: ADMIN },
      { name: 'POST /api/patients/[anonId]/care-plans', call: () => settle(() => postCarePlanRoute(w('POST', `/api/patients/${BOGUS_PATIENT}/care-plans`), ctx({ anonId: BOGUS_PATIENT }))), allowed: PI_ADMIN },
      // Multipart upload: a non-multipart body is the 400 an allowed role gets, after the gate.
      { name: 'POST /api/patients/[anonId]/insurance-card', call: () => settle(() => postInsuranceCardRoute(w('POST', `/api/patients/${BOGUS_PATIENT}/insurance-card`), ctx({ anonId: BOGUS_PATIENT }))), allowed: ['admin', 'crc', 'frontdesk'] },
      { name: 'POST /api/patients/[anonId]/portal-password', call: () => settle(() => issuePortalPassword(send('POST', `/api/patients/${BOGUS_PATIENT}/portal-password`), ctx({ anonId: BOGUS_PATIENT }))), allowed: ADMIN },
      { name: 'DELETE /api/patients/[anonId]/portal-password', call: () => settle(() => revokePortalPassword(del(`/api/patients/${BOGUS_PATIENT}/portal-password`), ctx({ anonId: BOGUS_PATIENT }))), allowed: ADMIN },
      { name: 'POST /api/patients/[anonId]/prescriptions', call: () => settle(() => postPrescriptionRoute(w('POST', `/api/patients/${BOGUS_PATIENT}/prescriptions`), ctx({ anonId: BOGUS_PATIENT }))), allowed: ['admin', 'pi'] },
      { name: 'PATCH /api/patients/[anonId]/prescriptions/[id]', call: () => settle(() => patchPrescriptionRoute(w('PATCH', `/api/patients/${BOGUS_PATIENT}/prescriptions/${BOGUS_ID}`), ctx({ anonId: BOGUS_PATIENT, id: BOGUS_ID }))), allowed: ['admin', 'pi'] },
      { name: 'POST /api/patients/[anonId]/reset-mfa', call: () => settle(() => resetPatientMfaRoute(send('POST', `/api/patients/${BOGUS_PATIENT}/reset-mfa`), ctx({ anonId: BOGUS_PATIENT }))), allowed: ADMIN },
      { name: 'POST /api/patients/[anonId]/screening/confirm', call: () => settle(() => confirmScreeningRoute(send('POST', `/api/patients/${BOGUS_PATIENT}/screening/confirm`), ctx({ anonId: BOGUS_PATIENT }))), allowed: ['admin', 'pi', 'crc'] },
      // Wave I gate fix: was any signed-in role (labs, collector, coder, pharmacy, rcm included).
      { name: 'GET /api/payers', call: () => settle(() => listPayersRoute()), allowed: [...PAYER_LIST_ROLES] },
      { name: 'POST /api/pharmacy/dispense', call: () => settle(() => dispenseRoute(w('POST', '/api/pharmacy/dispense'))), allowed: ['admin', 'pi', 'pharmacy'] },
      { name: 'POST /api/pharmacy/dispenses/[dispenseId]/charge', call: () => settle(() => chargeDispenseRoute(w('POST', `/api/pharmacy/dispenses/${BOGUS_ID}/charge`), ctx({ dispenseId: BOGUS_ID }))), allowed: ['pharmacy', 'admin'] },
      // Wave I gate fix: the stock list was any signed-in role; now the /pharmacy page's roles.
      { name: 'GET /api/pharmacy/medications', call: () => settle(() => listMedicationsRoute()), allowed: [...PHARMACY_STOCK_READ_ROLES] },
      { name: 'POST /api/pharmacy/medications', call: () => settle(() => postMedicationRoute(w('POST', '/api/pharmacy/medications'))), allowed: ['admin', 'pharmacy'] },
      { name: 'GET /api/pharmacy/patients/[patientId]', call: () => settle(() => getPharmacyPatient(get(`/api/pharmacy/patients/${BOGUS_PATIENT}`), ctx({ patientId: BOGUS_PATIENT }))), allowed: ['pharmacy', 'admin'] },
      { name: 'PUT /api/settings/auto-classify', call: () => settle(() => putAutoClassifyRoute(w('PUT', '/api/settings/auto-classify'))), allowed: ADMIN },
      { name: 'PUT /api/settings/practice-info', call: () => settle(() => putPracticeInfoRoute(w('PUT', '/api/settings/practice-info'))), allowed: ADMIN },
      { name: 'PUT /api/settings/queue-display-pin', call: () => settle(() => putQueuePinRoute(w('PUT', '/api/settings/queue-display-pin'))), allowed: ADMIN },
      { name: 'POST /api/staff', call: () => settle(() => postStaffRoute(w('POST', '/api/staff'))), allowed: ADMIN },
      { name: 'PATCH /api/staff/[id]', call: () => settle(() => patchStaffRoute(w('PATCH', `/api/staff/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: ADMIN },
      { name: 'POST /api/staff/[id]/credentials', call: () => settle(() => postCredentialRoute(w('POST', `/api/staff/${BOGUS_ID}/credentials`), ctx({ id: BOGUS_ID }))), allowed: ADMIN },
      { name: 'PATCH /api/staff/[id]/credentials/[credentialId]', call: () => settle(() => patchCredentialRoute(w('PATCH', `/api/staff/${BOGUS_ID}/credentials/${BOGUS_ID}`), ctx({ id: BOGUS_ID, credentialId: BOGUS_ID }))), allowed: ADMIN },
      { name: 'POST /api/telemedicine/[sessionId]/end', call: () => settle(() => endTelemedicineRoute(send('POST', `/api/telemedicine/${BOGUS_ID}/end`), ctx({ sessionId: BOGUS_ID }))), allowed: ['admin', 'pi'] },
      { name: 'POST /api/telemedicine/[sessionId]/signal', call: () => settle(() => postSignalRoute(w('POST', `/api/telemedicine/${BOGUS_ID}/signal`), ctx({ sessionId: BOGUS_ID }))), allowed: ['admin', 'pi'] },
      { name: 'GET /api/telemedicine/[sessionId]/signal', call: () => settle(() => pollSignalRoute(get(`/api/telemedicine/${BOGUS_ID}/signal?for=patient`), ctx({ sessionId: BOGUS_ID }))), allowed: ['admin', 'pi'] },
      { name: 'GET /api/trials/[trialId]/adverse-events', call: () => settle(() => listAdverseEvents(get(`/api/trials/${TRIAL}/adverse-events`), ctx({ trialId: TRIAL }))), allowed: ADMIN_CRC_PI },
      { name: 'POST /api/trials/[trialId]/adverse-events', call: () => settle(() => postAdverseEventRoute(w('POST', `/api/trials/${TRIAL}/adverse-events`), ctx({ trialId: TRIAL }))), allowed: ADMIN_CRC_PI },
      { name: 'PATCH /api/trials/[trialId]/adverse-events', call: () => settle(() => notifyAdverseEventRoute(w('PATCH', `/api/trials/${TRIAL}/adverse-events`), ctx({ trialId: TRIAL }))), allowed: ADMIN_CRC_PI },
      { name: 'GET /api/trials/[trialId]/drug-accountability', call: () => settle(() => listDrugAccountability(get(`/api/trials/${TRIAL}/drug-accountability`), ctx({ trialId: TRIAL }))), allowed: ADMIN_CRC_PI },
      { name: 'POST /api/trials/[trialId]/drug-accountability', call: () => settle(() => postDrugAccountabilityRoute(w('POST', `/api/trials/${TRIAL}/drug-accountability`), ctx({ trialId: TRIAL }))), allowed: ADMIN_CRC_PI },
      { name: 'GET /api/trials/[trialId]/regulatory-documents', call: () => settle(() => listRegulatoryDocuments(get(`/api/trials/${TRIAL}/regulatory-documents`), ctx({ trialId: TRIAL }))), allowed: ADMIN_CRC_PI },
      { name: 'POST /api/trials/[trialId]/regulatory-documents', call: () => settle(() => postRegulatoryDocumentRoute(w('POST', `/api/trials/${TRIAL}/regulatory-documents`), ctx({ trialId: TRIAL }))), allowed: ADMIN_CRC_PI },
      { name: 'GET /api/users', call: () => settle(() => listUsersRoute()), allowed: ADMIN },
      { name: 'POST /api/users', call: () => settle(() => postUserRoute(w('POST', '/api/users'))), allowed: ADMIN },
      { name: 'POST /api/users/[id]/reset-mfa', call: () => settle(() => resetUserMfaRoute(send('POST', `/api/users/${BOGUS_ID}/reset-mfa`), ctx({ id: BOGUS_ID }))), allowed: ADMIN },
      // P1-23 hospital report CSV: each report's catalogue roles; no range is a 400 before any query.
      ...HOSPITAL_REPORTS.map((r): ApiGateCase => ({ name: `GET /api/reports/[report]/csv (${r.key})`, call: () => settle(() => getReportCsv(get(`/api/reports/${r.key}/csv`), ctx({ report: r.key }))), allowed: [...r.roles] })),
      { name: 'GET /api/reports/[report]/csv (unknown report)', call: () => settle(() => getReportCsv(get('/api/reports/nope/csv'), ctx({ report: 'nope' }))), allowed: [] },
    ]
  })(),
  // end Wave I
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
// Wave G writes: the same deny-before-parse contract.
const WAVE_G_WRITE_GATES: typeof SP1_WRITE_GATES = [
  { name: 'POST /api/notifications/read', call: () => markNotificationsRead(send('POST', '/api/notifications/read', NOT_JSON)), allowed: NOTIFICATION_FEED_ROLES },
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
describe.each([...SP1_WRITE_GATES, ...SP2_WRITE_GATES, ...SP3_WRITE_GATES, ...SP4_WRITE_GATES, ...SP5_WRITE_GATES, ...SP6_WRITE_GATES, ...WAVE_C_WRITE_GATES, ...WAVE_G_WRITE_GATES, ...SP7_WRITE_GATES])('$name (deny before parse)', (c) => {
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

// Wave I (P2-14): every exported handler of every src/app/api/**/route.ts is
// pinned here -- an API_GATES row, a deny-before-parse row, one of the bespoke
// describe blocks at the top of this file -- or carries a documented exemption
// (no staff role gate exists to pin: public, pre-login, token, patient-session
// or shared-secret routes, each pinned by its own test file). A new route
// without a row fails this test; so does an exemption left behind for a
// handler that no longer exists.
const BESPOKE_ROWS = [
  'GET /api/workbook/full', 'GET /api/workbook/export', 'POST /api/mock-payments',
  'GET /api/broadcasts', 'POST /api/broadcasts', 'GET /api/broadcasts/[id]', 'GET /api/broadcasts/recipients',
  'GET /api/reviews', 'POST /api/reviews', 'GET /api/reviews/[id]', 'PUT /api/reviews/[id]',
]
const UNGATED_EXEMPT: Record<string, string> = {
  'GET /api/auth/google/start': 'pre-login SSO redirect (tests/api/auth-google.test.ts)',
  'GET /api/auth/google/callback': 'pre-login SSO callback; links only an existing account (tests/api/auth-google.test.ts)',
  'GET /api/health': 'public liveness probe, no data (tests/api/health.test.ts)',
  'GET /api/health/ready': 'public readiness probe, no data (tests/api/health.test.ts)',
  'POST /api/login': 'pre-session staff login (tests/api/login.test.ts)',
  'POST /api/login/mfa': 'pre-session MFA step, pending-login cookie (tests/api/login-mfa.test.ts)',
  'POST /api/logout': 'clears the caller\'s own cookie',
  'POST /api/patient-portal/login': 'patient portal pre-session login (tests/api/patient-portal.test.ts)',
  'POST /api/patient-portal/login/mfa': 'patient portal pre-session MFA (tests/api/patient-portal-login-mfa.test.ts)',
  'POST /api/patient-portal/appointment-requests': 'patient session only, own record (tests/api/patient-portal-appointment-requests.test.ts)',
  'POST /api/patient-portal/login/otp': 'patient portal pre-session OTP request (tests/api/patient-portal-login-otp.test.ts)',
  'POST /api/patient-portal/login/otp/verify': 'patient portal pre-session OTP verify (tests/api/patient-portal-login-otp.test.ts)',
  'POST /api/patient-portal/logout': 'clears the patient\'s own cookie',
  'POST /api/patient-portal/account/mfa/enroll': 'patient session only, own account (tests/api/patient-portal-account-mfa.test.ts)',
  'POST /api/patient-portal/account/mfa/confirm': 'patient session only, own account (tests/api/patient-portal-account-mfa.test.ts)',
  'POST /api/patient-portal/account/mfa/reset': 'patient session only, own account (tests/api/patient-portal-account-mfa.test.ts)',
  'GET /api/patient-portal/consent': 'patient session only, own record (tests/api/patient-portal.test.ts)',
  'POST /api/patient-portal/consent': 'patient session only, own record (tests/api/patient-portal.test.ts)',
  'GET /api/patient-portal/medications-export': 'patient session only, own record (tests/api/patient-portal.test.ts)',
  'GET /api/patient-portal/lab-reports/[id]/download': 'patient session only, own reports (tests/api/patient-portal-lab-report-download.test.ts)',
  'POST /api/patients/[anonId]/form-submissions/[id]/sign': 'patient session only, own submission (tests/api/form-submission-sign.test.ts)',
  'GET /api/intake/[token]': 'intake token possession (tests/api/intake-portal.test.ts)',
  'PUT /api/intake/[token]': 'intake token possession (tests/api/intake-portal.test.ts)',
  'POST /api/intake/[token]/consents/[formSubmissionConsentId]/sign': 'intake token possession (tests/api/intake-consent-sign.test.ts)',
  'GET /api/telemedicine/join/[token]/signal': 'patient join token possession (tests/api/telemedicine-join-signal.test.ts)',
  'POST /api/telemedicine/join/[token]/signal': 'patient join token possession (tests/api/telemedicine-join-signal.test.ts)',
  'POST /api/public/booking-requests': 'public booking form, rate limited (tests/api/public-booking-requests.test.ts)',
  'GET /api/queue-display': 'lobby display PIN, no session (tests/api/queue-display.test.ts)',
  'POST /api/webhooks/fhir-labs': 'LIS shared-secret token (tests/api/webhooks-fhir-labs.test.ts)',
  'GET /api/messages/[patientId]': 'staff-or-patient dual session via getSession, not requireSession; staff roles pinned in tests/api/messages.test.ts',
  'POST /api/messages/[patientId]': 'staff-or-patient dual session via getSession, not requireSession; staff roles pinned in tests/api/messages.test.ts',
}

function findRouteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return findRouteFiles(p)
    return e.name === 'route.ts' ? [p] : []
  })
}

function apiHandlers(): string[] {
  const appDir = join(process.cwd(), 'src', 'app')
  return findRouteFiles(join(appDir, 'api')).flatMap((file) => {
    const route = `/${relative(appDir, file).split(sep).slice(0, -1).join('/')}`
    const methods = [...readFileSync(file, 'utf8').matchAll(/export (?:async function|const) (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1])
    return methods.map((m) => `${m} ${route}`)
  })
}

describe('every API route handler is pinned (Wave I P2-14)', () => {
  const rowName = (name: string) => name.split(' ').slice(0, 2).join(' ')
  const pinned = new Set([
    ...API_GATES.map((r) => rowName(r.name)),
    ...[...SP1_WRITE_GATES, ...SP2_WRITE_GATES, ...SP3_WRITE_GATES, ...SP4_WRITE_GATES, ...SP5_WRITE_GATES, ...SP6_WRITE_GATES, ...WAVE_C_WRITE_GATES, ...WAVE_G_WRITE_GATES, ...SP7_WRITE_GATES].map((r) => rowName(r.name)),
    ...BESPOKE_ROWS,
  ])
  const handlers = apiHandlers()

  it('finds the route files', () => {
    expect(handlers.length).toBeGreaterThan(200)
  })

  it('has a gate row or a documented exemption for every handler', () => {
    expect(handlers.filter((h) => !pinned.has(h) && !(h in UNGATED_EXEMPT)).sort()).toEqual([])
  })

  it('has no stale or doubled exemptions', () => {
    expect(Object.keys(UNGATED_EXEMPT).filter((h) => !handlers.includes(h))).toEqual([])
    expect(Object.keys(UNGATED_EXEMPT).filter((h) => pinned.has(h))).toEqual([])
  })

  it('has no row for a handler that does not exist', () => {
    expect([...pinned].filter((h) => !handlers.includes(h))).toEqual([])
  })
})
// end Wave I
