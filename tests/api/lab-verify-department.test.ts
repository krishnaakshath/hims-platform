// WS4 T11 (spec 3.4): verification by the test's reporting department, and the doctor's
// acknowledgement / co-sign routes (real DB, session mocked). The departments mirror the seed:
// a pathologist (labs role) linked to Laboratory, a radiologist (labs role) linked to Radiology,
// ordering doctors (pi) linked to General Medicine, and an admin with no staff link.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq, inArray } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import type { Session } from '@/lib/auth'

const h = vi.hoisted(() => ({ session: null as unknown as Session }))
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => h.session) }))
vi.mock('@/lib/queries/hospital-kpis', () => ({
  invalidateLabKpis: vi.fn(async () => undefined),
  invalidateDoctorWorkloadCache: vi.fn(async () => undefined),
}))

import { getDb } from '@/db/client'
import { auditLog, labOrders, labResultSignoffs, labResults, labTests, patients, users } from '@/db/schema'
import { invalidateDoctorWorkloadCache, invalidateLabKpis } from '@/lib/queries/hospital-kpis'
import { VERIFY_DENIAL_MESSAGE } from '@/lib/labs/verification'
import { POST as VERIFY } from '@/app/api/lab-orders/[id]/verify/route'
import { POST as ACKNOWLEDGE } from '@/app/api/lab-orders/[id]/acknowledge/route'
import { POST as COSIGN } from '@/app/api/lab-orders/[id]/cosign/route'
import { createLabDepartmentFixture, type LabDepartmentFixture } from '../db/lab-verifier-fixtures'

const TAG = randomBytes(4).toString('hex').toUpperCase()
const PID = `TEST-WS4T11R-${TAG}`
const N = {
  tech: `TEST_WS4T11R Tech ${TAG}`,
  pathologist: `TEST_WS4T11R Dr Pathologist ${TAG}`,
  radiologist: `TEST_WS4T11R Dr Radiologist ${TAG}`,
  ordering: `TEST_WS4T11R Dr Ordering ${TAG}`,
  other: `TEST_WS4T11R Dr Other ${TAG}`,
  admin: `TEST_WS4T11R Admin ${TAG}`,
}
const ROLE: Record<keyof typeof N, Session['role']> = { tech: 'labs', pathologist: 'labs', radiologist: 'labs', ordering: 'pi', other: 'pi', admin: 'admin' }
const uid: Partial<Record<keyof typeof N, number>> = {}
const as = (who: keyof typeof N) => { h.session = { role: ROLE[who], name: N[who], userId: uid[who]! } }

let lab: LabDepartmentFixture
let radio: LabDepartmentFixture
let gen: LabDepartmentFixture
let cbcTestId = 0
let xrayTestId = 0
let orderingProvider = 0
const orderIds: number[] = []

const post = (body?: unknown) => new NextRequest('http://localhost/api/lab-orders/x', { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) })

async function order(labTestId: number, status: 'resulted' | 'verified' = 'resulted') {
  const db = getDb()
  const [o] = await db.insert(labOrders).values({ patientId: PID, labTestId, orderedByProviderId: orderingProvider, status }).returning()
  orderIds.push(o.id)
  await db.insert(labResults).values({ labOrderId: o.id, value: '5.0', flag: 'normal', resultedByName: N.tech, resultedByUserId: uid.tech })
  return o.id
}
const statusOf = async (id: number) => (await getDb().select({ s: labOrders.status }).from(labOrders).where(eq(labOrders.id, id)))[0].s

beforeEach(() => {
  vi.mocked(invalidateLabKpis).mockClear()
  vi.mocked(invalidateDoctorWorkloadCache).mockClear()
})

