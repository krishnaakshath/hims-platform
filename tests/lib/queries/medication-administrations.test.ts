import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, rooms, admissions, medicationAdministrations } from '@/db/schema'
import { orderMedication, administerMedication, listMedicationsForAdmission } from '@/lib/queries/medication-administrations'

const createdMarIds: number[] = []
const createdAdmissionIds: number[] = []
const createdRoomIds: number[] = []
afterEach(async () => {
  while (createdMarIds.length > 0) await getDb().delete(medicationAdministrations).where(eq(medicationAdministrations.id, createdMarIds.pop()!))
  while (createdAdmissionIds.length > 0) await getDb().delete(admissions).where(eq(admissions.id, createdAdmissionIds.pop()!))
  while (createdRoomIds.length > 0) await getDb().delete(rooms).where(eq(rooms.id, createdRoomIds.pop()!))
})

async function makeAdmission() {
  const db = getDb()
  const [patientRow] = await db.select().from(patients).limit(1)
  const [room] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'M1', bedNumber: 'A' }).returning()
  createdRoomIds.push(room.id)
  const [providerRow] = await db.select().from(providers).limit(1)
  const [admission] = await db.insert(admissions).values({ patientId: patientRow.id, currentRoomId: room.id, attendingProviderId: providerRow.id }).returning()
  createdAdmissionIds.push(admission.id)
  return admission
}

describe('medication administrations (MAR) queries', () => {
  it('orders a medication, lists it as scheduled, then administers it', async () => {
    const admission = await makeAdmission()
    const ordered = await orderMedication({ admissionId: admission.id, medicationEpisodeId: null, medicationName: 'Sertraline', dose: '100mg', scheduledFor: new Date() })
    createdMarIds.push(ordered.id)
    expect(ordered.status).toBe('scheduled')

    const list = await listMedicationsForAdmission(admission.id)
    expect(list.map((m) => m.id)).toContain(ordered.id)

    const result = await administerMedication(ordered.id, admission.id, { status: 'given', administeredByName: 'Test Nurse', notes: null })
    expect(result.ok).toBe(true)
  })

  it('rejects administering an already-given row a second time', async () => {
    const admission = await makeAdmission()
    const ordered = await orderMedication({ admissionId: admission.id, medicationEpisodeId: null, medicationName: 'Trazodone', dose: '50mg', scheduledFor: new Date() })
    createdMarIds.push(ordered.id)
    await administerMedication(ordered.id, admission.id, { status: 'given', administeredByName: 'Test Nurse', notes: null })

    const second = await administerMedication(ordered.id, admission.id, { status: 'given', administeredByName: 'Test Nurse', notes: null })
    expect(second.ok).toBe(false)
  })

  it('rejects a held status with no notes', async () => {
    const admission = await makeAdmission()
    const ordered = await orderMedication({ admissionId: admission.id, medicationEpisodeId: null, medicationName: 'Lorazepam', dose: '1mg', scheduledFor: new Date() })
    createdMarIds.push(ordered.id)

    const result = await administerMedication(ordered.id, admission.id, { status: 'held', administeredByName: 'Test Nurse', notes: null })
    expect(result.ok).toBe(false)
  })

  it('rejects administering a medication row that belongs to a different admission', async () => {
    const admissionA = await makeAdmission()
    const admissionB = await makeAdmission()
    const ordered = await orderMedication({ admissionId: admissionA.id, medicationEpisodeId: null, medicationName: 'Sertraline', dose: '100mg', scheduledFor: new Date() })
    createdMarIds.push(ordered.id)

    const result = await administerMedication(ordered.id, admissionB.id, { status: 'given', administeredByName: 'Test Nurse', notes: null })
    expect(result.ok).toBe(false)

    const stillScheduled = await listMedicationsForAdmission(admissionA.id)
    expect(stillScheduled.find((m) => m.id === ordered.id)?.status).toBe('scheduled')
  })
})
