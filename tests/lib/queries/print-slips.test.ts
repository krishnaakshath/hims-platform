import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { encounters, patients, providers } from '@/db/schema'
import { getRegistrationSlip, getTokenSlip } from '@/lib/queries/print-slips'

// Wave C P1-14 / registration slip loaders. Fixtures by id (TEST_WC_ prefix).
const PID = 'TEST_WC_SLIP1'
let encounterId: number
let providerName: string

beforeAll(async () => {
  const db = getDb()
  await db.delete(encounters).where(eq(encounters.patientId, PID))
  await db.delete(patients).where(inArray(patients.id, [PID]))
  await db.insert(patients).values({
    id: PID, name: 'Slip Testwc Patient', dob: '1990-01-01', uhid: 'TWCSLIP0001', phone: '+919800000001',
    abhaNumber: null, dateAdded: new Date('2026-10-07T20:00:00Z'),
  })
  const [provider] = await db.select({ id: providers.id, name: providers.name }).from(providers).limit(1)
  if (!provider) throw new Error('Need at least one seeded provider')
  providerName = provider.name
  const [enc] = await db.insert(encounters).values({
    patientId: PID, encounterType: 'opd', encounterDate: '2001-01-01', opdToken: 987,
    providerId: provider.id, checkedInByName: 'Test WC', checkedInAt: new Date('2001-01-01T04:00:00Z'),
  }).returning({ id: encounters.id })
  encounterId = enc.id
})

afterAll(async () => {
  const db = getDb()
  await db.delete(encounters).where(eq(encounters.patientId, PID))
  await db.delete(patients).where(eq(patients.id, PID))
})

describe('getTokenSlip', () => {
  it('returns the token, patient name/UHID, doctor and check-in instant', async () => {
    const slip = await getTokenSlip(encounterId)
    expect(slip).toMatchObject({
      encounterId, opdToken: 987, encounterType: 'opd', encounterDate: '2001-01-01',
      patient: { id: PID, name: 'Slip Testwc Patient', uhid: 'TWCSLIP0001' },
      doctorName: providerName, room: null,
    })
    expect(new Date(slip!.checkedInAt).toISOString()).toBe('2001-01-01T04:00:00.000Z')
    // Minimal patient projection: no phone, no ABHA, no DOB.
    expect(Object.keys(slip!.patient).sort()).toEqual(['id', 'name', 'uhid'])
  })

  it('returns null for an unknown encounter', async () => {
    expect(await getTokenSlip(2_000_000_000)).toBeNull()
  })
})

describe('getRegistrationSlip', () => {
  it('returns name, UHID and the registration instant only', async () => {
    const slip = await getRegistrationSlip(PID)
    expect(slip).toEqual({ id: PID, name: 'Slip Testwc Patient', uhid: 'TWCSLIP0001', registeredAt: expect.any(Date) })
    expect(slip!.registeredAt.toISOString()).toBe('2026-10-07T20:00:00.000Z')
  })

  it('returns null for an unknown patient', async () => {
    expect(await getRegistrationSlip('TEST_WC_NOPE')).toBeNull()
  })
})
