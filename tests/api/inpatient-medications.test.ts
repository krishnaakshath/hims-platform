import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { GET as listRoute, POST as orderRoute } from '@/app/api/inpatient/admissions/[id]/medications/route'
import { POST as administerRoute } from '@/app/api/inpatient/admissions/[id]/medications/[medId]/administer/route'
import { getDb } from '@/db/client'
import { patients, providers, rooms, admissions, medicationAdministrations, medicationEpisodes } from '@/db/schema'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' | 'pharmacy' | 'billing' | 'labs' = 'admin'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Test Admin' })) }))

const createdMarIds: number[] = []
const createdAdmissionIds: number[] = []
const createdRoomIds: number[] = []
const createdMedicationEpisodeIds: number[] = []
afterEach(async () => {
  sessionRole = 'admin'
  while (createdMarIds.length > 0) await getDb().delete(medicationAdministrations).where(eq(medicationAdministrations.id, createdMarIds.pop()!))
  while (createdAdmissionIds.length > 0) await getDb().delete(admissions).where(eq(admissions.id, createdAdmissionIds.pop()!))
  while (createdRoomIds.length > 0) await getDb().delete(rooms).where(eq(rooms.id, createdRoomIds.pop()!))
  while (createdMedicationEpisodeIds.length > 0) await getDb().delete(medicationEpisodes).where(eq(medicationEpisodes.id, createdMedicationEpisodeIds.pop()!))
})

async function makeAdmission(patientId?: string) {
  const db = getDb()
  const ownerPatientId = patientId ?? (await db.select().from(patients).limit(1))[0].id
  const [room] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'AM1', bedNumber: 'A' }).returning()
  createdRoomIds.push(room.id)
  const [providerRow] = await db.select().from(providers).limit(1)
  const [admission] = await db.insert(admissions).values({ patientId: ownerPatientId, currentRoomId: room.id, attendingProviderId: providerRow.id }).returning()
  createdAdmissionIds.push(admission.id)
  return admission
}

// Controller ruling 7: the MAR read is clinical -- admin/crc/pi only (the UI
// opens MedicationAdministrationPanel only for pi/admin).
describe('GET /api/inpatient/admissions/[id]/medications', () => {
  it('returns the MAR for admin, crc and pi', async () => {
    const admission = await makeAdmission()
    for (const role of ['admin', 'crc', 'pi'] as const) {
      sessionRole = role
      const res = await listRoute(new Request('http://localhost') as never, { params: Promise.resolve({ id: String(admission.id) }) })
      expect(res.status, `role ${role}`).toBe(200)
    }
  })

  it('403s frontdesk, pharmacy, billing and labs', async () => {
    const admission = await makeAdmission()
    for (const role of ['frontdesk', 'pharmacy', 'billing', 'labs'] as const) {
      sessionRole = role
      const res = await listRoute(new Request('http://localhost') as never, { params: Promise.resolve({ id: String(admission.id) }) })
      expect(res.status, `role ${role}`).toBe(403)
      expect(await res.json(), `body for ${role}`).toEqual({ error: 'Forbidden' })
    }
  })
})

describe('POST /api/inpatient/admissions/[id]/medications', () => {
  it('orders a medication for the admission', async () => {
    const admission = await makeAdmission()
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ medicationName: 'Sertraline', dose: '100mg', scheduledFor: new Date().toISOString() }) })
    const res = await orderRoute(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    createdMarIds.push(body.id)
    expect(body.status).toBe('scheduled')
  })

  it('rejects a frontdesk session', async () => {
    sessionRole = 'frontdesk'
    const admission = await makeAdmission()
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ medicationName: 'Sertraline', dose: '100mg', scheduledFor: new Date().toISOString() }) })
    const res = await orderRoute(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(403)
  })

  it('rejects a medicationEpisodeId belonging to a different patient than the admission', async () => {
    const db = getDb()
    const patientRows = await db.select().from(patients).limit(2)
    if (patientRows.length < 2) throw new Error('This test needs at least 2 seeded patients -- run npm run db:seed')
    const [patientA, patientB] = patientRows

    const admissionForA = await makeAdmission(patientA.id)
    const [episodeForB] = await db.insert(medicationEpisodes).values({ patientId: patientB.id, name: 'Sertraline', medicationClass: 'SSRI', startDate: '2024-01-01', status: 'active' }).returning()
    createdMedicationEpisodeIds.push(episodeForB.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ medicationEpisodeId: episodeForB.id, medicationName: 'Sertraline', dose: '100mg', scheduledFor: new Date().toISOString() }) })
    const res = await orderRoute(req as never, { params: Promise.resolve({ id: String(admissionForA.id) }) })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/inpatient/admissions/[id]/medications/[medId]/administer', () => {
  it('records a given dose', async () => {
    const admission = await makeAdmission()
    const orderReq = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ medicationName: 'Sertraline', dose: '100mg', scheduledFor: new Date().toISOString() }) })
    const orderRes = await orderRoute(orderReq as never, { params: Promise.resolve({ id: String(admission.id) }) })
    const ordered = await orderRes.json()
    createdMarIds.push(ordered.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ status: 'given' }) })
    const res = await administerRoute(req as never, { params: Promise.resolve({ id: String(admission.id), medId: String(ordered.id) }) })
    expect(res.status).toBe(200)
  })

  it('rejects a held status with no notes', async () => {
    const admission = await makeAdmission()
    const orderReq = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ medicationName: 'Lorazepam', dose: '1mg', scheduledFor: new Date().toISOString() }) })
    const orderRes = await orderRoute(orderReq as never, { params: Promise.resolve({ id: String(admission.id) }) })
    const ordered = await orderRes.json()
    createdMarIds.push(ordered.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ status: 'held' }) })
    const res = await administerRoute(req as never, { params: Promise.resolve({ id: String(admission.id), medId: String(ordered.id) }) })
    expect(res.status).toBe(400)
  })

  it('rejects administering a medication through a different admission\'s URL than the one it was ordered under', async () => {
    const admissionA = await makeAdmission()
    const admissionB = await makeAdmission()
    const orderReq = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ medicationName: 'Sertraline', dose: '100mg', scheduledFor: new Date().toISOString() }) })
    const orderRes = await orderRoute(orderReq as never, { params: Promise.resolve({ id: String(admissionA.id) }) })
    const ordered = await orderRes.json()
    createdMarIds.push(ordered.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ status: 'given' }) })
    const res = await administerRoute(req as never, { params: Promise.resolve({ id: String(admissionB.id), medId: String(ordered.id) }) })
    expect(res.status).toBe(409)
  })
})
