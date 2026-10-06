// @vitest-environment node
//
// Patient portal login signs a session cookie with jose, which under this
// project's default jsdom test environment hits the same cross-realm
// Uint8Array false-positive documented in tests/lib/auth.test.ts. Force
// plain Node here too.
import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { and, eq, inArray } from 'drizzle-orm'
import * as auth from '@/lib/auth'
import { getDb } from '@/db/client'
import { patients, formTemplates, formSubmissions, consentDocuments, formSubmissionConsents, auditLog } from '@/db/schema'
import { hashPassword, verifyPassword } from '@/lib/password'
import { checkPatientLoginRateLimit } from '@/lib/rate-limit'
import { getPatientPortalData, findPortalLoginCandidate, verifyPatientPortalLogin } from '@/lib/queries/patient-portal'
import { POST as portalLogin } from '@/app/api/patient-portal/login/route'
import { POST as generatePortalPassword, DELETE as revokePortalPassword } from '@/app/api/patients/[anonId]/portal-password/route'

const UNAUTHORIZED = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
const TEST_PATIENT_ID = 'RD-0001'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: 'admin' as const, name: 'Test Admin', userId: null })) }
})

// Same reasoning as tests/api/login.test.ts: rate limiting is real (shared
// Upstash Redis), so repeated full-suite runs within the same 60s window
// could otherwise make an unrelated later run's login attempt fail with
// 429 instead of the status this file is actually testing.
vi.mock('@/lib/rate-limit', () => ({
  checkPatientLoginRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}))

// Spy on (but do not replace) the real scrypt verify, so a test can prove an
// unresolvable email still pays for exactly one password verification.
// Count getDb() calls (one per query in the portal-login code path) without
// replacing the real client, so a test can prove the credential lookup is a
// single round trip.
vi.mock('@/db/client', async () => {
  const actual = await vi.importActual<typeof import('@/db/client')>('@/db/client')
  return { ...actual, getDb: vi.fn(actual.getDb) }
})

vi.mock('@/lib/password', async () => {
  const actual = await vi.importActual<typeof import('@/lib/password')>('@/lib/password')
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) }
})

function loginReq(body: unknown) {
  return new NextRequest('http://localhost/api/patient-portal/login', { method: 'POST', body: JSON.stringify(body) })
}

describe('POST /api/patients/[anonId]/portal-password', () => {
  // This file previously unconditionally nulled RD-0001's portalPasswordHash
  // after every test -- since RD-0001 is a real seeded patient (Maria
  // Alvarez), that silently destroyed any real portal credential an admin
  // had genuinely issued for demo/verification purposes, every single time
  // this suite ran. Snapshot the real value up front and restore exactly
  // that, the same pattern already used in tests/api/settings.test.ts.
  let originalPortalPasswordHash: string | null
  beforeAll(async () => {
    const [row] = await getDb().select({ portalPasswordHash: patients.portalPasswordHash }).from(patients).where(eq(patients.id, TEST_PATIENT_ID))
    originalPortalPasswordHash = row.portalPasswordHash
  })
  afterAll(async () => {
    await getDb().update(patients).set({ portalPasswordHash: originalPortalPasswordHash }).where(eq(patients.id, TEST_PATIENT_ID))
  })
  afterEach(async () => {
    await getDb().update(patients).set({ portalPasswordHash: originalPortalPasswordHash }).where(eq(patients.id, TEST_PATIENT_ID))
  })

  it('returns 401 when there is no authenticated session', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce(UNAUTHORIZED())
    const res = await generatePortalPassword(new NextRequest('http://localhost', { method: 'POST' }), { params: Promise.resolve({ anonId: TEST_PATIENT_ID }) })
    expect(res.status).toBe(401)
  })

  it('rejects a non-admin session', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'crc', name: 'Test CRC', userId: null })
    const res = await generatePortalPassword(new NextRequest('http://localhost', { method: 'POST' }), { params: Promise.resolve({ anonId: TEST_PATIENT_ID }) })
    expect(res.status).toBe(403)
  })

  it('generates a real portal password and the patient can then log in with it', async () => {
    const res = await generatePortalPassword(new NextRequest('http://localhost', { method: 'POST' }), { params: Promise.resolve({ anonId: TEST_PATIENT_ID }) })
    expect(res.status).toBe(200)
    const { password } = await res.json()
    expect(typeof password).toBe('string')
    expect(password.length).toBeGreaterThan(5)

    const loginRes = await portalLogin(loginReq({ patientId: TEST_PATIENT_ID, password }))
    expect(loginRes.status).toBe(200)
  })

  it('revoking access makes the previously-issued password stop working', async () => {
    const genRes = await generatePortalPassword(new NextRequest('http://localhost', { method: 'POST' }), { params: Promise.resolve({ anonId: TEST_PATIENT_ID }) })
    const { password } = await genRes.json()

    const revokeRes = await revokePortalPassword(new NextRequest('http://localhost', { method: 'DELETE' }), { params: Promise.resolve({ anonId: TEST_PATIENT_ID }) })
    expect(revokeRes.status).toBe(200)

    const loginRes = await portalLogin(loginReq({ patientId: TEST_PATIENT_ID, password }))
    expect(loginRes.status).toBe(401)
  })
})

