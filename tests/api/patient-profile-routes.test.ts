import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { Role } from '@/lib/auth'
import type { IdentitySnapshot } from '@/lib/patient-identity'

// No DB for the SP1 update routes: the query module, audit and cache are
// mocked, so this file proves each route's own contract (gate before parse,
// 400/404/409 shapes, no Aadhaar echo, cache bust). The identity route's two
// direct getDb() calls are stubbed below.
let sessionRole: Role = 'frontdesk'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: `Test ${sessionRole}`, userId: null })) }
})
vi.mock('@/lib/queries/patient-profile', () => ({
  getIdentitySnapshot: vi.fn(),
  updatePatientProfile: vi.fn(),
  replacePatientContacts: vi.fn(),
  upsertPatientAadhaar: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/cache', () => ({
  invalidateCache: vi.fn(async () => undefined),
  patientDetailCacheKey: vi.fn((id: string) => `patients:detail:${id}`),
  patientListCacheKey: vi.fn((t: string | null) => `patients:list:${t ?? 'all'}`),
  patientListCachePrefix: vi.fn(() => 'patients:list:'),
  workbookListCacheKey: vi.fn(() => 'workbook:list'),
  invalidateCacheByPrefix: vi.fn(async () => undefined),
}))
const dbInserts: unknown[] = []
// The identity route first checks the patient exists (Wave B P1-09): the
// patients select returns ANON's row, every other select returns nothing.
vi.mock('@/db/client', async () => {
  const schema = await vi.importActual<typeof import('@/db/schema')>('@/db/schema')
  return {
  getDb: () => ({
    select: () => ({ from: (t: unknown) => ({ where: async () => (t === schema.patients ? [{ id: 'RD-0001' }] : []) }) }),
    insert: () => ({ values: async (v: unknown) => { dbInserts.push(v) } }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  }),
  }
})

import * as auth from '@/lib/auth'
import { PATCH as patchProfile } from '@/app/api/patients/[anonId]/profile/route'
import { PUT as putContacts } from '@/app/api/patients/[anonId]/contacts/route'
import { PUT as putAadhaar } from '@/app/api/patients/[anonId]/aadhaar/route'
import { PUT as putIdentity } from '@/app/api/patients/[anonId]/identity/route'
import { getIdentitySnapshot, updatePatientProfile, replacePatientContacts, upsertPatientAadhaar } from '@/lib/queries/patient-profile'
import { invalidateCache, invalidateCacheByPrefix, patientDetailCacheKey, patientListCacheKey, workbookListCacheKey } from '@/lib/cache'

const AADHAAR_DIGITS = /2345|6789|0124/
const ANON = 'RD-0001'
const ctx = { params: Promise.resolve({ anonId: ANON }) }
const req = (method: 'PATCH' | 'PUT', path: string, body: unknown) =>
  new NextRequest(`http://localhost/api/patients/${ANON}/${path}`, { method, body: typeof body === 'string' ? body : JSON.stringify(body) })

const SNAPSHOT: IdentitySnapshot = {
  aadhaarStatus: 'declined', aadhaarDeclineReason: 'patient_declined',
  abhaNumber: null, abhaAddress: null, abhaUnavailableReason: 'not_created', isMlc: false,
}
const adult = { dob: '1990-01-01', snapshot: SNAPSHOT }

const uniqueViolation = (constraint: string) => Object.assign(new Error('insert failed'), { cause: { code: '23505', constraint } })

const consoleSpies: ReturnType<typeof vi.spyOn>[] = []
beforeEach(() => {
  vi.stubEnv('IDENTITY_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'))
  vi.mocked(getIdentitySnapshot).mockReset().mockResolvedValue(adult)
  vi.mocked(updatePatientProfile).mockReset().mockResolvedValue(true)
  vi.mocked(replacePatientContacts).mockReset().mockResolvedValue(undefined)
  vi.mocked(upsertPatientAadhaar).mockReset().mockResolvedValue(undefined)
  vi.mocked(invalidateCache).mockClear()
  dbInserts.length = 0
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) consoleSpies.push(vi.spyOn(console, m).mockImplementation(() => undefined))
})
afterEach(() => {
  sessionRole = 'frontdesk'
  vi.unstubAllEnvs()
  for (const s of consoleSpies.splice(0)) {
    expect(JSON.stringify(s.mock.calls)).not.toMatch(AADHAAR_DIGITS)
    s.mockRestore()
  }
})

