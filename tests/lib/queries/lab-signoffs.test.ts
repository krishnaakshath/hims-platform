// WS4 T11: verifier department resolution and the doctor's acknowledgement / co-sign (DB).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { getDb } from '@/db/client'
import { admissions, auditLog, labOrders, labResultSignoffs, labResults, labTests, patients, providers, staffMembers, users } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { listSignoffs, resolveVerifierDepartmentId, sameSignatureName, signOffLabResult } from '@/lib/queries/lab-signoffs'
import { createLabDepartmentFixture, type LabDepartmentFixture } from '../../db/lab-verifier-fixtures'

const TAG = randomBytes(4).toString('hex').toUpperCase()
const PID = `TEST-WS4T11Q-${TAG}`
const PID_ADMITTED = `TEST-WS4T11Q-${TAG}-A`
const NAME_ORDERING = `TEST_WS4T11Q Dr Ordering ${TAG}`
const NAME_ATTENDING = `TEST_WS4T11Q Dr Attending ${TAG}`
const NAME_OTHER = `TEST_WS4T11Q Dr Other ${TAG}`
const NAME_PATH = `TEST_WS4T11Q Pathologist ${TAG}`
const NAMES = [NAME_ORDERING, NAME_ATTENDING, NAME_OTHER, NAME_PATH]
const NOW = new Date('2099-06-01T05:00:00Z')

let lab: LabDepartmentFixture
let gen: LabDepartmentFixture
let testId = 0
let orderingProvider = 0
let attendingProvider = 0
const userIds: Record<string, number> = {}
const orderIds: number[] = []
let admissionId = 0
const session = (name: string): Session => ({ role: 'pi', name, userId: userIds[name] })

async function order(status: 'received' | 'resulted' | 'verified' | 'reported', patientId = PID) {
  const db = getDb()
  const [o] = await db.insert(labOrders).values({ patientId, labTestId: testId, orderedByProviderId: orderingProvider, status }).returning()
  orderIds.push(o.id)
  if (status !== 'received') await db.insert(labResults).values({ labOrderId: o.id, value: '5.0', flag: 'normal', resultedByName: 'TEST tech' })
  return o.id
}