describe('POST /api/patient-portal/login', () => {
  it('rejects a patient id with no portal access provisioned', async () => {
    // RD-0002 never gets a portal password set anywhere in this suite.
    const res = await portalLogin(loginReq({ patientId: 'RD-0002', password: 'anything' }))
    expect(res.status).toBe(401)
  })

  it('rejects an unknown patient id the same way (never confirms which part was wrong)', async () => {
    const res = await portalLogin(loginReq({ patientId: 'RD-9999', password: 'anything' }))
    expect(res.status).toBe(401)
  })

  it('rejects a malformed payload', async () => {
    const res = await portalLogin(loginReq({ patientId: '' }))
    expect(res.status).toBe(400)
  })
})

describe('POST /api/patient-portal/login by email', () => {
  // Throwaway patients only -- never a real seeded patient's credentials.
  // A: unique email. B1/B2: two patients sharing one email (ambiguous), both
  // given the SAME valid password so a lookup that "picked one" would succeed.
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const ID_A = `RD-PORTAL-EMAIL-A-${suffix}`
  const ID_B1 = `RD-PORTAL-EMAIL-B1-${suffix}`
  const ID_B2 = `RD-PORTAL-EMAIL-B2-${suffix}`
  const EMAIL_A = `portal-email-a-${suffix}@example.test`
  const EMAIL_SHARED = `portal-email-shared-${suffix}@example.test`
  const PASSWORD = 'portal-email-test-pass-123'
  const GENERIC = { error: 'Invalid patient ID or password' }
  const ALL_IDS = [ID_A, ID_B1, ID_B2]

  beforeAll(async () => {
    const hash = hashPassword(PASSWORD)
    await getDb().insert(patients).values([
      { id: ID_A, name: 'Portal Email Test A', dob: '1990-01-01', email: EMAIL_A, portalPasswordHash: hash },
      { id: ID_B1, name: 'Portal Email Test B1', dob: '1990-01-01', email: EMAIL_SHARED, portalPasswordHash: hash },
      { id: ID_B2, name: 'Portal Email Test B2', dob: '1990-01-01', email: EMAIL_SHARED, portalPasswordHash: hash },
    ])
  }, 30000)

  afterAll(async () => {
    // Only the audit rows our own throwaway patients' logins produced.
    await getDb().delete(auditLog).where(and(inArray(auditLog.patientId, ALL_IDS), eq(auditLog.action, 'logged in to patient portal')))
    await getDb().delete(patients).where(inArray(patients.id, ALL_IDS))
  })

  afterEach(() => {
    vi.mocked(checkPatientLoginRateLimit).mockClear()
    vi.mocked(verifyPassword).mockClear()
  })

  it('(a) logs in with the email + valid portal password exactly like the patient id, auditing the resolved id', { timeout: 30000 }, async () => {
    const byId = await portalLogin(loginReq({ patientId: ID_A, password: PASSWORD }))
    expect(byId.status).toBe(200)
    const byIdBody = await byId.json()

    const byEmail = await portalLogin(loginReq({ patientId: EMAIL_A, password: PASSWORD }))
    expect(byEmail.status).toBe(200)
    expect(await byEmail.json()).toEqual(byIdBody)

    const rows = await getDb().select({ patientId: auditLog.patientId }).from(auditLog)
      .where(and(eq(auditLog.patientId, ID_A), eq(auditLog.action, 'logged in to patient portal')))
    expect(rows.length).toBe(2)
    const emailRows = await getDb().select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.patientId, EMAIL_A))
    expect(emailRows.length).toBe(0)
  })

  it('(b) rejects an email shared by two patients with the generic 401 -- never picks one', { timeout: 30000 }, async () => {
    const res = await portalLogin(loginReq({ patientId: EMAIL_SHARED, password: PASSWORD }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual(GENERIC)
  })

  it('(c) matches the email case-insensitively and trimmed', { timeout: 30000 }, async () => {
    const res = await portalLogin(loginReq({ patientId: `   ${EMAIL_A.toUpperCase()}  `, password: PASSWORD }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('(d) returns the identical generic 401 for unknown id, unknown email, ambiguous email and wrong password', { timeout: 60000 }, async () => {
    const attempts = [
      { patientId: `RD-PORTAL-NOPE-${suffix}`, password: PASSWORD },
      { patientId: `nobody-${suffix}@example.test`, password: PASSWORD },
      { patientId: EMAIL_SHARED, password: PASSWORD },
      { patientId: ID_A, password: 'wrong-password' },
      { patientId: EMAIL_A, password: 'wrong-password' },
    ]
    for (const body of attempts) {
      const res = await portalLogin(loginReq(body))
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual(GENERIC)
    }
  })

  it('(d) still runs one password verification when the email resolves to no patient or to several', { timeout: 30000 }, async () => {
    await portalLogin(loginReq({ patientId: `nobody-${suffix}@example.test`, password: PASSWORD }))
    expect(vi.mocked(verifyPassword)).toHaveBeenCalledTimes(1)
    vi.mocked(verifyPassword).mockClear()
    await portalLogin(loginReq({ patientId: EMAIL_SHARED, password: PASSWORD }))
    expect(vi.mocked(verifyPassword)).toHaveBeenCalledTimes(1)
  })

  it('(e) keys the rate limit on the normalized (trimmed, lowercased) identifier', { timeout: 30000 }, async () => {
    const req = (patientId: string) => new NextRequest('http://localhost/api/patient-portal/login', {
      method: 'POST', body: JSON.stringify({ patientId, password: 'wrong-password' }), headers: { 'x-forwarded-for': '198.51.100.7' },
    })
    await portalLogin(req(`  ${EMAIL_A.toUpperCase()} `))
    await portalLogin(req(EMAIL_A))
    // Each attempt checks the normalized identifier, then (because the
    // email resolved) the resolved patient id's own bucket.
    expect(vi.mocked(checkPatientLoginRateLimit).mock.calls).toEqual([
      ['198.51.100.7', EMAIL_A],
      ['198.51.100.7', ID_A.toLowerCase()],
      ['198.51.100.7', EMAIL_A],
      ['198.51.100.7', ID_A.toLowerCase()],
    ])
  })

  it('(e) email and patient id share the resolved patient\'s bucket: a denial there is a 429 with no password verification', async () => {
    vi.mocked(checkPatientLoginRateLimit)
      .mockResolvedValueOnce({ allowed: true }) // the email's own bucket
      .mockResolvedValueOnce({ allowed: false }) // the resolved patient id's bucket
    const res = await portalLogin(loginReq({ patientId: EMAIL_A, password: PASSWORD }))
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'Too many login attempts. Try again in a minute.' })
    expect(vi.mocked(verifyPassword)).not.toHaveBeenCalled()
  })

  it('(e) a login by patient id is checked once (its identifier already is the patient id bucket)', { timeout: 30000 }, async () => {
    await portalLogin(loginReq({ patientId: ID_A, password: 'wrong-password' }))
    expect(vi.mocked(checkPatientLoginRateLimit).mock.calls).toEqual([['unknown', ID_A.toLowerCase()]])
  })

  it('(e) an email that resolves to no patient is checked only on its own bucket', { timeout: 30000 }, async () => {
    const nobody = `nobody-${suffix}@example.test`
    await portalLogin(loginReq({ patientId: nobody, password: PASSWORD }))
    expect(vi.mocked(checkPatientLoginRateLimit).mock.calls).toEqual([['unknown', nobody]])
  })

  it('resolves the patient and its portal password hash in one query, by email or by id', { timeout: 30000 }, async () => {
    for (const identifier of [EMAIL_A, ID_A, EMAIL_SHARED, `nobody-${suffix}@example.test`]) {
      vi.mocked(getDb).mockClear()
      await verifyPatientPortalLogin(identifier, PASSWORD)
      expect(vi.mocked(getDb), identifier).toHaveBeenCalledTimes(1)
    }
    const candidate = await findPortalLoginCandidate(EMAIL_A)
    expect(candidate?.id).toBe(ID_A)
    expect(candidate?.portalPasswordHash).toBeTruthy()
    expect(await findPortalLoginCandidate(EMAIL_SHARED)).toBeNull()
  })

  it('(e) a rate-limited email attempt gets 429 without any password verification', async () => {
    vi.mocked(checkPatientLoginRateLimit).mockResolvedValueOnce({ allowed: false })
    const res = await portalLogin(loginReq({ patientId: EMAIL_A, password: PASSWORD }))
    expect(res.status).toBe(429)
    expect(vi.mocked(verifyPassword)).not.toHaveBeenCalled()
  })
})

describe('getPatientPortalData forms hasAttachedConsents', () => {
  const created: { fsc: number[]; submissions: number[]; templates: number[]; docs: number[] } = { fsc: [], submissions: [], templates: [], docs: [] }

  afterEach(async () => {
    const db = getDb()
    if (created.fsc.length) await db.delete(formSubmissionConsents).where(inArray(formSubmissionConsents.id, created.fsc))
    if (created.submissions.length) await db.delete(formSubmissions).where(inArray(formSubmissions.id, created.submissions))
    if (created.templates.length) await db.delete(formTemplates).where(inArray(formTemplates.id, created.templates))
    if (created.docs.length) await db.delete(consentDocuments).where(inArray(consentDocuments.id, created.docs))
    created.fsc = []; created.submissions = []; created.templates = []; created.docs = []
  })

  it('is true for a submission with a form_submission_consents row and false for one without', { timeout: 30000 }, async () => {
    const db = getDb()
    const [template] = await db.insert(formTemplates).values({ name: `Portal HAC Test ${Date.now()}`, category: 'Uncategorized', diagnosisTag: 'test', questions: [] }).returning()
    created.templates.push(template.id)
    const [doc] = await db.insert(consentDocuments).values({ name: `Portal HAC Test ${Date.now()}`, bodyText: 'x' }).returning()
    created.docs.push(doc.id)
    const [withConsent] = await db.insert(formSubmissions).values({ templateId: template.id, patientId: TEST_PATIENT_ID, status: 'sent' }).returning()
    const [without] = await db.insert(formSubmissions).values({ templateId: template.id, patientId: TEST_PATIENT_ID, status: 'sent' }).returning()
    created.submissions.push(withConsent.id, without.id)
    const [fsc] = await db.insert(formSubmissionConsents).values({ formSubmissionId: withConsent.id, consentDocumentId: doc.id }).returning()
    created.fsc.push(fsc.id)

    const data = await getPatientPortalData(TEST_PATIENT_ID)
    const withRow = data!.forms.find((f) => f.id === withConsent.id)
    const withoutRow = data!.forms.find((f) => f.id === without.id)
    expect(withRow?.hasAttachedConsents).toBe(true)
    expect(withoutRow?.hasAttachedConsents).toBe(false)
  })
})
