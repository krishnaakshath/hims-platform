import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { Role } from '@/lib/auth'

// No DB: registerPatient, audit, cache and payer lookup are all mocked, so
// this file proves the route's own contract (gate order, 400/409/201 shapes,
// no echo of Aadhaar) independently of Postgres.
let sessionRole: Role = 'frontdesk'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: `Test ${sessionRole}`, userId: null })) }
})
vi.mock('@/lib/queries/patient-registration', () => ({ registerPatient: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/cache', () => ({ invalidateCache: vi.fn(async () => undefined), patientListCacheKey: vi.fn((t: string | null) => `patients:list:${t ?? 'all'}`) }))
vi.mock('@/lib/queries/payers', () => ({ getPayerById: vi.fn(async () => null) }))

import * as auth from '@/lib/auth'
import { POST } from '@/app/api/patients/route'
import { registerPatient } from '@/lib/queries/patient-registration'
import { logAudit } from '@/lib/audit'
import { invalidateCache } from '@/lib/cache'
import { getPayerById } from '@/lib/queries/payers'

const AADHAAR_DIGITS = /2345|6789|0124|0125/

// No 4-digit run in here overlaps the Aadhaar probes above.
const valid = (over: Record<string, unknown> = {}) => ({
  name: 'Asha Rao', dob: '1990-01-01', gender: 'female', addressLine1: '12 MG Road', city: 'Mumbai', district: 'Mumbai',
  stateCode: 'IN-MH', pinCode: '400001',
  aadhaar: { status: 'declined', reason: 'patient_declined' },
  abha: { status: 'unavailable', reason: 'not_created' },
  ...over,
})
const withAadhaar = (number: string) => valid({ aadhaar: { status: 'provided', number, consent: true } })

const req = (body: unknown) => new NextRequest('http://localhost/api/patients', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })

const consoleSpies: ReturnType<typeof vi.spyOn>[] = []
beforeEach(() => {
  vi.mocked(registerPatient).mockReset()
  vi.mocked(logAudit).mockClear()
  vi.mocked(invalidateCache).mockClear()
  vi.mocked(getPayerById).mockReset().mockResolvedValue(null)
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) consoleSpies.push(vi.spyOn(console, m).mockImplementation(() => undefined))
})
afterEach(() => {
  sessionRole = 'frontdesk'
  // Whatever the route logged, it never carried Aadhaar digits.
  for (const s of consoleSpies.splice(0)) {
    expect(JSON.stringify(s.mock.calls)).not.toMatch(AADHAAR_DIGITS)
    s.mockRestore()
  }
})

describe('POST /api/patients -- gate', () => {
  it('401s with no session before parsing', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const res = await POST(req(withAadhaar('2345 6789 0124')))
    expect(res.status).toBe(401)
    expect(registerPatient).not.toHaveBeenCalled()
  })

  it('403s crc, pi, pharmacy, billing, labs before parsing', async () => {
    for (const role of ['crc', 'pi', 'pharmacy', 'billing', 'labs', 'coder', 'rcm'] as const) {
      sessionRole = role
      // A body that is not even JSON: a 403 (not a 400/500) proves the gate runs first.
      const res = await POST(req('{not json'))
      expect(res.status, `role ${role}`).toBe(403)
      expect(await res.json(), `body for ${role}`).toEqual({ error: 'Forbidden' })
    }
    expect(registerPatient).not.toHaveBeenCalled()
    expect(getPayerById).not.toHaveBeenCalled()
  })
})

describe('POST /api/patients -- validation', () => {
  it('400 body never contains the submitted Aadhaar digits', async () => {
    const res = await POST(req({ ...valid(), aadhaar: { status: 'provided', number: '2345 6789 0125', consent: true } }))
    expect(res.status).toBe(400)
    expect(await res.text()).not.toMatch(/2345|6789|0125/)
    expect(registerPatient).not.toHaveBeenCalled()
  })

  it('400 body never echoes Aadhaar for a consent-less or note-embedded submission', async () => {
    for (const body of [
      valid({ aadhaar: { status: 'provided', number: '2345-6789-0124', consent: false } }),
      valid({ aadhaar: { status: 'declined', reason: 'other', note: 'card 2345 6789 0124' } }),
      valid({ abha: { status: 'unavailable', reason: 'other', note: '2345.6789.0124' } }),
    ]) {
      const res = await POST(req(body))
      expect(res.status).toBe(400)
      expect(await res.text()).not.toMatch(AADHAAR_DIGITS)
    }
    expect(registerPatient).not.toHaveBeenCalled()
  })

  it('400s a registration missing both Aadhaar and a decline reason', async () => {
    const body: Record<string, unknown> = valid(); delete body.aadhaar
    const res = await POST(req(body))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('Invalid registration')
    expect(json.details.fieldErrors).toHaveProperty('aadhaar')
    expect((await POST(req(valid({ aadhaar: { status: 'declined' } })))).status).toBe(400)
    expect(registerPatient).not.toHaveBeenCalled()
  })

  it('400s an unknown key (strict) and malformed JSON', async () => {
    expect((await POST(req(valid({ ssn: '123-45-6789' })))).status).toBe(400)
    expect((await POST(req('{not json'))).status).toBe(400)
    expect(registerPatient).not.toHaveBeenCalled()
  })

  it('400s an unknown primaryPayerId (existing behaviour)', async () => {
    const res = await POST(req(valid({ primaryPayerId: 999999 })))
    expect(res.status).toBe(400)
    expect(getPayerById).toHaveBeenCalledWith(999999)
    expect(registerPatient).not.toHaveBeenCalled()
  })
})

