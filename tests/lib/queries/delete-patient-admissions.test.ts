import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { rooms, providers, patients, admissions, admissionTransfers, encounterNotes, medicationAdministrations, medicationEpisodes } from '@/db/schema'
import { deletePatient } from '@/lib/queries/patients'

describe('deletePatient — admissions cleanup', () => {
  // deletePatient() cascades across ~20 tables with real sequential round
  // trips; combined with this test's own setup/teardown queries that's
  // ~30 real round trips -- confirmed by isolated timing to take ~16s on
  // this connection, just over the suite's global 15s testTimeout. Every
  // other test file comfortably fits the global budget; this one genuinely
  // needs more, not a hang -- a per-test override rather than raising the
  // global timeout for every other, much cheaper test.
  it('deletes admissionTransfers and admissions for the patient, and does not leave an FK violation', { timeout: 30000 }, async () => {
    const db = getDb()
    const [room1] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'D1', bedNumber: 'A' }).returning()
    const [room2] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'D2', bedNumber: 'A' }).returning()
    const [providerRow] = await db.select().from(providers).limit(1)

    const testPatientId = `TEST-DEL-${Date.now()}`
    await db.insert(patients).values({ id: testPatientId, name: 'Delete Test Patient', dob: '2000-01-01' })

    const [admission] = await db.insert(admissions).values({ patientId: testPatientId, currentRoomId: room1.id, attendingProviderId: providerRow.id }).returning()
    await db.insert(admissionTransfers).values({ admissionId: admission.id, fromRoomId: room1.id, toRoomId: room2.id, reason: 'Test', transferredByName: 'Test Nurse' })
    await db.insert(encounterNotes).values({ patientId: testPatientId, admissionId: admission.id, noteType: 'nursing', authorName: 'Test Nurse', authorRole: 'admin', objective: 'Test note' })
    await db.insert(medicationAdministrations).values({ admissionId: admission.id, medicationName: 'Test Med', dose: '10mg', scheduledFor: new Date() })

    const deleted = await deletePatient(testPatientId)
    expect(deleted).toBe(true)

    const remainingAdmissions = await db.select().from(admissions).where(eq(admissions.patientId, testPatientId))
    expect(remainingAdmissions.length).toBe(0)

    await db.delete(rooms).where(eq(rooms.id, room1.id))
    await db.delete(rooms).where(eq(rooms.id, room2.id))
  })

  // Regression test for a live FK-ordering bug: medicationAdministrations.medicationEpisodeId
  // is a nullable FK to medicationEpisodes(id) with no ON DELETE action. deletePatient() used
  // to delete medicationEpisodes before medicationAdministrations, so any MAR row with a set
  // medicationEpisodeId made the medicationEpisodes delete fail with a foreign-key violation --
  // and because deletePatient() isn't wrapped in a transaction, everything deleted before that
  // point stayed deleted, leaving the patient half-deleted.
  it('deletes medicationAdministrations before medicationEpisodes when a MAR row references an episode', { timeout: 30000 }, async () => {
    const db = getDb()
    const [room] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'D3', bedNumber: 'A' }).returning()
    const [providerRow] = await db.select().from(providers).limit(1)

    const testPatientId = `TEST-DEL-MED-${Date.now()}`
    await db.insert(patients).values({ id: testPatientId, name: 'Delete Med Test Patient', dob: '2000-01-01' })

    const [admission] = await db.insert(admissions).values({ patientId: testPatientId, currentRoomId: room.id, attendingProviderId: providerRow.id }).returning()
    const [episode] = await db.insert(medicationEpisodes).values({ patientId: testPatientId, name: 'Sertraline', medicationClass: 'SSRI', startDate: '2024-01-01', status: 'active' }).returning()
    await db.insert(medicationAdministrations).values({ admissionId: admission.id, medicationEpisodeId: episode.id, medicationName: 'Sertraline', dose: '100mg', scheduledFor: new Date() })

    const deleted = await deletePatient(testPatientId)
    expect(deleted).toBe(true)

    const remainingEpisodes = await db.select().from(medicationEpisodes).where(eq(medicationEpisodes.patientId, testPatientId))
    expect(remainingEpisodes.length).toBe(0)
    const remainingAdministrations = await db.select().from(medicationAdministrations).where(eq(medicationAdministrations.admissionId, admission.id))
    expect(remainingAdministrations.length).toBe(0)

    await db.delete(rooms).where(eq(rooms.id, room.id))
  })
})
