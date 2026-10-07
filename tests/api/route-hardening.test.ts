// Wave H (P2-05 / P2-07): every gated JSON route answers a malformed body with a
// fixed 400 `{ error: 'Invalid JSON' }` -- never an unhandled 500 -- and only
// AFTER its role gate (a denied role still gets its 403 first). Unparseable or
// out-of-range path ids are a 400/404, never a 500. Routes already pinned by the
// deny-before-parse tables in rbac-route-gates.test.ts (SP1-SP3 writes) are not
// repeated here. No route reaches a write: every allowed call fails at parsing.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'
import { ALL_ROLES, CHARGES_ROLES, CLINICAL_ROLES, REGISTRATION_ROLES, SCHEDULING_ROLES } from '@/lib/role-policy'
import { INVALID_JSON_MESSAGE } from '@/lib/http'

let sessionRole: Role = 'admin'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: `Test ${sessionRole}`, userId: null })) }
})
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
afterEach(() => { sessionRole = 'admin' })

import { POST as postAppointment } from '@/app/api/appointments/route'
import { PUT as putAppointment } from '@/app/api/appointments/[id]/route'
import { PATCH as confirmBooking } from '@/app/api/booking-requests/[id]/confirm/route'
import { PATCH as declineBooking } from '@/app/api/booking-requests/[id]/decline/route'
import { POST as postBroadcast } from '@/app/api/broadcasts/route'
import { GET as getBroadcast } from '@/app/api/broadcasts/[id]/route'
import { PATCH as patchGoal } from '@/app/api/care-plan-goals/[id]/route'
import { POST as postCharge } from '@/app/api/charges/route'
import { GET as getCharge, PATCH as patchCharge } from '@/app/api/charges/[id]/route'
import { POST as postConsentDoc } from '@/app/api/consent-documents/route'
import { GET as getConsentDoc, PUT as putConsentDoc } from '@/app/api/consent-documents/[id]/route'
import { PATCH as patchDocument, DELETE as deleteDocument } from '@/app/api/documents/[id]/route'
import { GET as downloadDocument } from '@/app/api/documents/[id]/download/route'
import { POST as resolveDiscrepancy } from '@/app/api/discrepancies/[id]/resolve/route'
import { POST as postFormSubmission } from '@/app/api/form-submissions/route'
import { GET as getFormSubmission, PUT as putFormSubmission } from '@/app/api/form-submissions/[id]/route'
import { POST as postFolder } from '@/app/api/form-template-folders/route'
import { PUT as putFolder, DELETE as deleteFolder } from '@/app/api/form-template-folders/[id]/route'
import { POST as postTemplate } from '@/app/api/form-templates/route'
import { GET as getTemplate, PUT as putTemplate } from '@/app/api/form-templates/[id]/route'
import { POST as attachConsent } from '@/app/api/form-templates/[id]/consents/route'
import { POST as declineAssignment } from '@/app/api/front-desk/assignments/[id]/decline/route'
import { POST as scheduleAssignment } from '@/app/api/front-desk/assignments/[id]/schedule/route'
import { POST as eligibilityCheck } from '@/app/api/front-desk/eligibility-check/route'
import { POST as administerMed } from '@/app/api/inpatient/admissions/[id]/medications/[medId]/administer/route'
import { POST as orderInpatientMed } from '@/app/api/inpatient/admissions/[id]/medications/route'
import { POST as transferAdmission } from '@/app/api/inpatient/admissions/[id]/transfer/route'
import { POST as blockRoom } from '@/app/api/inpatient/rooms/[id]/block/route'
import { POST as cancelLabOrder } from '@/app/api/lab-orders/[id]/cancel/route'
import { POST as enterLabResult } from '@/app/api/lab-orders/[id]/result/route'
import { POST as mockPayment } from '@/app/api/mock-payments/route'
import { POST as postCarePlan } from '@/app/api/patients/[anonId]/care-plans/route'
import { POST as postNote } from '@/app/api/patients/[anonId]/notes/route'
import { POST as postLabOrder } from '@/app/api/patients/[anonId]/lab-orders/route'
import { POST as postPrescription } from '@/app/api/patients/[anonId]/prescriptions/route'
import { PATCH as stopPrescription } from '@/app/api/patients/[anonId]/prescriptions/[id]/route'
import { POST as postPatient } from '@/app/api/patients/route'
import { POST as dispense } from '@/app/api/pharmacy/dispense/route'
import { POST as dispenseCharge } from '@/app/api/pharmacy/dispenses/[dispenseId]/charge/route'
import { POST as postMedication } from '@/app/api/pharmacy/medications/route'
import { POST as postReview } from '@/app/api/reviews/route'
import { GET as getReview, PUT as putReview } from '@/app/api/reviews/[id]/route'
import { PUT as putAutoClassify } from '@/app/api/settings/auto-classify/route'
import { PUT as putPracticeInfo } from '@/app/api/settings/practice-info/route'
import { PUT as putQueuePin } from '@/app/api/settings/queue-display-pin/route'
import { POST as postStaff } from '@/app/api/staff/route'
import { PATCH as patchStaff } from '@/app/api/staff/[id]/route'
import { POST as postCredential } from '@/app/api/staff/[id]/credentials/route'
import { PATCH as patchCredential } from '@/app/api/staff/[id]/credentials/[credentialId]/route'
import { POST as postUser } from '@/app/api/users/route'
import { POST as postAdverseEvent, PATCH as notifyAdverseEvent } from '@/app/api/trials/[trialId]/adverse-events/route'
import { POST as postDrugAccountability } from '@/app/api/trials/[trialId]/drug-accountability/route'
import { POST as postRegulatoryDoc } from '@/app/api/trials/[trialId]/regulatory-documents/route'
import { PUT as putMfaMethod } from '@/app/api/account/mfa-method/route'
import { POST as resetOwnMfa } from '@/app/api/account/mfa/reset/route'
import { POST as login } from '@/app/api/login/route'
import { POST as portalLogin } from '@/app/api/patient-portal/login/route'