describe('POST /api/patients -- success', () => {
  // Audit rows are written by registerPatient inside its transaction (fix
  // round ruling 2), so the route itself writes none; the DB test proves the
  // rows and their rollback.
  it('returns 201 {id, uhid} only; audit happens inside registerPatient, not in the route', async () => {
    vi.mocked(registerPatient).mockResolvedValue({ id: 'RD-0100', uhid: 'UH000000427', auditEntries: [{ action: 'recorded Aadhaar with consent', details: null }] })
    const res = await POST(req(valid()))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: 'RD-0100', uhid: 'UH000000427' })
    expect(logAudit).not.toHaveBeenCalled()
  })

  it('hands registerPatient the normalised input and the session, then invalidates the list cache', async () => {
    vi.mocked(registerPatient).mockResolvedValue({ id: 'RD-0102', uhid: 'UH000000443', auditEntries: [{ action: 'recorded Aadhaar with consent', details: null }] })
    sessionRole = 'admin'
    const res = await POST(req(withAadhaar('2345 6789 0124')))
    expect(res.status).toBe(201)
    const [input, session] = vi.mocked(registerPatient).mock.calls[0]
    expect(input.aadhaar).toEqual({ status: 'provided', number: '234567890124', consent: true })
    expect(session).toMatchObject({ role: 'admin', name: 'Test admin' })
    expect(await res.text()).not.toMatch(AADHAAR_DIGITS)
    expect(invalidateCache).toHaveBeenCalledWith('patients:list:all')
    expect(vi.mocked(invalidateCache).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(registerPatient).mock.invocationCallOrder[0])
  })

  it('a cache invalidation failure after commit still returns 201 and logs only the error class', async () => {
    vi.mocked(registerPatient).mockResolvedValue({ id: 'RD-0104', uhid: 'UH000000468', auditEntries: [] })
    vi.mocked(invalidateCache).mockRejectedValueOnce(new TypeError('redis down at secret-host:6379 for RD-0104'))
    const res = await POST(req(valid()))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: 'RD-0104', uhid: 'UH000000468' })
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls)
    expect(logged).toContain('TypeError')
    expect(logged).not.toContain('secret-host')
  })

  it('checks a real payer and lets the registration through', async () => {
    vi.mocked(getPayerById).mockResolvedValue({ id: 3 } as never)
    vi.mocked(registerPatient).mockResolvedValue({ id: 'RD-0103', uhid: 'UH000000450', auditEntries: [] })
    expect((await POST(req(valid({ primaryPayerId: 3 })))).status).toBe(201)
  })
})

describe('POST /api/patients -- failures', () => {
  it('maps a unique violation on patients_abha_number_unique to 409', async () => {
    vi.mocked(registerPatient).mockRejectedValue({ message: 'Failed query', cause: { code: '23505', constraint: 'patients_abha_number_unique' } })
    const res = await POST(req(valid()))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'This ABHA number is already registered to another patient' })
  })

  it('maps a unique violation on patients_abha_address_unique to 409', async () => {
    vi.mocked(registerPatient).mockRejectedValue({ message: 'Failed query', cause: { code: '23505', constraint: 'patients_abha_address_unique' } })
    const res = await POST(req(valid()))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'This ABHA address is already registered to another patient' })
  })

  it('any other failure is a generic 500 that echoes nothing (no audit, no cache bust)', async () => {
    // A drizzle-style error whose message carries the query params.
    vi.mocked(registerPatient).mockRejectedValue(Object.assign(new Error('Failed query: insert ...\nparams: 234567890124,Asha Rao'), { cause: { code: '23514', constraint: 'patient_aadhaar_value_xor_decline' } }))
    const res = await POST(req(withAadhaar('2345 6789 0124')))
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: 'Registration failed' })
    expect(text).not.toMatch(AADHAAR_DIGITS)
    expect(logAudit).not.toHaveBeenCalled()
    expect(invalidateCache).not.toHaveBeenCalled()
  })

  it('a unique violation on any other constraint is not reported as an ABHA duplicate', async () => {
    vi.mocked(registerPatient).mockRejectedValue({ message: 'Failed query', cause: { code: '23505', constraint: 'patients_pkey' } })
    const res = await POST(req(valid()))
    expect(res.status).toBe(500)
  })
})
