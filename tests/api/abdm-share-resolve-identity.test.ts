import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq, inArray, sql } from 'drizzle-orm'

// WS12 T5 (spec R9): Scan & Share `linked` compares the shared profile with the chart. A
// mismatch without a reason is a 409 and the share stays pending; with a reason the link is
// recorded in abha_link_overrides and the audit carries field names only.

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: 'frontdesk', name: STAFF, userId: null })) }
})
vi.mock('@/lib/cache', () => ({ invalidateCache: vi.fn(async () => undefined), patientDetailCacheKey: (id: string) => `p:${id}` }))

import { getDb } from '@/db/client'
import { abdmProfileShares, abhaLinkOverrides, auditLog, patients } from '@/db/schema'
import { recordProfileShare, type ShareProfile } from '@/lib/queries/abdm-profile-shares'
import { POST } from '@/app/api/abdm/shares/[id]/route'
import { IDENTITY_MISMATCH_MESSAGE } from '@/lib/abdm/identity-match'

const RUN = `${Date.now()}`
const STAFF = `TEST-WS12T5-${RUN}`
const PREFIX = `TEST-WS12T5-${RUN}`
const abha = (n: number) => `91${(RUN.slice(-10) + String(n)).slice(-12).padStart(12, '0')}`
const createdPatients: string[] = []

const profile = (n: number): ShareProfile => ({
  abhaNumber: abha(n), abhaAddress: null, name: 'Asha Rao', gender: 'F', yearOfBirth: 1990, monthOfBirth: 3, dayOfBirth: 12,
  phone: null, addressLine: null, districtName: null, stateName: null, pincode: null,
})
async function makePatient(suffix: string, name: string): Promise<string> {
  const id = `TEST-WS12T5-${RUN.slice(-7)}-${suffix}`
  await getDb().insert(patients).values({ id, name, dob: '1990-03-12', gender: 'female' })
  createdPatients.push(id)
  return id
}
const share = async (n: number) => (await recordProfileShare({ requestId: `${PREFIX}-${n}`, hipId: 'HFR-1', counterId: `W${RUN.slice(-6)}`, intent: 'REGISTRATION', profile: profile(n), isMock: true })).shareId
const resolve = (id: number, body: unknown) =>
  POST(new NextRequest(`http://localhost/api/abdm/shares/${id}`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(id) }) })

describe.skipIf(!process.env.DATABASE_URL)('Scan & Share link identity guard (DB)', () => {
  let consoleSpies: ReturnType<typeof vi.spyOn>[] = []
  beforeEach(() => { consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {})) })
  afterEach(() => { for (const s of consoleSpies) s.mockRestore() })

  afterAll(async () => {
    const db = getDb()
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('hims.allow_document_purge', 'on', true)`)
      if (createdPatients.length > 0) await tx.delete(abhaLinkOverrides).where(inArray(abhaLinkOverrides.patientId, createdPatients))
    })
    await db.delete(abdmProfileShares).where(sql`${abdmProfileShares.requestId} like ${`${PREFIX}%`}`)
    await db.delete(auditLog).where(eq(auditLog.userName, STAFF))
    if (createdPatients.length > 0) {
      await db.delete(auditLog).where(inArray(auditLog.patientId, createdPatients))
      await db.delete(patients).where(inArray(patients.id, createdPatients))
    }
  })

  it('a share linked to a mismatched patient is a 409 and the share stays pending', async () => {
    const pid = await makePatient('A', 'Fathima Beevi')
    const id = await share(1)
    const r = await resolve(id, { action: 'linked', patientId: pid })
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: IDENTITY_MISMATCH_MESSAGE, code: 'identity_mismatch', fields: ['name'] })
    const [row] = await getDb().select().from(abdmProfileShares).where(eq(abdmProfileShares.id, id))
    expect(row.status).toBe('pending')
    const [p] = await getDb().select().from(patients).where(eq(patients.id, pid))
    expect(p.abhaNumber).toBeNull(); expect(p.abhaVerifiedAt).toBeNull()
  })

  it('with a reason the share links, the override row keeps the reason, the audit keeps field names only', async () => {
    const pid = await makePatient('B', 'Fathima Beevi')
    const id = await share(2)
    const reason = 'Known as Asha at home'
    const r = await resolve(id, { action: 'linked', patientId: pid, mismatchReason: reason })
    expect(r.status).toBe(200)
    const [row] = await getDb().select().from(abdmProfileShares).where(eq(abdmProfileShares.id, id))
    expect(row).toMatchObject({ status: 'linked', patientId: pid })
    const [p] = await getDb().select().from(patients).where(eq(patients.id, pid))
    expect(p).toMatchObject({ abhaNumber: abha(2), abhaVerifiedVia: 'scan_and_share', abhaVerificationSource: 'abdm_sandbox_mock' })
    const o = await getDb().select().from(abhaLinkOverrides).where(eq(abhaLinkOverrides.patientId, pid))
    expect(o).toHaveLength(1)
    expect(o[0]).toMatchObject({ via: 'scan_and_share', shareId: id, fields: ['name'], reason, byName: STAFF })
    const audit = await getDb().select({ action: auditLog.action, details: auditLog.details }).from(auditLog).where(eq(auditLog.patientId, pid))
    expect(audit.find((a) => a.action === 'abdm: linked ABHA despite identity mismatch')!.details).toBe('fields=name')
    const text = JSON.stringify([audit, consoleSpies.map((s) => s.mock.calls)])
    expect(text).not.toMatch(/Asha|Fathima|Known as/); expect(text).not.toContain(abha(2))
  })

  it('a matching patient links without a reason and no override row', async () => {
    const pid = await makePatient('C', 'Smt. ASHA rao')
    const id = await share(3)
    expect((await resolve(id, { action: 'linked', patientId: pid })).status).toBe(200)
    expect(await getDb().select().from(abhaLinkOverrides).where(eq(abhaLinkOverrides.patientId, pid))).toEqual([])
  })

  it('a reason under 10 characters is refused before anything is read', async () => {
    const pid = await makePatient('D', 'Fathima Beevi')
    const id = await share(4)
    expect((await resolve(id, { action: 'linked', patientId: pid, mismatchReason: 'short' })).status).toBe(400)
    const [row] = await getDb().select().from(abdmProfileShares).where(eq(abdmProfileShares.id, id))
    expect(row.status).toBe('pending')
  })
})