const NOT_JSON = '{not json'
const BOGUS_ID = '2147483000'
const BOGUS_PATIENT = 'RD-ZZZZ'
const TRIAL = 'probe-no-trial'
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const send = (method: Method, path: string, body?: string) => new NextRequest(`http://localhost${path}`, { method, body })
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) })

const PI_ADMIN: Role[] = ['pi', 'admin']
const ADMIN: Role[] = ['admin']
const ADMIN_CRC: Role[] = ['admin', 'crc']
const ADMIN_CRC_PI: Role[] = ['admin', 'crc', 'pi']

type JsonCase = { name: string; call: () => Promise<Response>; allowed: readonly Role[]; allowedStatus?: number }
const JSON_GATES: JsonCase[] = [
  { name: 'POST /api/appointments', call: () => postAppointment(send('POST', '/api/appointments', NOT_JSON)), allowed: SCHEDULING_ROLES },
  { name: 'PUT /api/appointments/[id]', call: () => putAppointment(send('PUT', `/api/appointments/${BOGUS_ID}`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: SCHEDULING_ROLES },
  { name: 'PATCH /api/booking-requests/[id]/confirm', call: () => confirmBooking(send('PATCH', '/x', NOT_JSON), ctx({ id: BOGUS_ID })), allowed: ['admin', 'crc', 'frontdesk'] },
  { name: 'PATCH /api/booking-requests/[id]/decline', call: () => declineBooking(send('PATCH', '/x', NOT_JSON), ctx({ id: BOGUS_ID })), allowed: ['admin', 'crc', 'frontdesk'] },
  { name: 'POST /api/broadcasts', call: () => postBroadcast(send('POST', '/api/broadcasts', NOT_JSON)), allowed: ADMIN_CRC },
  { name: 'PATCH /api/care-plan-goals/[id]', call: () => patchGoal(send('PATCH', '/x', NOT_JSON), ctx({ id: BOGUS_ID })), allowed: PI_ADMIN },
  { name: 'POST /api/charges', call: () => postCharge(send('POST', '/api/charges', NOT_JSON)), allowed: CHARGES_ROLES },
  { name: 'PATCH /api/charges/[id]', call: () => patchCharge(send('PATCH', '/x', NOT_JSON), ctx({ id: BOGUS_ID })), allowed: CHARGES_ROLES },
  { name: 'POST /api/consent-documents', call: () => postConsentDoc(send('POST', '/x', NOT_JSON)), allowed: ADMIN_CRC_PI },
  { name: 'PUT /api/consent-documents/[id]', call: () => putConsentDoc(send('PUT', '/x', NOT_JSON), ctx({ id: BOGUS_ID })), allowed: ADMIN_CRC_PI },
  { name: 'PATCH /api/documents/[id]', call: () => patchDocument(send('PATCH', '/x', NOT_JSON), ctx({ id: BOGUS_ID })), allowed: ['admin', 'crc', 'frontdesk'] },
  { name: 'POST /api/form-submissions', call: () => postFormSubmission(send('POST', '/x', NOT_JSON)), allowed: CLINICAL_ROLES },
  { name: 'PUT /api/form-submissions/[id]', call: () => putFormSubmission(send('PUT', '/x', NOT_JSON), ctx({ id: BOGUS_ID })), allowed: CLINICAL_ROLES },
  { name: 'POST /api/form-template-folders', call: () => postFolder(send('POST', '/x', NOT_JSON)), allowed: ADMIN_CRC_PI },
  { name: 'PUT /api/form-template-folders/[id]', call: () => putFolder(send('PUT', '/x', NOT_JSON), ctx({ id: BOGUS_ID })), allowed: ADMIN_CRC_PI },
  { name: 'POST /api/form-templates', call: () => postTemplate(send('POST', '/x', NOT_JSON)), allowed: CLINICAL_ROLES },
  { name: 'PUT /api/form-templates/[id]', call: () => putTemplate(send('PUT', '/x', NOT_JSON), ctx({ id: BOGUS_ID })), allowed: CLINICAL_ROLES },
  { name: 'POST /api/form-templates/[id]/consents', call: () => attachConsent(send('POST', '/x', NOT_JSON), ctx({ id: BOGUS_ID })), allowed: ADMIN_CRC_PI },
  { name: 'POST /api/front-desk/assignments/[id]/decline', call: () => declineAssignment(send('POST', '/x', NOT_JSON), ctx({ id: BOGUS_ID })), allowed: ['pi'] },
  { name: 'POST /api/front-desk/assignments/[id]/schedule', call: () => scheduleAssignment(send('POST', '/x', NOT_JSON), ctx({ id: BOGUS_ID })), allowed: ['pi'] },
  { name: 'POST /api/front-desk/eligibility-check', call: () => eligibilityCheck(send('POST', '/x', NOT_JSON)), allowed: ['billing', 'admin', 'crc'] },
  // These two look the admission up before reading the body: an unknown admission is a 404 (never a 500).
  { name: 'POST /api/inpatient/admissions/[id]/medications/[medId]/administer', call: () => administerMed(send('POST', '/x', NOT_JSON), ctx({ id: BOGUS_ID, medId: BOGUS_ID })), allowed: PI_ADMIN, allowedStatus: 404 },
  { name: 'POST /api/inpatient/admissions/[id]/medications', call: () => orderInpatientMed(send('POST', '/x', NOT_JSON), ctx({ id: BOGUS_ID })), allowed: PI_ADMIN, allowedStatus: 404 },
  { name: 'POST /api/inpatient/admissions/[id]/transfer', call: () => transferAdmission(send('POST', '/x', NOT_JSON), ctx({ id: BOGUS_ID })), allowed: ['frontdesk', 'admin', 'crc', 'pi'] },
  { name: 'POST /api/inpatient/rooms/[id]/block', call: () => blockRoom(send('POST', '/x', NOT_JSON), ctx({ id: BOGUS_ID })), allowed: ADMIN },
  { name: 'POST /api/lab-orders/[id]/cancel', call: () => cancelLabOrder(send('POST', '/x', NOT_JSON), ctx({ id: BOGUS_ID })), allowed: ['admin', 'pi'] },
  { name: 'POST /api/lab-orders/[id]/result', call: () => enterLabResult(send('POST', '/x', NOT_JSON), ctx({ id: BOGUS_ID })), allowed: ['admin', 'pi', 'labs'] },
  { name: 'POST /api/mock-payments', call: () => mockPayment(send('POST', '/x', NOT_JSON)), allowed: ['admin', 'crc', 'billing'] },
  { name: 'POST /api/patients', call: () => postPatient(send('POST', '/x', NOT_JSON)), allowed: REGISTRATION_ROLES },
  { name: 'POST /api/patients/[anonId]/care-plans', call: () => postCarePlan(send('POST', '/x', NOT_JSON), ctx({ anonId: BOGUS_PATIENT })), allowed: PI_ADMIN },
  { name: 'POST /api/patients/[anonId]/notes', call: () => postNote(send('POST', '/x', NOT_JSON), ctx({ anonId: BOGUS_PATIENT })), allowed: PI_ADMIN },
  { name: 'POST /api/patients/[anonId]/lab-orders', call: () => postLabOrder(send('POST', '/x', NOT_JSON), ctx({ anonId: BOGUS_PATIENT })), allowed: ['admin', 'pi'] },
  { name: 'POST /api/patients/[anonId]/prescriptions', call: () => postPrescription(send('POST', '/x', NOT_JSON), ctx({ anonId: BOGUS_PATIENT })), allowed: ['admin', 'pi'] },
  { name: 'PATCH /api/patients/[anonId]/prescriptions/[id]', call: () => stopPrescription(send('PATCH', '/x', NOT_JSON), ctx({ anonId: BOGUS_PATIENT, id: BOGUS_ID })), allowed: ['admin', 'pi'] },
  { name: 'POST /api/pharmacy/dispense', call: () => dispense(send('POST', '/x', NOT_JSON)), allowed: ['admin', 'pi', 'pharmacy'] },
  // Looks the dispense up before reading the body.
  { name: 'POST /api/pharmacy/dispenses/[dispenseId]/charge', call: () => dispenseCharge(send('POST', '/x', NOT_JSON), ctx({ dispenseId: BOGUS_ID })), allowed: ['pharmacy', 'admin'], allowedStatus: 404 },
  { name: 'POST /api/pharmacy/medications', call: () => postMedication(send('POST', '/x', NOT_JSON)), allowed: ['admin', 'pharmacy'] },
  { name: 'POST /api/reviews', call: () => postReview(send('POST', '/x', NOT_JSON)), allowed: ADMIN_CRC },
  { name: 'PUT /api/reviews/[id]', call: () => putReview(send('PUT', '/x', NOT_JSON), ctx({ id: BOGUS_ID })), allowed: ADMIN_CRC },
  { name: 'PUT /api/settings/auto-classify', call: () => putAutoClassify(send('PUT', '/x', NOT_JSON)), allowed: ADMIN },
  { name: 'PUT /api/settings/practice-info', call: () => putPracticeInfo(send('PUT', '/x', NOT_JSON)), allowed: ADMIN },
  { name: 'PUT /api/settings/queue-display-pin', call: () => putQueuePin(send('PUT', '/x', NOT_JSON)), allowed: ADMIN },
  { name: 'POST /api/staff', call: () => postStaff(send('POST', '/x', NOT_JSON)), allowed: ADMIN },
  { name: 'PATCH /api/staff/[id]', call: () => patchStaff(send('PATCH', '/x', NOT_JSON), ctx({ id: BOGUS_ID })), allowed: ADMIN },
  { name: 'POST /api/staff/[id]/credentials', call: () => postCredential(send('POST', '/x', NOT_JSON), ctx({ id: BOGUS_ID })), allowed: ADMIN },
  { name: 'PATCH /api/staff/[id]/credentials/[credentialId]', call: () => patchCredential(send('PATCH', '/x', NOT_JSON), ctx({ id: BOGUS_ID, credentialId: BOGUS_ID })), allowed: ADMIN },
  { name: 'POST /api/users', call: () => postUser(send('POST', '/x', NOT_JSON)), allowed: ADMIN },
  { name: 'POST /api/trials/[trialId]/adverse-events', call: () => postAdverseEvent(send('POST', '/x', NOT_JSON), ctx({ trialId: TRIAL })), allowed: ['crc', 'pi', 'admin'] },
  { name: 'PATCH /api/trials/[trialId]/adverse-events', call: () => notifyAdverseEvent(send('PATCH', '/x', NOT_JSON), ctx({ trialId: TRIAL })), allowed: ['crc', 'pi', 'admin'] },
  { name: 'POST /api/trials/[trialId]/drug-accountability', call: () => postDrugAccountability(send('POST', '/x', NOT_JSON), ctx({ trialId: TRIAL })), allowed: ['crc', 'pi', 'admin'] },
  { name: 'POST /api/trials/[trialId]/regulatory-documents', call: () => postRegulatoryDoc(send('POST', '/x', NOT_JSON), ctx({ trialId: TRIAL })), allowed: ['crc', 'pi', 'admin'] },
  { name: 'PUT /api/account/mfa-method', call: () => putMfaMethod(send('PUT', '/x', NOT_JSON)), allowed: ALL_ROLES },
  { name: 'POST /api/account/mfa/reset', call: () => resetOwnMfa(send('POST', '/x', NOT_JSON)), allowed: ALL_ROLES },
]

describe.each(JSON_GATES)('$name (malformed JSON after the gate)', (c) => {
  it('403s a denied role first; an allowed role gets a fixed 400 Invalid JSON (never a 500)', async () => {
    for (const role of ALL_ROLES) {
      sessionRole = role
      const res = await c.call()
      const body = await res.json()
      if (c.allowed.includes(role)) {
        const expected = c.allowedStatus ?? 400
        expect.soft(res.status, `${c.name} allowed ${role}`).toBe(expected)
        if (expected === 400) expect.soft(body, `${c.name} allowed ${role}`).toEqual({ error: INVALID_JSON_MESSAGE })
      } else {
        expect.soft(res.status, `${c.name} must deny ${role} before parsing`).toBe(403)
        expect.soft(String(body.error)).toMatch(/^Forbidden/)
      }
    }
  })
})

describe('ungated JSON routes answer a malformed body with a fixed 400', () => {
  it.each([
    ['POST /api/login', () => login(send('POST', '/api/login', NOT_JSON))],
    ['POST /api/patient-portal/login', () => portalLogin(send('POST', '/api/patient-portal/login', NOT_JSON))],
  ] as const)('%s', async (_name, call) => {
    const res = await call()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: INVALID_JSON_MESSAGE })
  })
})

