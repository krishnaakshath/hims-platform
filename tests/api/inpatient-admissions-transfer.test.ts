import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST } from '@/app/api/inpatient/admissions/[id]/transfer/route'
import { getDb } from '@/db/client'
import { rooms, admissions, admissionTransfers, providers, patients } from '@/db/schema'
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
})
