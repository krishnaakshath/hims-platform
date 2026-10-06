import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, medications, medicationEpisodes } from '@/db/schema'
import {
  createPrescription,
  stopPrescription,
  getPrintablePrescriptions,
  type CreatePrescriptionInput,
} from '@/lib/queries/prescriptions'

const createdEpisodeIds: number[] = []
afterEach(async () => {
  while (createdEpisodeIds.length > 0) {
    await getDb().delete(medicationEpisodes).where(eq(medicationEpisodes.id, createdEpisodeIds.pop()!))
  }
})

let patientA: string
let patientB: string
let providerId: number
let medicationId: number

// Column drift note (see task-2/task-3 briefs): the live shared DB's
// `patients` table is missing some Tebra/IntakeQ split columns declared in
// this worktree's schema.ts, from a concurrent worktree's migration. A bare
// `.select()` against `patients` throws here, so only `id` is projected,
// matching the pattern in tests/db/prescriptions-schema.test.ts.
beforeAll(async () => {
  const db = getDb()
  const patientRows = await db.select({ id: patients.id }).from(patients).limit(2)
  ;[patientA, patientB] = patientRows.map((p) => p.id)
  const [providerRow] = await db.select().from(providers).limit(1)
  providerId = providerRow.id
  const [medicationRow] = await db.select().from(medications).limit(1)
  medicationId = medicationRow.id
})

function baseInput(overrides: Partial<CreatePrescriptionInput> = {}): CreatePrescriptionInput {
  return {
    patientId: patientA,
    medicationId,
    name: 'Sertraline',
    medicationClass: 'SSRI',
    dose: '50mg',
    frequencyPerDay: 2,
    durationDays: 30,
    startDate: '2026-09-29',
    instructions: 'Take with food.',
    prescribedByProviderId: providerId,
    enteredByName: 'Dr. Test',
    ...overrides,
  }
}

async function makePrescription(overrides: Partial<CreatePrescriptionInput> = {}) {
  const episode = await createPrescription(baseInput(overrides))
  createdEpisodeIds.push(episode.id)
  return episode
}

describe('createPrescription', () => {
  it('writes every new column and forces status active and a non-null prescribedAt', async () => {
    const input = baseInput()
    const episode = await createPrescription(input)
    createdEpisodeIds.push(episode.id)

    expect(episode.frequencyPerDay).toBe(input.frequencyPerDay)
    expect(episode.durationDays).toBe(input.durationDays)
    expect(episode.instructions).toBe(input.instructions)
    expect(episode.medicationId).toBe(input.medicationId)
    expect(episode.prescribedByProviderId).toBe(input.prescribedByProviderId)
    expect(episode.enteredByName).toBe(input.enteredByName)
    expect(episode.status).toBe('active')
    expect(episode.prescribedAt).toBeInstanceOf(Date)
  })

  it('accepts medicationId: null and dose: null (the off-catalog path)', async () => {
    const episode = await makePrescription({ medicationId: null, dose: null })
    expect(episode.medicationId).toBeNull()
    expect(episode.dose).toBeNull()
  })
})

describe('stopPrescription', () => {
  it('sets inactive and the given stopDate', async () => {
    const episode = await makePrescription()
    const result = await stopPrescription(episode.patientId, episode.id, '2026-10-01')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.episode.status).toBe('inactive')
      expect(result.episode.stopDate).toBe('2026-10-01')
    }
  })

  it('a second call on the same row returns already_inactive and does not overwrite the first stopDate', async () => {
    const episode = await makePrescription()
    const first = await stopPrescription(episode.patientId, episode.id, '2026-10-01')
    expect(first.ok).toBe(true)

    const second = await stopPrescription(episode.patientId, episode.id, '2026-11-15')
    expect(second).toEqual({ ok: false, reason: 'already_inactive' })

    const [row] = await getDb().select().from(medicationEpisodes).where(eq(medicationEpisodes.id, episode.id))
    expect(row.stopDate).toBe('2026-10-01')
  })

  it('returns not_found when the patientId does not own the episode, and leaves the row active', async () => {
    const episode = await makePrescription({ patientId: patientA })
    const result = await stopPrescription(patientB, episode.id, '2026-10-01')
    expect(result).toEqual({ ok: false, reason: 'not_found' })

    const [row] = await getDb().select().from(medicationEpisodes).where(eq(medicationEpisodes.id, episode.id))
    expect(row.status).toBe('active')
    expect(row.stopDate).toBeNull()
  })

  it('returns not_found for an unknown id', async () => {
    const result = await stopPrescription(patientA, 999999999, '2026-10-01')
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('works on an imported episode too (prescribedAt: null)', async () => {
    const [imported] = await getDb().insert(medicationEpisodes).values({
      patientId: patientA,
      name: 'Imported Med',
      medicationClass: 'Test Class',
      startDate: '2025-01-01',
      status: 'active',
    }).returning()
    createdEpisodeIds.push(imported.id)
    expect(imported.prescribedAt).toBeNull()

    const result = await stopPrescription(patientA, imported.id, '2026-10-01')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.episode.status).toBe('inactive')
      expect(result.episode.stopDate).toBe('2026-10-01')
    }
  })
})

describe('getPrintablePrescriptions', () => {
  it('returns rows with the prescriber joined for a single valid id', async () => {
    const episode = await makePrescription()
    const result = await getPrintablePrescriptions([episode.id])
    expect(result).not.toBeNull()
    expect(result).toHaveLength(1)
    const row = result![0]
    expect(row.id).toBe(episode.id)
    expect(row.patientId).toBe(episode.patientId)
    expect(row.prescriber.id).toBe(providerId)
    expect(row.prescriber.credentials).toBeDefined()
    expect(row.prescriber.specialty).toBeDefined()
  })

  it('returns null when the ids span two patients', async () => {
    const episodeA = await makePrescription({ patientId: patientA })
    const episodeB = await makePrescription({ patientId: patientB })

    const result = await getPrintablePrescriptions([episodeA.id, episodeB.id])
    expect(result).toBeNull()
  })

  it('returns null when any id has prescribedAt: null', async () => {
    const prescribed = await makePrescription()
    const [imported] = await getDb().insert(medicationEpisodes).values({
      patientId: patientA,
      name: 'Imported Med',
      medicationClass: 'Test Class',
      startDate: '2025-01-01',
      status: 'active',
    }).returning()
    createdEpisodeIds.push(imported.id)

    const result = await getPrintablePrescriptions([prescribed.id, imported.id])
    expect(result).toBeNull()
  })

  it('returns null when any id does not exist', async () => {
    const episode = await makePrescription()
    const result = await getPrintablePrescriptions([episode.id, 999999999])
    expect(result).toBeNull()
  })

  it('returns null for an empty array', async () => {
    const result = await getPrintablePrescriptions([])
    expect(result).toBeNull()
  })
})
