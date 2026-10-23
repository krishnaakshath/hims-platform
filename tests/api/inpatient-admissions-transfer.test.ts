import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST } from '@/app/api/inpatient/admissions/[id]/transfer/route'
import { getDb } from '@/db/client'
import { rooms, admissions, admissionTransfers, providers, patients, auditLog } from '@/db/schema'
import { createAdmission } from '@/lib/queries/admissions'
import { listActiveProviders } from '@/lib/queries/providers'

let sessionName = 'Test Admin'
let sessionRole: 'admin' | 'pi' | 'frontdesk' | 'crc' = 'admin'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: sessionName })) }))

const createdRoomIds: number[] = []
const createdAdmissionIds: number[] = []
afterEach(async () => {
  sessionRole = 'admin'
  sessionName = 'Test Admin'
  while (createdAdmissionIds.length > 0) {
    const id = createdAdmissionIds.pop()!
    await getDb().delete(admissionTransfers).where(eq(admissionTransfers.admissionId, id))
    await getDb().delete(admissions).where(eq(admissions.id, id))
  }
  while (createdRoomIds.length > 0) await getDb().delete(rooms).where(eq(rooms.id, createdRoomIds.pop()!))
})

describe('POST /api/inpatient/admissions/[id]/transfer', () => {
  it('transfers as admin', async () => {
    const [providerRow] = await getDb().select().from(providers).limit(1)
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const [newRoom] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: 'Y1', bedNumber: 'A' }).returning()
    createdRoomIds.push(newRoom.id)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: providerRow.id, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ toRoomId: newRoom.id, reason: 'ICU-level care' }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(200)
  })

  it('rejects a PI transferring an admission they are not the attending provider for', async () => {
    sessionRole = 'pi'
    const providersList = await listActiveProviders()
    const otherProvider = providersList.find((p) => !sessionName.toLowerCase().includes(p.name.toLowerCase().split(' ').pop()!)) ?? providersList[0]
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const [newRoom] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: 'Y2', bedNumber: 'A' }).returning()
    createdRoomIds.push(newRoom.id)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: otherProvider.id, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ toRoomId: newRoom.id, reason: 'Test' }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(403)
  })

  // RBAC Task 18: ownership resolves by exact surname, never substring.
  async function kunamAdmission(roomNumber: string) {
    const kunam = (await listActiveProviders()).find((p) => /\bKunam$/.test(p.name))!
    const [patientRow] = await getDb().select({ id: patients.id }).from(patients).limit(1)
    const [newRoom] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber, bedNumber: 'A' }).returning()
    createdRoomIds.push(newRoom.id)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: kunam.id, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)
    return { admission, newRoom }
  }

  it('allows the attending PI (exact surname match) to transfer', async () => {
    sessionRole = 'pi'
    sessionName = 'Dr. R. Kunam'
    const { admission, newRoom } = await kunamAdmission('Y3')
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ toRoomId: newRoom.id, reason: 'Test' }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(200)
  })

  it('rejects a PI whose surname is only a substring of the attending provider\'s', async () => {
    sessionRole = 'pi'
    sessionName = 'Dr. Kun'
    const { admission, newRoom } = await kunamAdmission('Y4')
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ toRoomId: newRoom.id, reason: 'Test' }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(403)
  })

  it('rejects an unknown field in the payload', async () => {
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ toRoomId: 1, reason: 'Test', extra: true }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: '1' }) })
    expect(res.status).toBe(400)
  })

  // WS3 T4: the ward-gender rule on transfer (spec 3.1 item 10).
  describe('ward gender rule', () => {
    const PROBE = 'Transfer Gender Probe'
    const FEMALE_ID = 'RD-XFER-GENDER-F'
    async function femaleInMaleBedSetup(roomNumber: string) {
      sessionName = PROBE
      await getDb().insert(patients).values({ id: FEMALE_ID, name: 'Transfer Gender Female', dob: '1985-03-03', gender: 'female' }).onConflictDoNothing()
      const [providerRow] = await getDb().select().from(providers).limit(1)
      const [maleBed] = await getDb().insert(rooms).values({ ward: 'Test Ward (Male)', roomNumber, bedNumber: 'A', genderRestriction: 'male' }).returning()
      createdRoomIds.push(maleBed.id)
      const admission = await createAdmission({ patientId: FEMALE_ID, roomId: null, attendingProviderId: providerRow.id, admissionType: 'elective', createdFromAssignmentId: null })
      createdAdmissionIds.push(admission.id)
      return { admission, maleBed }
    }
    const post = (admissionId: number, body: unknown) =>
      POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }) as never, { params: Promise.resolve({ id: String(admissionId) }) })

    afterEach(async () => {
      await getDb().delete(auditLog).where(eq(auditLog.userName, PROBE))
    })
    afterAll(async () => {
      await getDb().delete(patients).where(eq(patients.id, FEMALE_ID))
    })

    it('refuses a female patient into a male bed without a reason (422 ward_gender_conflict); the bed stays free', async () => {
      const { admission, maleBed } = await femaleInMaleBedSetup('YG1')
      const res = await post(admission.id, { toRoomId: maleBed.id, reason: 'Needs isolation' })
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({ code: 'ward_gender_conflict', conflict: 'opposite_sex' })
      const [bed] = await getDb().select().from(rooms).where(eq(rooms.id, maleBed.id))
      expect(bed.status).toBe('available')
      expect(await getDb().select().from(admissionTransfers).where(eq(admissionTransfers.admissionId, admission.id))).toEqual([])
    })

    it('refuses an override reason shorter than 10 characters (400)', async () => {
      const { admission, maleBed } = await femaleInMaleBedSetup('YG2')
      expect((await post(admission.id, { toRoomId: maleBed.id, reason: 'Needs isolation', wardGenderOverrideReason: 'short' })).status).toBe(400)
    })

    it('transfers with a reason: the reason is on admission_transfers and the override is audited with ids only', async () => {
      const { admission, maleBed } = await femaleInMaleBedSetup('YG3')
      const why = 'Only isolation bed free tonight'
      const res = await post(admission.id, { toRoomId: maleBed.id, reason: 'Needs isolation', wardGenderOverrideReason: why })
      expect(res.status).toBe(200)
      const [t] = await getDb().select().from(admissionTransfers).where(eq(admissionTransfers.admissionId, admission.id))
      expect(t).toMatchObject({ toRoomId: maleBed.id, wardGenderOverrideReason: why, transferredByName: PROBE })
      const audits = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE))
      const override = audits.find((a) => a.action === 'ward gender override')
      expect(override).toMatchObject({ patientId: FEMALE_ID, details: `admission=${admission.id} room=${maleBed.id}` })
      expect(JSON.stringify(audits)).not.toContain(why)
    })

    it('ignores an override reason when there is no conflict (nothing stored, no override audit)', async () => {
      const { admission } = await femaleInMaleBedSetup('YG4')
      const [mixed] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: 'YG5', bedNumber: 'A' }).returning()
      createdRoomIds.push(mixed.id)
      const res = await post(admission.id, { toRoomId: mixed.id, reason: 'Needs isolation', wardGenderOverrideReason: 'Not needed at all here' })
      expect(res.status).toBe(200)
      const [t] = await getDb().select().from(admissionTransfers).where(eq(admissionTransfers.admissionId, admission.id))
      expect(t.wardGenderOverrideReason).toBeNull()
      const audits = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE))
      expect(audits.some((a) => a.action === 'ward gender override')).toBe(false)
    })
  })
})