describe('PATCH /api/patients/[anonId]/profile', () => {
  it('PATCH profile with an aadhaar key 400s and never calls updatePatientProfile', async () => {
    const res = await patchProfile(req('PATCH', 'profile', { city: 'Pune', aadhaar: { status: 'provided', number: '2345 6789 0124', consent: true } }), ctx)
    expect(res.status).toBe(400)
    expect(await res.text()).not.toMatch(AADHAAR_DIGITS)
    expect(updatePatientProfile).not.toHaveBeenCalled()
  })

  it('PATCH profile 403s pi, pharmacy, billing, labs with {error:"Forbidden"}', async () => {
    for (const role of ['pi', 'pharmacy', 'billing', 'labs', 'collector'] as const) {
      sessionRole = role
      const res = await patchProfile(req('PATCH', 'profile', '{not json'), ctx)
      expect(res.status, role).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(getIdentitySnapshot).not.toHaveBeenCalled()
    expect(updatePatientProfile).not.toHaveBeenCalled()
  })

  it('401s with no session before anything else', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const res = await patchProfile(req('PATCH', 'profile', { city: 'Pune' }), ctx)
    expect(res.status).toBe(401)
    expect(updatePatientProfile).not.toHaveBeenCalled()
  })

  it('PATCH profile maps patients_abha_address_unique to 409', async () => {
    vi.mocked(updatePatientProfile).mockRejectedValueOnce(uniqueViolation('patients_abha_address_unique'))
    const res = await patchProfile(req('PATCH', 'profile', { abha: { status: 'provided', abhaAddress: 'asha.rao@sbx' } }), ctx)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/ABHA address is already registered/)
    expect(invalidateCache).not.toHaveBeenCalled()
  })

  it('maps patients_abha_number_unique to 409', async () => {
    vi.mocked(updatePatientProfile).mockRejectedValueOnce(uniqueViolation('patients_abha_number_unique'))
    const res = await patchProfile(req('PATCH', 'profile', { abha: { status: 'provided', abhaNumber: '91-1111-2222-3333' } }), ctx)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/ABHA number is already registered/)
  })

  it('an unmapped failure is a generic 500 that logs only the pg code', async () => {
    vi.mocked(updatePatientProfile).mockRejectedValueOnce(Object.assign(new Error('boom city=Pune'), { cause: { code: '23514', constraint: 'x' } }))
    const res = await patchProfile(req('PATCH', 'profile', { city: 'Pune' }), ctx)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Update failed' })
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/Pune/)
  })

  it('404s for an unknown patient', async () => {
    vi.mocked(getIdentitySnapshot).mockResolvedValueOnce(null)
    const res = await patchProfile(req('PATCH', 'profile', { city: 'Pune' }), ctx)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
    expect(updatePatientProfile).not.toHaveBeenCalled()
  })

  it('404s when the patient disappears before the write', async () => {
    vi.mocked(updatePatientProfile).mockResolvedValueOnce(false)
    const res = await patchProfile(req('PATCH', 'profile', { city: 'Pune' }), ctx)
    expect(res.status).toBe(404)
    expect(invalidateCache).not.toHaveBeenCalled()
  })

  it('rejects an MLC number for a patient who is not (and will not be) MLC', async () => {
    const res = await patchProfile(req('PATCH', 'profile', { mlcNumber: 'MLC-1' }), ctx)
    expect(res.status).toBe(400)
    expect(updatePatientProfile).not.toHaveBeenCalled()
  })

  it('PATCH profile invalidates the patient detail cache', async () => {
    const res = await patchProfile(req('PATCH', 'profile', { city: 'Pune', isMlc: true, mlcNumber: 'MLC-1' }), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(updatePatientProfile).toHaveBeenCalledWith(ANON, { city: 'Pune', isMlc: true, mlcNumber: 'MLC-1' }, expect.objectContaining({ role: 'frontdesk' }))
    expect(invalidateCache).toHaveBeenCalledWith(patientDetailCacheKey('RD-0001'))
  })

  it('PATCH profile also invalidates every patient list cache (name/phone are cached there) and the workbook list', async () => {
    await patchProfile(req('PATCH', 'profile', { phone: '9876543210' }), ctx)
    expect(invalidateCache).toHaveBeenCalledWith(patientListCacheKey(null))
    expect(invalidateCacheByPrefix).toHaveBeenCalledWith('patients:list:')
    expect(invalidateCache).toHaveBeenCalledWith(workbookListCacheKey())
  })

  it('rejects name and dob (not editable after registration)', async () => {
    for (const body of [{ name: 'New Name' }, { dob: '1980-01-01' }]) {
      expect((await patchProfile(req('PATCH', 'profile', body), ctx)).status).toBe(400)
    }
    expect(updatePatientProfile).not.toHaveBeenCalled()
  })

  it('accepts null to clear optional fields, including a null MLC number for a non-MLC patient', async () => {
    const res = await patchProfile(req('PATCH', 'profile', { occupation: null, mlcNumber: null }), ctx)
    expect(res.status).toBe(200)
    expect(updatePatientProfile).toHaveBeenCalledWith(ANON, { occupation: null, mlcNumber: null }, expect.anything())
  })

  it('lets crc and admin edit the profile', async () => {
    for (const role of ['crc', 'admin'] as const) {
      sessionRole = role
      const res = await patchProfile(req('PATCH', 'profile', { city: 'Pune' }), ctx)
      expect(res.status, role).toBe(200)
    }
  })
})

