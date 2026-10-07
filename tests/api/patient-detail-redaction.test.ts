import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'
import type { AadhaarSummary } from '@/lib/patient-identity'

// GET /api/patients/[anonId] serves the cached detail object, which carries
// the Aadhaar SUMMARY (last4 included). The route must turn it into the
// role-appropriate VIEW before it goes on the wire: admin/crc get the masked
// value (and decline reason), every other clinical role the status alone.
let sessionRole: Role = 'pi'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: `Test ${sessionRole}`, userId: null })) }
})
vi.mock('@/lib/queries/patients', () => ({ getPatientDetail: vi.fn(), deletePatient: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))

import { GET } from '@/app/api/patients/[anonId]/route'
import { getPatientDetail } from '@/lib/queries/patients'

const ON_FILE: AadhaarSummary = { status: 'on_file', last4: '0124', declineReason: null, consentRecordedAt: new Date('2026-10-07T05:00:00Z'), recordedByName: 'Asha Rao' }
const DECLINED: AadhaarSummary = { status: 'declined', last4: null, declineReason: 'emergency', consentRecordedAt: null, recordedByName: 'Asha Rao' }

function detail(aadhaar: AadhaarSummary) {
  return {
    id: 'RD-0001', uhid: 'UH000000427', name: 'Ravi Kumar', dob: '1990-01-01',
    contacts: [{ id: 1, patientId: 'RD-0001', kind: 'emergency', name: 'Sita Kumar', relationship: 'spouse', phone: '+919876543210', addressText: null, isPrimary: true, createdAt: new Date() }],
    aadhaar,
  }
}

const call = async () => {
  const res = await GET(new NextRequest('http://localhost/api/patients/RD-0001'), { params: Promise.resolve({ anonId: 'RD-0001' }) })
  const text = await res.text()
  return { res, text, body: JSON.parse(text) }
}

beforeEach(() => {
  vi.mocked(getPatientDetail).mockReset().mockResolvedValue(detail(ON_FILE) as never)
})
afterEach(() => { sessionRole = 'pi' })

describe('GET /api/patients/[anonId] Aadhaar redaction', () => {
  it('GET /api/patients/[anonId] gives pi the status without last4', async () => {
    sessionRole = 'pi'
    const { res, text, body } = await call()
    expect(res.status).toBe(200)
    expect(body.aadhaar).toEqual({ status: 'on_file', masked: null, declineReason: null })
    expect(text).not.toContain('0124')
    expect(text).not.toMatch(/last4|recordedByName|consentRecordedAt|aadhaarEncrypted/)
    expect(body.contacts).toHaveLength(1)
  })

  it('GET /api/patients/[anonId] gives crc the masked value', async () => {
    sessionRole = 'crc'
    const { body, text } = await call()
    expect(body.aadhaar).toEqual({ status: 'on_file', masked: 'XXXX XXXX 0124', declineReason: null })
    // Only in masked form: never a bare last4 field or a longer digit run.
    expect(text.match(/0124/g)).toHaveLength(1)
    expect(text).not.toMatch(/last4|aadhaarEncrypted/)
  })

  it('gives admin the masked value', async () => {
    sessionRole = 'admin'
    expect((await call()).body.aadhaar).toEqual({ status: 'on_file', masked: 'XXXX XXXX 0124', declineReason: null })
  })

  it.each(['pi', 'admin', 'crc'] as const)('a decline: %s sees the reason only if admin/crc', async (role) => {
    sessionRole = role
    vi.mocked(getPatientDetail).mockResolvedValue(detail(DECLINED) as never)
    const { body, text } = await call()
    const shows = role === 'admin' || role === 'crc'
    expect(body.aadhaar).toEqual({ status: 'declined', masked: null, declineReason: shows ? 'emergency' : null })
    // ('emergency' is also a contact kind, so check outside the contacts list.)
    if (!shows) expect(text.replace(/"kind":"emergency"/g, '')).not.toContain('emergency')
  })

  it('a not-recorded patient shows the status alone', async () => {
    sessionRole = 'crc'
    vi.mocked(getPatientDetail).mockResolvedValue(detail({ status: 'not_recorded', last4: null, declineReason: null, consentRecordedAt: null, recordedByName: null }) as never)
    expect((await call()).body.aadhaar).toEqual({ status: 'not_recorded', masked: null, declineReason: null })
  })

  it('frontdesk (non-clinical) is still 403 and the query never runs', async () => {
    sessionRole = 'frontdesk'
    const res = await GET(new NextRequest('http://localhost/api/patients/RD-0001'), { params: Promise.resolve({ anonId: 'RD-0001' }) })
    expect(res.status).toBe(403)
    expect(getPatientDetail).not.toHaveBeenCalled()
  })
})
