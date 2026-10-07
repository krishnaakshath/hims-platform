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
import { gateIt } from '../pages/page-gates-harness'

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

export type ApiGateCase = { name: string; call: () => Promise<Response>; allowed: Role[]; gap?: string }

const BOGUS_ID = '2147483000'
const BOGUS_PATIENT = 'RD-ZZZZ'
const url = (path: string) => `http://localhost${path}`
const get = (path: string) => new NextRequest(url(path))
const send = (method: 'POST' | 'PUT' | 'PATCH', path: string, body: unknown = {}) =>
  new NextRequest(url(path), { method, body: typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) })

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
  // POLICY.md: global search -- only roles with a search scope
  { name: 'GET /api/search', call: () => search(get('/api/search?q=')), allowed: ALL_ROLES.filter(hasSearchScope) },
  // Wave C P0-04: patient picker -- PATIENT_PICKER_ROLES (directory roles + pharmacy + billing; never labs)
  { name: 'GET /api/patients/lookup', call: () => patientLookup(get('/api/patients/lookup?q=')), allowed: [...PATIENT_PICKER_ROLES] },
  // Wave C P1-11: name/DOB correction -- DEMOGRAPHICS_CORRECTION_ROLES (admin); `{}` fails validation before any query.
  { name: 'PATCH /api/patients/[anonId]/demographics', call: () => settle(() => patchDemographics(send('PATCH', `/api/patients/${BOGUS_PATIENT}/demographics`), ctx({ anonId: BOGUS_PATIENT }))), allowed: [...DEMOGRAPHICS_CORRECTION_ROLES] },
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
// Wave C writes: the same deny-before-parse contract.
const WAVE_C_WRITE_GATES: typeof SP1_WRITE_GATES = [
  { name: 'PATCH /api/patients/[anonId]/demographics', call: () => patchDemographics(send('PATCH', `/api/patients/${BOGUS_PATIENT}/demographics`, NOT_JSON), ctx({ anonId: BOGUS_PATIENT })), allowed: DEMOGRAPHICS_CORRECTION_ROLES },
]
describe.each([...SP1_WRITE_GATES, ...SP2_WRITE_GATES, ...SP3_WRITE_GATES, ...WAVE_C_WRITE_GATES])('$name (deny before parse)', (c) => {
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