describe('PUT /api/patients/[anonId]/contacts', () => {
  const guardian = { kind: 'guardian', name: 'Ravi Rao', relationship: 'parent', phone: '9876543210' }

  it('PUT contacts rejects removing the guardian of a minor', async () => {
    vi.mocked(getIdentitySnapshot).mockResolvedValueOnce({ dob: '2015-01-01', snapshot: SNAPSHOT })
    const res = await putContacts(req('PUT', 'contacts', { contacts: [] }), ctx)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'A guardian contact is required for a patient under 18' })
    expect(replacePatientContacts).not.toHaveBeenCalled()
  })

  it('replaces a minor\'s contacts when a guardian is kept', async () => {
    vi.mocked(getIdentitySnapshot).mockResolvedValueOnce({ dob: '2015-01-01', snapshot: SNAPSHOT })
    const res = await putContacts(req('PUT', 'contacts', { contacts: [guardian] }), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(replacePatientContacts).toHaveBeenCalledWith(ANON, [expect.objectContaining({ kind: 'guardian', phone: '+919876543210' })], expect.objectContaining({ role: 'frontdesk' }))
    expect(invalidateCache).toHaveBeenCalledWith(patientDetailCacheKey(ANON))
  })

  it('lets an adult have no contacts', async () => {
    const res = await putContacts(req('PUT', 'contacts', { contacts: [] }), ctx)
    expect(res.status).toBe(200)
    expect(replacePatientContacts).toHaveBeenCalledWith(ANON, [], expect.anything())
  })

  it('404s for an unknown patient', async () => {
    vi.mocked(getIdentitySnapshot).mockResolvedValueOnce(null)
    const res = await putContacts(req('PUT', 'contacts', { contacts: [] }), ctx)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  it('403s pi, pharmacy, billing, labs before parsing', async () => {
    for (const role of ['pi', 'pharmacy', 'billing', 'labs', 'collector'] as const) {
      sessionRole = role
      const res = await putContacts(req('PUT', 'contacts', '{not json'), ctx)
      expect(res.status, role).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(getIdentitySnapshot).not.toHaveBeenCalled()
  })

  it('400s an unknown key', async () => {
    const res = await putContacts(req('PUT', 'contacts', { contacts: [], extra: 1 }), ctx)
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/patients/[anonId]/aadhaar', () => {
  it('PUT aadhaar lets crc write and returns only the status', async () => {
    sessionRole = 'crc'
    const res = await putAadhaar(req('PUT', 'aadhaar', { status: 'provided', number: '234567890124', consent: true }), ctx)
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(JSON.parse(text)).toEqual({ status: 'on_file' })
    expect(text).not.toMatch(/0124/)
    const [anonId, row, session] = vi.mocked(upsertPatientAadhaar).mock.calls[0]
    expect(anonId).toBe(ANON)
    expect(row).toMatchObject({ patientId: ANON, aadhaarLast4: '0124', consentGiven: true, declineReason: null, recordedByName: 'Test crc' })
    expect(row.aadhaarEncrypted).toBeTruthy()
    expect(row.aadhaarEncrypted).not.toMatch(/234567890124/)
    expect(session).toMatchObject({ role: 'crc' })
    expect(invalidateCache).toHaveBeenCalledWith(patientDetailCacheKey(ANON))
  })

  it('PUT aadhaar 403s pi before reading the body', async () => {
    for (const role of ['pi', 'pharmacy', 'billing', 'labs', 'collector'] as const) {
      sessionRole = role
      const res = await putAadhaar(req('PUT', 'aadhaar', '{not json'), ctx)
      expect(res.status, role).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(getIdentitySnapshot).not.toHaveBeenCalled()
    expect(upsertPatientAadhaar).not.toHaveBeenCalled()
  })

  it('PUT aadhaar audits a decline with its reason and no digits', async () => {
    const res = await putAadhaar(req('PUT', 'aadhaar', { status: 'declined', reason: 'emergency' }), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'declined' })
    // The audit itself is written inside upsertPatientAadhaar's transaction
    // (DB test); the route hands it a decline row carrying the reason code
    // and nothing that could hold digits.
    const [, row, session] = vi.mocked(upsertPatientAadhaar).mock.calls[0]
    expect(row).toMatchObject({ aadhaarEncrypted: null, aadhaarLast4: null, consentGiven: false, declineReason: 'emergency', declineNote: null })
    expect(session).toMatchObject({ role: 'frontdesk' })
  })

  it('400s a bad checksum without echoing the digits', async () => {
    const res = await putAadhaar(req('PUT', 'aadhaar', { status: 'provided', number: '2345 6789 0125', consent: true }), ctx)
    expect(res.status).toBe(400)
    expect(await res.text()).not.toMatch(/2345|6789|0125/)
    expect(upsertPatientAadhaar).not.toHaveBeenCalled()
  })

  it('400s an extra key on either branch (strict)', async () => {
    for (const body of [
      { status: 'provided', number: '234567890124', consent: true, last4: '0124' },
      { status: 'declined', reason: 'emergency', number: '234567890124' },
    ]) {
      const res = await putAadhaar(req('PUT', 'aadhaar', body), ctx)
      expect(res.status).toBe(400)
      expect(await res.text()).not.toMatch(/0124/)
    }
    expect(upsertPatientAadhaar).not.toHaveBeenCalled()
  })

  it('400s an unparseable body', async () => {
    const res = await putAadhaar(req('PUT', 'aadhaar', '{not json'), ctx)
    expect(res.status).toBe(400)
  })

  it('404s for an unknown patient', async () => {
    vi.mocked(getIdentitySnapshot).mockResolvedValueOnce(null)
    const res = await putAadhaar(req('PUT', 'aadhaar', { status: 'declined', reason: 'emergency' }), ctx)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
    expect(upsertPatientAadhaar).not.toHaveBeenCalled()
  })

  it('an unmapped failure is a generic 500 with no digits anywhere', async () => {
    vi.mocked(upsertPatientAadhaar).mockRejectedValueOnce(Object.assign(new Error('params: 234567890124'), { cause: { code: '23514', constraint: 'patient_aadhaar_value_xor_decline' } }))
    const res = await putAadhaar(req('PUT', 'aadhaar', { status: 'provided', number: '234567890124', consent: true }), ctx)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Update failed' })
    expect(invalidateCache).not.toHaveBeenCalled()
  })
})

describe('PUT /api/patients/[anonId]/identity -- Indian KYC types', () => {
  it('PUT identity accepts voter_id and pan and rejects aadhaar as a KYC type', async () => {
    for (const idType of ['voter_id', 'pan']) {
      const res = await putIdentity(req('PUT', 'identity', { idType, idNumber: 'ABCDE1234F' }), ctx)
      expect(res.status, idType).toBe(200)
    }
    expect(dbInserts).toHaveLength(2)
    const res = await putIdentity(req('PUT', 'identity', { idType: 'aadhaar', idNumber: '234567890124' }), ctx)
    expect(res.status).toBe(400)
    expect(await res.text()).not.toMatch(/0124/)
    expect(dbInserts).toHaveLength(2)
  })
})
