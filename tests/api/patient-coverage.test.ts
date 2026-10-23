// WS12 T2: GET /api/patients/[anonId]/coverage against the real query layer, real audit and
// real Postgres. Only the session is faked.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, coverageVerifications, nhcxEligibilityChecks } from '@/db/schema'
import type { Role } from '@/lib/auth'
import { ALL_ROLES, COVERAGE_READ_ROLES } from '@/lib/role-policy'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from '../db/rcm-fixtures'
import { purgeSp8Fixtures } from '../db/sp8-fixtures'
import { purgeCoverageFixtures } from '../db/ws12-fixtures'

const RUN = `${Date.now()}`.slice(-7)
const PROBE_USER = `TEST-WS12-cov-${RUN}`
let sessionRole: Role = 'frontdesk'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: PROBE_USER, userId: null })) }
})

import { GET } from '@/app/api/patients/[anonId]/coverage/route'

const get = (anonId: string, query = '') => GET(new NextRequest(`http://localhost/api/patients/${anonId}/coverage${query}`), { params: Promise.resolve({ anonId }) })

describe.skipIf(!process.env.DATABASE_URL)('GET /api/patients/[anonId]/coverage (DB)', () => {
  let b: RcmBase
  let checkId = 0
  beforeAll(async () => {
    b = await makeRcmBase(RUN, 'W12R')
    const [chk] = await getDb().insert(nhcxEligibilityChecks).values({
      patientId: b.patientId, policyId: b.policyId, payerId: b.insurerId, purpose: 'validation', context: 'checkin', status: 'eligible', inforce: true, requestedByName: 'Desk', isMock: true,
    }).returning()
    checkId = chk.id
    const verifiedAt = new Date(Date.now() - 10 * 60_000)
    await getDb().insert(coverageVerifications).values({
      patientId: b.patientId, policyId: b.policyId, source: 'nhcx_mock', result: 'active', context: 'checkin', nhcxCheckId: chk.id,
      insurerReference: `SECRETREF${RUN}`, verifiedByName: 'Desk', verifiedAt, validUntil: new Date(verifiedAt.getTime() + 24 * 3_600_000),
      sumInsuredPaise: 50_000_000, balancePaise: 45_000_000, copayBp: 1000, roomRentLimitPaise: 400_000, icuLimitPaise: 800_000, reportedValidTo: '2099-12-31',
    })
  })
  afterAll(async () => {
    await getDb().delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
    await purgeCoverageFixtures([b.patientId])
    await purgeSp8Fixtures([b.patientId])
    await purgeRcmFixtures([b.patientId], [b.insurerId, b.tpaId])
    await deleteRcmBasePatient(b.patientId)
  })

  it('returns the verdict verified_active with its label, ISO dates and limits, and audits the read', async () => {
    sessionRole = 'frontdesk'
    const res = await get(b.patientId)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.primary.verdict).toMatchObject({ state: 'verified_active', severity: 'ok', label: 'Policy valid, verified less than an hour ago', isMock: true })
    expect(body.primary.current).toMatchObject({ source: 'nhcx_mock', result: 'active', limits: { sumInsuredPaise: 50_000_000, balancePaise: 45_000_000, copayBp: 1000 } })
    expect(body.primary.current.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(body.primary.limits).toMatchObject({ roomRentLimitPaise: 400_000, icuLimitPaise: 800_000 })
    const text = JSON.stringify(body)
    expect(text).not.toMatch(/blob|http/i)
    expect(text).not.toContain(`SECRETREF${RUN}`)
    expect(text).not.toMatch(/nhcxCheckId|nhcx_check_id|insurerReference/)
    expect(body.primary.current.id).not.toBeUndefined()
    expect(checkId).toBeGreaterThan(0)
    const [a] = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE_USER), eq(auditLog.action, 'insurance: viewed coverage')))
    expect(a).toMatchObject({ patientId: b.patientId, details: 'context=view' })
  })

  it('takes the context from the query; refuses a bad context with 400 and an unknown patient with 404', async () => {
    sessionRole = 'rcm'
    const adm = await get(b.patientId, '?context=ipd_admission')
    expect(adm.status).toBe(200)
    expect((await adm.json()).primary.verdict.state).toBe('verified_active')
    expect((await get(b.patientId, '?context=preauth')).status).toBe(400)
    expect((await get(b.patientId, '?context=nonsense')).status).toBe(400)
    expect((await get(`NOPE-${RUN}`)).status).toBe(404)
  })

  it('is gated to COVERAGE_READ_ROLES with a fixed 403 body', async () => {
    for (const role of ALL_ROLES) {
      sessionRole = role
      const res = await get(b.patientId)
      if (COVERAGE_READ_ROLES.includes(role)) expect.soft(res.status, role).toBe(200)
      else {
        expect.soft(res.status, role).toBe(403)
        expect.soft(await res.json()).toEqual({ error: 'Forbidden' })
      }
    }
  })
})
