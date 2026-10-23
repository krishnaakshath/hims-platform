import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq, inArray, sql } from 'drizzle-orm'

// WS12 T6 (spec R14): "Simulate ABHA share" exists only in mock mode. It writes an ordinary
// pending abdm_profile_shares row with is_mock = true, optionally copying a chart's identity.

let sessionRole = 'frontdesk'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: STAFF, userId: null })) }
})
vi.mock('@/lib/cache', () => ({ invalidateCache: vi.fn(async () => undefined), patientDetailCacheKey: (id: string) => `p:${id}` }))

import { getDb } from '@/db/client'
import { abdmProfileShares, abhaLinkOverrides, auditLog, patients } from '@/db/schema'
import { POST } from '@/app/api/abdm/shares/simulate/route'
import { POST as resolvePost } from '@/app/api/abdm/shares/[id]/route'
import { IDENTITY_MISMATCH_MESSAGE } from '@/lib/abdm/identity-match'

const RUN = `${Date.now()}`
const STAFF = `TEST-WS12T6-${RUN}`
const COUNTER = `T6${RUN.slice(-8)}`
const createdPatients: string[] = []

async function makePatient(suffix: string, name: string, gender: 'male' | 'female' | 'other', dob: string): Promise<string> {
  const id = `TEST-WS12T6-${RUN.slice(-7)}-${suffix}`
  await getDb().insert(patients).values({ id, name, dob, gender })
  createdPatients.push(id)
  return id
}
const simulate = (body: unknown) =>
  POST(new NextRequest('http://localhost/api/abdm/shares/simulate', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))
const shareRow = async (id: number) => (await getDb().select().from(abdmProfileShares).where(eq(abdmProfileShares.id, id)))[0]

describe.skipIf(!process.env.DATABASE_URL)('POST /api/abdm/shares/simulate (DB)', () => {
  let consoleSpies: ReturnType<typeof vi.spyOn>[] = []
  beforeEach(() => {
    sessionRole = 'frontdesk'
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('ABDM_USE_MOCKS', '1')
    consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
  })
  afterEach(() => { vi.unstubAllEnvs(); for (const s of consoleSpies) s.mockRestore() })

  afterAll(async () => {
    const db = getDb()
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('hims.allow_document_purge', 'on', true)`)
      if (createdPatients.length > 0) await tx.delete(abhaLinkOverrides).where(inArray(abhaLinkOverrides.patientId, createdPatients))
    })
    await db.delete(abdmProfileShares).where(eq(abdmProfileShares.counterId, COUNTER))
    await db.delete(auditLog).where(eq(auditLog.userName, STAFF))
    if (createdPatients.length > 0) {
      await db.delete(auditLog).where(inArray(auditLog.patientId, createdPatients))
      await db.delete(patients).where(inArray(patients.id, createdPatients))
    }
  })

  it('copies the chart identity from likePatientId into a pending mock share, audits ids only', async () => {
    const pid = await makePatient('A', 'Fathima Beevi', 'female', '1985-07-09')
    const r = await simulate({ counterId: COUNTER, likePatientId: pid })
    expect(r.status).toBe(201)
    const { shareId, tokenNumber } = await r.json()
    expect(tokenNumber).toBe(1)
    const row = await shareRow(shareId)
    expect(row).toMatchObject({ status: 'pending', isMock: true, ackState: 'pending', name: 'Fathima Beevi', gender: 'F', yearOfBirth: 1985, monthOfBirth: 7, dayOfBirth: 9, counterId: COUNTER })
    expect(row.abhaNumber).toMatch(/^91\d{12}$/)
    const audits = await getDb().select().from(auditLog).where(eq(auditLog.userName, STAFF))
    const a = audits.find((x) => x.action === 'abdm: simulated profile share')
    expect(a?.details).toBe(`share=${shareId} like_patient=yes`)
    expect(JSON.stringify(audits)).not.toContain('Fathima')
  })

  it('typed values: default name, no chart; a mismatching share then cannot be linked without a reason', async () => {
    const pid = await makePatient('B', 'Fathima Beevi', 'female', '1985-07-09')
    const r = await simulate({ counterId: COUNTER, name: 'Wrong Person', gender: 'M', yearOfBirth: 1970 })
    expect(r.status).toBe(201)
    const { shareId } = await r.json()
    expect(await shareRow(shareId)).toMatchObject({ name: 'Wrong Person', gender: 'M', yearOfBirth: 1970, isMock: true })
    const link = await resolvePost(new NextRequest(`http://localhost/api/abdm/shares/${shareId}`, { method: 'POST', body: JSON.stringify({ action: 'linked', patientId: pid }) }), { params: Promise.resolve({ id: String(shareId) }) })
    expect(link.status).toBe(409)
    expect((await link.json()).code).toBe('identity_mismatch')
    expect(IDENTITY_MISMATCH_MESSAGE).toBeTruthy()
    const d = await simulate({ counterId: COUNTER })
    const row = await shareRow((await d.json()).shareId)
    expect(row.name).toBe('Sandbox Mock Patient')
  })

  it('an unknown likePatientId is a 404 and writes nothing', async () => {
    const before = await getDb().select().from(abdmProfileShares).where(eq(abdmProfileShares.counterId, COUNTER))
    const r = await simulate({ counterId: COUNTER, likePatientId: 'NO-SUCH-PATIENT' })
    expect(r.status).toBe(404)
    const after = await getDb().select().from(abdmProfileShares).where(eq(abdmProfileShares.counterId, COUNTER))
    expect(after.length).toBe(before.length)
  })

  it('outside mock mode it is a 404 and writes no row', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('ABDM_USE_MOCKS', ''); vi.stubEnv('ALLOW_DEMO_MOCKS', '')
    const counter = `${COUNTER}X`
    const r = await simulate({ counterId: counter })
    expect(r.status).toBe(404)
    expect(await r.json()).toEqual({ error: 'Not found' })
    expect(await getDb().select().from(abdmProfileShares).where(eq(abdmProfileShares.counterId, counter))).toHaveLength(0)
  })

  it('pi is refused with 403 before the body is parsed', async () => {
    sessionRole = 'pi'
    expect((await simulate('{not json')).status).toBe(403)
  })

  it('frontdesk gets 400 for a malformed body and for unknown keys', async () => {
    expect((await simulate('{not json')).status).toBe(400)
    expect((await simulate({ counterId: COUNTER, extra: 1 })).status).toBe(400)
    expect((await simulate({ counterId: 'bad counter!' })).status).toBe(400)
  })
})
