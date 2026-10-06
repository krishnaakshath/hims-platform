import { describe, it, expect, afterEach } from 'vitest'
import { eq, isNotNull } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, medications, medicationEpisodes } from '@/db/schema'

const createdEpisodeIds: number[] = []
afterEach(async () => {
  while (createdEpisodeIds.length > 0) {
    await getDb().delete(medicationEpisodes).where(eq(medicationEpisodes.id, createdEpisodeIds.pop()!))
  }
})

describe('medication_episodes prescription columns', () => {
  it('default to null on a row inserted the old way', async () => {
    const db = getDb()
    // Select only `id`, not `select()` -- a concurrent worktree has already
    // migrated the live DB's `patients` table to single-sourced name/dob and
    // dropped the old dual-sourced columns this worktree's schema.ts still
    // declares (out of scope for this task; see task-2 brief). Projecting
    // only the column we need avoids that standing mismatch, matching the
    // same pattern already used in seed.ts (e.g. `seedAdditionalAppointmentsForExpandedRoster`).
    const [patient] = await db.select({ id: patients.id }).from(patients).limit(1)

    const [episode] = await db
      .insert(medicationEpisodes)
      .values({ patientId: patient.id, name: 'Old-Style Med', medicationClass: 'Test Class', startDate: '2026-01-01', status: 'active' })
      .returning()
    createdEpisodeIds.push(episode.id)

    expect(episode.medicationId).toBeNull()
    expect(episode.frequencyPerDay).toBeNull()
    expect(episode.durationDays).toBeNull()
    expect(episode.instructions).toBeNull()
    expect(episode.prescribedByProviderId).toBeNull()
    expect(episode.enteredByName).toBeNull()
    expect(episode.prescribedAt).toBeNull()
  })

  it('round-trips all seven new fields when set', async () => {
    const db = getDb()
    const [patient] = await db.select({ id: patients.id }).from(patients).limit(1)
    const [provider] = await db.select().from(providers).limit(1)
    const [medication] = await db.select().from(medications).limit(1)
    const prescribedAt = new Date()

    const [episode] = await db
      .insert(medicationEpisodes)
      .values({
        patientId: patient.id,
        name: 'New-Style Med',
        medicationClass: 'Test Class',
        startDate: '2026-01-01',
        status: 'active',
        medicationId: medication.id,
        frequencyPerDay: 2,
        durationDays: 30,
        instructions: 'Take with food',
        prescribedByProviderId: provider.id,
        enteredByName: 'Sam Patel',
        prescribedAt,
      })
      .returning()
    createdEpisodeIds.push(episode.id)

    expect(episode.medicationId).toBe(medication.id)
    expect(episode.frequencyPerDay).toBe(2)
    expect(episode.durationDays).toBe(30)
    expect(episode.instructions).toBe('Take with food')
    expect(episode.prescribedByProviderId).toBe(provider.id)
    expect(episode.enteredByName).toBe('Sam Patel')
    expect(episode.prescribedAt).toBeInstanceOf(Date)
  })

  it('supports prescribedAt IS NOT NULL as a usable discriminator', async () => {
    const db = getDb()
    const [patient] = await db.select({ id: patients.id }).from(patients).limit(1)

    const [plainEpisode] = await db
      .insert(medicationEpisodes)
      .values({ patientId: patient.id, name: 'Plain Med', medicationClass: 'Test Class', startDate: '2026-01-01', status: 'active' })
      .returning()
    createdEpisodeIds.push(plainEpisode.id)

    const [prescribedEpisode] = await db
      .insert(medicationEpisodes)
      .values({
        patientId: patient.id,
        name: 'Prescribed Med',
        medicationClass: 'Test Class',
        startDate: '2026-01-01',
        status: 'active',
        prescribedAt: new Date(),
      })
      .returning()
    createdEpisodeIds.push(prescribedEpisode.id)

    const results = await db.select().from(medicationEpisodes).where(isNotNull(medicationEpisodes.prescribedAt))
    const ids = results.map((r) => r.id)
    expect(ids).toContain(prescribedEpisode.id)
    expect(ids).not.toContain(plainEpisode.id)
  })
})