describe.skipIf(!process.env.DATABASE_URL)('lab verification by department and doctor sign-offs (routes, DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values({ id: PID, name: 'TEST_WS4T11R Patient', dob: '1980-01-01' })
    const keys = Object.keys(N) as (keyof typeof N)[]
    const us = await db.insert(users).values(keys.map((k) => ({ name: N[k], email: `test-ws4t11r-${TAG.toLowerCase()}-${k}@example.invalid`, role: ROLE[k] }))).returning()
    for (const k of keys) uid[k] = us.find((u) => u.name === N[k])!.id
    lab = await createLabDepartmentFixture(`RL${TAG}`)
    radio = await createLabDepartmentFixture(`RR${TAG}`)
    gen = await createLabDepartmentFixture(`RG${TAG}`)
    const [cbc, xray] = await db.insert(labTests).values([
      { name: `TEST_WS4T11R CBC ${TAG}`, code: `TEST-WS4T11R-CBC-${TAG}` },
      { name: `TEST_WS4T11R X-ray chest ${TAG}`, code: `TEST-WS4T11R-XR-${TAG}`, category: 'imaging' },
    ]).returning()
    cbcTestId = cbc.id
    xrayTestId = xray.id
    await lab.mapTests([cbcTestId])
    await radio.mapTests([xrayTestId])
    await lab.linkUsers([uid.pathologist!], `TEST_WS4T11R Dr Path prov ${TAG}`)
    await radio.linkUsers([uid.radiologist!], `TEST_WS4T11R Dr Radio prov ${TAG}`)
    orderingProvider = await gen.linkUsers([uid.ordering!], `TEST_WS4T11R Dr Ordering prov ${TAG}`)
    await gen.linkUsers([uid.other!], `TEST_WS4T11R Dr Other prov ${TAG}`)
  })

  afterAll(async () => {
    const db = getDb()
    if (orderIds.length) {
      await db.delete(labResults).where(inArray(labResults.labOrderId, orderIds))
      await db.delete(labOrders).where(inArray(labOrders.id, orderIds))
    }
    await db.delete(auditLog).where(inArray(auditLog.userName, Object.values(N)))
    for (const f of [lab, radio, gen]) await f?.cleanup()
    await db.delete(labTests).where(inArray(labTests.id, [cbcTestId, xrayTestId]))
    await db.delete(users).where(inArray(users.id, Object.values(uid) as number[]))
    await db.delete(patients).where(eq(patients.id, PID))
  }, 60_000)

  it('the pathologist (labs, linked to Laboratory) verifies a CBC: 200, and the lab KPIs are refreshed', async () => {
    const id = await order(cbcTestId)
    as('pathologist')
    const res = await VERIFY(post(), ctx(id))
    expect(res.status).toBe(200)
    expect(await statusOf(id)).toBe('verified')
    expect(invalidateLabKpis).toHaveBeenCalledTimes(1)
  })

  it('the ordering doctor (pi, General Medicine) may not verify a CBC: 403 wrong_department', async () => {
    const id = await order(cbcTestId)
    as('ordering')
    const res = await VERIFY(post(), ctx(id))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: VERIFY_DENIAL_MESSAGE.wrong_department, code: 'wrong_department' })
    expect(await statusOf(id)).toBe('resulted')
    expect(invalidateLabKpis).not.toHaveBeenCalled()
  })

  it('admin without a staff link has no implicit right: 403 not_linked', async () => {
    const id = await order(cbcTestId)
    as('admin')
    const res = await VERIFY(post(), ctx(id))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error: 'Verification needs a pathologist or reporting specialist account linked to a provider. Settings → Staff.', code: 'not_linked',
    })
  })

  it('an unlinked lab technician is not_linked; the one who entered the result cannot verify it (409)', async () => {
    const id = await order(cbcTestId)
    as('tech')
    expect((await (await VERIFY(post(), ctx(id))).json()).code).toBe('not_linked')
    // The pathologist amends nothing here, but a result entered by the pathologist themselves:
    await getDb().update(labResults).set({ resultedByUserId: uid.pathologist }).where(eq(labResults.labOrderId, id))
    as('pathologist')
    const res = await VERIFY(post(), ctx(id))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe(VERIFY_DENIAL_MESSAGE.self_verification)
  })

  it('imaging is verified by the radiologist, not by the pathologist', async () => {
    const id = await order(xrayTestId)
    as('pathologist')
    expect((await (await VERIFY(post(), ctx(id))).json()).code).toBe('wrong_department')
    as('radiologist')
    expect((await VERIFY(post(), ctx(id))).status).toBe(200)
    expect(await statusOf(id)).toBe('verified')
  })

  it('acknowledge: the ordering doctor 201, twice 409 already_signed, another doctor 403 not_owner', async () => {
    const id = await order(cbcTestId, 'verified')
    as('ordering')
    const first = await ACKNOWLEDGE(post({ note: 'Reviewed with the patient' }), ctx(id))
    expect(first.status).toBe(201)
    expect(await first.json()).toEqual({ ok: true })
    expect(invalidateDoctorWorkloadCache).toHaveBeenCalledWith(orderingProvider, N.ordering)
    expect(invalidateLabKpis).toHaveBeenCalled()
    const again = await ACKNOWLEDGE(post(), ctx(id)) // an empty body is an acknowledgement without a note
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ code: 'already_signed' })
    as('other')
    const other = await ACKNOWLEDGE(post({}), ctx(id))
    expect(other.status).toBe(403)
    expect(await other.json()).toMatchObject({ code: 'not_owner' })
    const rows = await getDb().select().from(labResultSignoffs).where(eq(labResultSignoffs.labOrderId, id))
    expect(rows.map((r) => [r.kind, r.signedByName])).toEqual([['acknowledge', N.ordering]])
  })

  it('co-sign: before verification 409 not_verified; a wrong typed name 403 name_mismatch; the right name 201', async () => {
    as('ordering')
    const pending = await order(cbcTestId)
    const early = await COSIGN(post({ typedName: N.ordering }), ctx(pending))
    expect(early.status).toBe(409)
    expect(await early.json()).toMatchObject({ code: 'not_verified' })
    const id = await order(cbcTestId, 'verified')
    const wrong = await COSIGN(post({ typedName: 'Dr. Somebody Else' }), ctx(id))
    expect(wrong.status).toBe(403)
    const body = await wrong.json()
    expect(body).toMatchObject({ code: 'name_mismatch' })
    expect(JSON.stringify(body)).not.toContain('Somebody')
    expect((await COSIGN(post({ typedName: N.ordering, note: 'Agree' }), ctx(id))).status).toBe(201)
    expect((await COSIGN(post({ typedName: N.ordering }), ctx(id))).status).toBe(409)
  })

  it('strict bodies: unknown keys, a long note and a missing typed name are 400 without echo; bad id 400; unknown order 404', async () => {
    as('ordering')
    const id = await order(cbcTestId, 'verified')
    for (const res of [
      await ACKNOWLEDGE(post({ note: 'x', extra: 'INJECT' }), ctx(id)),
      await ACKNOWLEDGE(post({ note: 'y'.repeat(301) }), ctx(id)),
      await COSIGN(post({ note: 'INJECT' }), ctx(id)),
      await COSIGN(post({ typedName: 'z'.repeat(121) }), ctx(id)),
    ]) {
      expect(res.status).toBe(400)
      expect(JSON.stringify(await res.json())).not.toMatch(/INJECT|yyyy|zzzz/)
    }
    expect((await ACKNOWLEDGE(post({}), { params: Promise.resolve({ id: 'abc' }) })).status).toBe(400)
    expect((await ACKNOWLEDGE(post({}), ctx(2_000_000_000))).status).toBe(404)
  })

  it('roles outside LAB_SIGNOFF_ROLES are refused before the body is read', async () => {
    as('pathologist')
    const bad = new NextRequest('http://localhost/x', { method: 'POST', body: '{not json' })
    const res = await ACKNOWLEDGE(bad, ctx(1))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })

  it('audits ids only for sign-offs', async () => {
    as('ordering')
    const id = await order(cbcTestId, 'verified')
    expect((await COSIGN(post({ typedName: N.ordering, note: 'SECRET NOTE' }), ctx(id))).status).toBe(201)
    const audits = await getDb().select().from(auditLog).where(eq(auditLog.userName, N.ordering))
    const cosign = audits.filter((a) => a.action === 'co-signed lab result')
    expect(cosign.some((a) => a.details?.startsWith(`order=${id} `))).toBe(true)
    expect(JSON.stringify(audits)).not.toContain('SECRET')
  })
})