// P2-07: ids that are not plain int4 digits never reach Postgres.
const BAD_IDS = ['abc', 'NaN', '1.5', '-3', '0', '1e3', '99999999999']
type IdCase = { name: string; call: (id: string) => Promise<Response> }
const ID_CASES: IdCase[] = [
  { name: 'GET /api/broadcasts/[id]', call: (id) => getBroadcast(send('GET', '/x'), ctx({ id })) },
  { name: 'GET /api/charges/[id]', call: (id) => getCharge(send('GET', '/x'), ctx({ id })) },
  { name: 'PATCH /api/charges/[id]', call: (id) => patchCharge(send('PATCH', '/x', '{"status":"approved"}'), ctx({ id })) },
  { name: 'GET /api/consent-documents/[id]', call: (id) => getConsentDoc(send('GET', '/x'), ctx({ id })) },
  { name: 'PUT /api/consent-documents/[id]', call: (id) => putConsentDoc(send('PUT', '/x', '{"title":"x"}'), ctx({ id })) },
  { name: 'DELETE /api/documents/[id]', call: (id) => deleteDocument(send('DELETE', '/x'), ctx({ id })) },
  { name: 'GET /api/documents/[id]/download', call: (id) => downloadDocument(send('GET', '/x'), ctx({ id })) },
  { name: 'POST /api/discrepancies/[id]/resolve', call: (id) => resolveDiscrepancy(send('POST', '/x'), ctx({ id })) },
  { name: 'GET /api/form-submissions/[id]', call: (id) => getFormSubmission(send('GET', '/x'), ctx({ id })) },
  { name: 'DELETE /api/form-template-folders/[id]', call: (id) => deleteFolder(send('DELETE', '/x'), ctx({ id })) },
  { name: 'GET /api/form-templates/[id]', call: (id) => getTemplate(send('GET', '/x'), ctx({ id })) },
  { name: 'GET /api/reviews/[id]', call: (id) => getReview(send('GET', '/x'), ctx({ id })) },
  { name: 'PATCH /api/care-plan-goals/[id]', call: (id) => patchGoal(send('PATCH', '/x', '{}'), ctx({ id })) },
  { name: 'POST /api/inpatient/rooms/[id]/block', call: (id) => blockRoom(send('POST', '/x', '{}'), ctx({ id })) },
  { name: 'PATCH /api/staff/[id]', call: (id) => patchStaff(send('PATCH', '/x', '{}'), ctx({ id })) },
  { name: 'PATCH /api/patients/[anonId]/prescriptions/[id]', call: (id) => stopPrescription(send('PATCH', '/x'), ctx({ anonId: BOGUS_PATIENT, id })) },
]

describe.each(ID_CASES)('$name (bad path ids)', (c) => {
  it('answers 400/404 (never 500) for every non-int4 id', async () => {
    sessionRole = 'admin'
    for (const id of BAD_IDS) {
      const res = await c.call(id)
      expect.soft([400, 404], `${c.name} id=${id} -> ${res.status}`).toContain(res.status)
    }
  })
})
