import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { GET } from '@/app/api/pharmacy/patients/[patientId]/route'
import { getDb } from '@/db/client'
import { medicationEpisodes, medications, medicationInventory, medicationBatches } from '@/db/schema'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' | 'pharmacy' = 'pharmacy'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Pharmacy Tester' })) }))

const createdEpisodeIds: number[] = []
afterEach(async () => {
  sessionRole = 'pharmacy'
  while (createdEpisodeIds.length > 0) await getDb().delete(medicationEpisodes).where(eq(medicationEpisodes.id, createdEpisodeIds.pop()!))
})

function req() { return new Request('http://localhost') }
function ctx(patientId: string) { return { params: Promise.resolve({ patientId }) } }

async function makeEpisode(patientId: string, name: string, status: 'active' | 'inactive') {
  const [episode] = await getDb().insert(medicationEpisodes).values({
    patientId, name, medicationClass: 'Test Class', dose: '10mg', startDate: '2024-01-01', status,
  }).returning()
  createdEpisodeIds.push(episode.id)
  return episode
}

describe('GET /api/pharmacy/patients/[patientId]', () => {
  it('returns the narrow projection for an exact id', async () => {
    const res = await GET(req() as never, ctx('RD-0001'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe('RD-0001')
    expect(typeof body.name).toBe('string')
    expect(Array.isArray(body.activeMedications)).toBe(true)
  })

  it('matches case-insensitively and tolerates surrounding whitespace', async () => {
    const res = await GET(req() as never, ctx('  rd-0001 '))
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe('RD-0001')
  })

  it('returns a clean 404 for an unknown id', async () => {
    const res = await GET(req() as never, ctx('RD-999999'))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('No patient with that ID')
  })

  it('allows admin and rejects crc, pi and frontdesk', async () => {
    sessionRole = 'admin'
    const adminRes = await GET(req() as never, ctx('RD-0001'))
    expect(adminRes.status).toBe(200)

    for (const role of ['crc', 'pi', 'frontdesk'] as const) {
      sessionRole = role
      const res = await GET(req() as never, ctx('RD-0001'))
      expect(res.status).toBe(403)
    }
  })

  // Review Focus #5 -- assert on what the payload must NOT contain, not just
  // on what it must. Matching the queue-display spec's precedent.
  it('never leaks the rest of the chart', async () => {
    const body = await (await GET(req() as never, ctx('RD-0001'))).json()
    expect(Object.keys(body).sort()).toEqual(
      ['activeMedications', 'currentProvider', 'diagnoses', 'dispenses', 'dob', 'id', 'name', 'pastMedications', 'uhid']
    )
    const serialized = JSON.stringify(body)
    for (const forbidden of ['criteria', 'overallStatus', 'identityVerification', 'discrepancies', 'portalPasswordHash', 'portalConfigured', 'mfaSecretEncrypted', 'intakeqClientIdRef', 'reviewerNotes']) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('puts only active episodes in activeMedications and inactive ones in pastMedications', async () => {
    const activeName = `Active Test Drug ${Date.now()}`
    const inactiveName = `Inactive Test Drug ${Date.now()}`
    await makeEpisode('RD-0001', activeName, 'active')
    await makeEpisode('RD-0001', inactiveName, 'inactive')

    const body = await (await GET(req() as never, ctx('RD-0001'))).json()
    expect(body.activeMedications.some((e: { name: string }) => e.name === activeName)).toBe(true)
    expect(body.activeMedications.some((e: { name: string }) => e.name === inactiveName)).toBe(false)
    expect(body.pastMedications.some((e: { name: string }) => e.name === inactiveName)).toBe(true)
    expect(body.pastMedications.some((e: { name: string }) => e.name === activeName)).toBe(false)
  })

  it('marks an episode whose name has no catalog row with catalogMedicationId null', async () => {
    await makeEpisode('RD-0001', 'Zznotstocked', 'active')

    const body = await (await GET(req() as never, ctx('RD-0001'))).json()
    const episode = body.activeMedications.find((e: { name: string }) => e.name === 'Zznotstocked')
    expect(episode).toBeTruthy()
    expect(episode.catalogMedicationId).toBeNull()
    expect(episode.batches).toEqual([])
  })

  // WS5 T5: the episode's catalogue drug carries its dispensable batches, FEFO order.
  it('gives each catalogued episode its unexpired, not written-off batches in FEFO order', async () => {
    const db = getDb()
    const name = `Batched Lookup Drug ${Date.now()}`
    const [med] = await db.insert(medications).values({ name, medicationClass: 'Test', form: 'tablet' }).returning()
    try {
      await db.insert(medicationInventory).values({ medicationId: med.id, quantityOnHand: 30, unit: 'tablets' })
      const [late, , soon] = await db.insert(medicationBatches).values([
        { medicationId: med.id, batchNo: 'L-1', expiryDate: '2031-06-30', mrpPerUnitPaise: 1200, quantityOnHand: 10 },
        { medicationId: med.id, batchNo: 'X-1', expiryDate: '2020-01-31', mrpPerUnitPaise: 900, quantityOnHand: 5 },
        { medicationId: med.id, batchNo: 'S-1', expiryDate: '2030-12-31', mrpPerUnitPaise: 1000, quantityOnHand: 15 },
        { medicationId: med.id, batchNo: 'W-1', expiryDate: '2030-01-31', mrpPerUnitPaise: 1000, quantityOnHand: 0, writtenOffAt: new Date(), writeOffReason: 'damaged' },
      ]).returning()
      await makeEpisode('RD-0001', name, 'active')
      const body = await (await GET(req() as never, ctx('RD-0001'))).json()
      const episode = body.activeMedications.find((e: { name: string }) => e.name === name)
      expect(episode.catalogMedicationId).toBe(med.id)
      expect(episode.batches).toEqual([
        { id: soon.id, batchNo: 'S-1', expiryDate: '2030-12-31', quantityOnHand: 15, mrpPerUnitPaise: 1000, writtenOff: false },
        { id: late.id, batchNo: 'L-1', expiryDate: '2031-06-30', quantityOnHand: 10, mrpPerUnitPaise: 1200, writtenOff: false },
      ])
    } finally {
      while (createdEpisodeIds.length > 0) await db.delete(medicationEpisodes).where(eq(medicationEpisodes.id, createdEpisodeIds.pop()!))
      await db.delete(medicationBatches).where(eq(medicationBatches.medicationId, med.id))
      await db.delete(medicationInventory).where(eq(medicationInventory.medicationId, med.id))
      await db.delete(medications).where(eq(medications.id, med.id))
    }
  })
})