describe.skipIf(!process.env.DATABASE_URL)('lab sign-offs (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values([
      { id: PID, name: 'TEST_WS4T11Q Patient', dob: '1980-01-01' },
      { id: PID_ADMITTED, name: 'TEST_WS4T11Q Inpatient', dob: '1981-01-01' },
    ])
    const us = await db.insert(users).values(NAMES.map((name, i) => ({ name, email: `test-ws4t11q-${TAG.toLowerCase()}-${i}@example.invalid`, role: i === 3 ? 'labs' as const : 'pi' as const }))).returning()
    for (const u of us) userIds[u.name] = u.id
    lab = await createLabDepartmentFixture(`QL${TAG}`)
    gen = await createLabDepartmentFixture(`QG${TAG}`)
    const [t] = await db.insert(labTests).values({ name: `TEST_WS4T11Q CBC ${TAG}`, code: `TEST-WS4T11Q-${TAG}` }).returning()
    testId = t.id
    await lab.mapTests([testId])
    await lab.linkUsers([userIds[NAME_PATH]], `TEST_WS4T11Q Dr Path ${TAG}`)
    orderingProvider = await gen.linkUsers([userIds[NAME_ORDERING]], `TEST_WS4T11Q Dr Ordering prov ${TAG}`)
    attendingProvider = await gen.linkUsers([userIds[NAME_ATTENDING]], `TEST_WS4T11Q Dr Attending prov ${TAG}`)
    await gen.linkUsers([userIds[NAME_OTHER]], `TEST_WS4T11Q Dr Other prov ${TAG}`)
    const [a] = await db.insert(admissions).values({ patientId: PID_ADMITTED, attendingProviderId: attendingProvider, status: 'admitted' }).returning()
    admissionId = a.id
  })

  afterAll(async () => {
    const db = getDb()
    if (orderIds.length) {
      await db.delete(labResults).where(inArray(labResults.labOrderId, orderIds))
      await db.delete(labOrders).where(inArray(labOrders.id, orderIds)) // sign-offs cascade
    }
    if (admissionId) await db.delete(admissions).where(eq(admissions.id, admissionId))
    await db.delete(auditLog).where(inArray(auditLog.userName, NAMES))
    await lab?.cleanup()
    await gen?.cleanup()
    await db.delete(labTests).where(eq(labTests.id, testId))
    await db.delete(users).where(inArray(users.id, Object.values(userIds)))
    await db.delete(patients).where(inArray(patients.id, [PID, PID_ADMITTED]))
  }, 60_000)

  it('resolveVerifierDepartmentId follows the staff link only', async () => {
    expect(await resolveVerifierDepartmentId({ role: 'labs', name: NAME_PATH, userId: userIds[NAME_PATH] })).toBe(lab.departmentId)
    expect(await resolveVerifierDepartmentId(session(NAME_ORDERING))).toBe(gen.departmentId)
    // No user id (env admin), or a name that equals a provider's name but has no link: null.
    expect(await resolveVerifierDepartmentId({ role: 'admin', name: `TEST_WS4T11Q Dr Path ${TAG}`, userId: null })).toBeNull()
    // A staff link that is no longer active does not count.
    await getDb().update(staffMembers).set({ employmentStatus: 'terminated' }).where(eq(staffMembers.userId, userIds[NAME_PATH]))
    expect(await resolveVerifierDepartmentId({ role: 'labs', name: NAME_PATH, userId: userIds[NAME_PATH] })).toBeNull()
    await getDb().update(staffMembers).set({ employmentStatus: 'active' }).where(eq(staffMembers.userId, userIds[NAME_PATH]))
  })

  it('the ordering doctor acknowledges once; a repeat is already_signed; another doctor is not_owner', async () => {
    const id = await order('verified')
    expect(await signOffLabResult(id, 'acknowledge', { note: 'Seen, continue plan' }, session(NAME_ORDERING), NOW)).toEqual({ ok: true, providerId: orderingProvider })
    expect(await signOffLabResult(id, 'acknowledge', { note: null }, session(NAME_ORDERING), NOW)).toEqual({ ok: false, error: 'already_signed' })
    expect(await signOffLabResult(id, 'acknowledge', { note: null }, session(NAME_OTHER), NOW)).toEqual({ ok: false, error: 'not_owner' })
    // An unlinked session is never an owner.
    expect(await signOffLabResult(id, 'acknowledge', { note: null }, { role: 'admin', name: NAME_ORDERING, userId: null }, NOW)).toEqual({ ok: false, error: 'not_owner' })
    const [row] = await getDb().select().from(labResultSignoffs).where(eq(labResultSignoffs.labOrderId, id))
    expect(row).toMatchObject({ kind: 'acknowledge', providerId: orderingProvider, userId: userIds[NAME_ORDERING], signedByName: NAME_ORDERING, note: 'Seen, continue plan' })
    expect(row.signedAt.getTime()).toBe(NOW.getTime())
    // Audit: ids only, never the note.
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.action, 'acknowledged lab result'), eq(auditLog.userName, NAME_ORDERING)))
    expect(audits).toHaveLength(1)
    expect(audits[0].details).toBe(`order=${id} signoff=${row.id}`)
    expect(JSON.stringify(audits)).not.toContain('continue plan')
  })

  it('acknowledge is allowed on a preliminary result, not before one exists; unknown order is not_found', async () => {
    expect(await signOffLabResult(await order('resulted'), 'acknowledge', { note: null }, session(NAME_ORDERING), NOW)).toMatchObject({ ok: true })
    expect(await signOffLabResult(await order('received'), 'acknowledge', { note: null }, session(NAME_ORDERING), NOW)).toEqual({ ok: false, error: 'not_verified' })
    expect(await signOffLabResult(2_000_000_000, 'acknowledge', { note: null }, session(NAME_ORDERING), NOW)).toEqual({ ok: false, error: 'not_found' })
  })

  it('the attending of the patient\'s active admission may sign off; once discharged, not', async () => {
    const id = await order('verified', PID_ADMITTED)
    expect(await signOffLabResult(id, 'acknowledge', { note: null }, session(NAME_ATTENDING), NOW)).toEqual({ ok: true, providerId: attendingProvider })
    await getDb().update(admissions).set({ status: 'discharged', dischargedAt: NOW }).where(eq(admissions.id, admissionId))
    try {
      expect(await signOffLabResult(id, 'cosign', { note: null, typedName: NAME_ATTENDING }, session(NAME_ATTENDING), NOW)).toEqual({ ok: false, error: 'not_owner' })
    } finally {
      await getDb().update(admissions).set({ status: 'admitted', dischargedAt: null }).where(eq(admissions.id, admissionId))
    }
  })

  it('co-sign needs a verified result and the signer\'s own name; one per provider', async () => {
    expect(await signOffLabResult(await order('resulted'), 'cosign', { note: null, typedName: NAME_ORDERING }, session(NAME_ORDERING), NOW)).toEqual({ ok: false, error: 'not_verified' })
    const id = await order('reported')
    expect(await signOffLabResult(id, 'cosign', { note: null, typedName: 'Someone Else' }, session(NAME_ORDERING), NOW)).toEqual({ ok: false, error: 'name_mismatch' })
    expect(await signOffLabResult(id, 'cosign', { note: null, typedName: `  ${NAME_ORDERING.toUpperCase()} ` }, session(NAME_ORDERING), NOW)).toMatchObject({ ok: true })
    expect(await signOffLabResult(id, 'cosign', { note: null, typedName: NAME_ORDERING }, session(NAME_ORDERING), NOW)).toEqual({ ok: false, error: 'already_signed' })
    // A co-sign and an acknowledgement are separate kinds.
    expect(await signOffLabResult(id, 'acknowledge', { note: null }, session(NAME_ORDERING), NOW)).toMatchObject({ ok: true })
    const map = await listSignoffs([id, 2_000_000_000])
    expect(map.get(id)?.map((s) => [s.kind, s.providerName])).toEqual([['cosign', `TEST_WS4T11Q Dr Ordering prov ${TAG}`], ['acknowledge', `TEST_WS4T11Q Dr Ordering prov ${TAG}`]])
    expect(map.has(2_000_000_000)).toBe(false)
    expect((await listSignoffs([])).size).toBe(0)
  })

  it('two concurrent acknowledgements by the same doctor: exactly one succeeds, the other is already_signed', async () => {
    const id = await order('verified')
    const rs = await Promise.all([
      signOffLabResult(id, 'acknowledge', { note: null }, session(NAME_ORDERING), NOW),
      signOffLabResult(id, 'acknowledge', { note: null }, session(NAME_ORDERING), NOW),
    ])
    expect(rs.filter((r) => r.ok)).toHaveLength(1)
    expect(rs.filter((r) => !r.ok)).toEqual([{ ok: false, error: 'already_signed' }])
  })

  it('sameSignatureName ignores case and repeated spaces, never matches blank', () => {
    expect(sameSignatureName('dr.  ananya   rao', 'Dr. Ananya Rao')).toBe(true)
    expect(sameSignatureName('Dr. Anan Rao', 'Dr. Ananya Rao')).toBe(false)
    expect(sameSignatureName('   ', '')).toBe(false)
  })

  it('a duplicate sign-off row is refused by the unique index', async () => {
    const id = await order('verified')
    const row = { labOrderId: id, kind: 'cosign' as const, providerId: orderingProvider, signedByName: 'x' }
    await getDb().insert(labResultSignoffs).values(row)
    const err = await getDb().insert(labResultSignoffs).values(row).then(() => null, (e) => e)
    expect((err as { cause?: { code?: string; constraint?: string } }).cause).toMatchObject({ code: '23505', constraint: 'lab_result_signoffs_order_kind_provider_unique' })
    // ...and deleting the order deletes its sign-offs.
    await getDb().delete(labResults).where(eq(labResults.labOrderId, id))
    await getDb().delete(labOrders).where(eq(labOrders.id, id))
    expect(await getDb().select().from(labResultSignoffs).where(eq(labResultSignoffs.labOrderId, id))).toEqual([])
    expect(await getDb().select({ id: providers.id }).from(providers).where(eq(providers.id, orderingProvider))).toHaveLength(1)
  })
})
