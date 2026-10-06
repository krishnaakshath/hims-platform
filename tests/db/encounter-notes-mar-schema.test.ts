import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, admissions, rooms, encounterNotes, medicationAdministrations } from '@/db/schema'

const createdNoteIds: number[] = []
const createdMarIds: number[] = []
const createdAdmissionIds: number[] = []
const createdRoomIds: number[] = []

afterEach(async () => {
  while (createdNoteIds.length > 0) await getDb().delete(encounterNotes).where(eq(encounterNotes.id, createdNoteIds.pop()!))
  while (createdMarIds.length > 0) await getDb().delete(medicationAdministrations).where(eq(medicationAdministrations.id, createdMarIds.pop()!))
  while (createdAdmissionIds.length > 0) await getDb().delete(admissions).where(eq(admissions.id, createdAdmissionIds.pop()!))
  while (createdRoomIds.length > 0) await getDb().delete(rooms).where(eq(rooms.id, createdRoomIds.pop()!))
})

describe('encounter_notes / medication_administrations schema', () => {
  it('inserts a draft note with only patientId set, then a signed one with an admissionId', async () => {
    const db = getDb()
    const [patientRow] = await db.select().from(patients).limit(1)

    const [draft] = await db.insert(encounterNotes).values({
      patientId: patientRow.id,
      noteType: 'progress',
      authorName: 'Dr. R. Kunam',
      authorRole: 'pi',
      subjective: 'Patient reports improved mood.',
    }).returning()
    createdNoteIds.push(draft.id)
    expect(draft.status).toBe('draft')
    expect(draft.signedAt).toBeNull()
    expect(draft.appointmentId).toBeNull()
    expect(draft.admissionId).toBeNull()

    const [room] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'N1', bedNumber: 'A' }).returning()
    createdRoomIds.push(room.id)
    const [providerRow] = await db.select().from(providers).limit(1)
    const [admission] = await db.insert(admissions).values({ patientId: patientRow.id, currentRoomId: room.id, attendingProviderId: providerRow.id }).returning()
    createdAdmissionIds.push(admission.id)

    const [signed] = await db.insert(encounterNotes).values({
      patientId: patientRow.id,
      admissionId: admission.id,
      noteType: 'nursing',
      authorName: 'Test Admin',
      authorRole: 'admin',
      objective: 'Vitals stable.',
      status: 'signed',
      signedAt: new Date(),
    }).returning()
    createdNoteIds.push(signed.id)
    expect(signed.status).toBe('signed')
    expect(signed.admissionId).toBe(admission.id)
  })

  it('inserts a scheduled MAR row and one already marked given', async () => {
    const db = getDb()
    const [patientRow] = await db.select().from(patients).limit(1)
    const [room] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'N2', bedNumber: 'A' }).returning()
    createdRoomIds.push(room.id)
    const [providerRow] = await db.select().from(providers).limit(1)
    const [admission] = await db.insert(admissions).values({ patientId: patientRow.id, currentRoomId: room.id, attendingProviderId: providerRow.id }).returning()
    createdAdmissionIds.push(admission.id)

    const [scheduled] = await db.insert(medicationAdministrations).values({
      admissionId: admission.id,
      medicationName: 'Sertraline',
      dose: '100mg',
      scheduledFor: new Date(),
    }).returning()
    createdMarIds.push(scheduled.id)
    expect(scheduled.status).toBe('scheduled')
    expect(scheduled.administeredAt).toBeNull()

    const [given] = await db.insert(medicationAdministrations).values({
      admissionId: admission.id,
      medicationName: 'Trazodone',
      dose: '50mg',
      scheduledFor: new Date(),
      status: 'given',
      administeredAt: new Date(),
      administeredByName: 'Test Admin',
    }).returning()
    createdMarIds.push(given.id)
    expect(given.status).toBe('given')
    expect(given.administeredByName).toBe('Test Admin')
  })
})
