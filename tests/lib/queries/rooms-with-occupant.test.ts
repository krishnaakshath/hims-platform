import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { rooms, patients, admissions, providers, roomCategories, admissionCoverage, patientPolicies, payers } from '@/db/schema'
import { listAllRoomsWithOccupant } from '@/lib/queries/rooms'

const TEST_PATIENT_ID = 'RD-ROOMOCC-TEST-01'
const TEST_UHID = 'UHROOMOCC01'
// WS3 T4: a second stay in a private room, covered by a Star Health policy (the seed's payer rate).
const PAYER_PATIENT_ID = 'RD-ROOMOCC-TEST-02'
// Two IST midnights after the admission: day 3 (the admission day is day 1).
const ADMITTED_AT = new Date('2026-10-21T10:00:00+05:30')
const NOW = new Date('2026-10-23T09:00:00+05:30')
let roomId: number
let payerRoomId: number
let admissionId: number
let payerAdmissionId: number
let policyId: number
let providerId: number
let providerName: string

beforeAll(async () => {
  const db = getDb()
  const cats = await db.select({ id: roomCategories.id, code: roomCategories.code }).from(roomCategories)
  const cat = (code: string) => cats.find((c) => c.code === code)!.id
  await db.insert(patients).values([
    { id: TEST_PATIENT_ID, name: 'Room Occupant Test Patient', dob: '1990-01-01', uhid: TEST_UHID, gender: 'female' },
    { id: PAYER_PATIENT_ID, name: 'Room Payer Test Patient', dob: '1985-01-01', gender: 'male' },
  ])
  ;[{ id: providerId, name: providerName }] = await db.select({ id: providers.id, name: providers.name }).from(providers).limit(1)
  const [room] = await db.insert(rooms).values({
    ward: 'Test Ward', roomNumber: '901', bedNumber: 'A', status: 'occupied', occupiedByPatientId: TEST_PATIENT_ID, roomCategoryId: cat('GEN_WARD'), genderRestriction: 'male',
  }).returning()
  roomId = room.id
  const [admission] = await db.insert(admissions).values({
    patientId: TEST_PATIENT_ID, currentRoomId: roomId, attendingProviderId: providerId, admittedAt: ADMITTED_AT,
    wardGenderOverrideReason: 'Only free bed during the night shift', wardGenderOverrideByName: 'Test Admin',
  }).returning()
  admissionId = admission.id

  const [privateRoom] = await db.insert(rooms).values({
    ward: 'Test Ward', roomNumber: '902', bedNumber: 'A', status: 'occupied', occupiedByPatientId: PAYER_PATIENT_ID, roomCategoryId: cat('PRIVATE'),
  }).returning()
  payerRoomId = privateRoom.id
  const [star] = await db.select({ id: payers.id }).from(payers).where(eq(payers.name, 'Star Health and Allied Insurance'))
  const [policy] = await db.insert(patientPolicies).values({
    patientId: PAYER_PATIENT_ID, insurerPayerId: star.id, policyNumber: 'POL-ROOMOCC', memberId: 'M', policyType: 'individual',
    holderName: 'H', relationship: 'self', validFrom: '2026-01-01', validTo: '2099-12-31', createdByName: 'Test',
  }).returning()
  policyId = policy.id
  const [payerAdmission] = await db.insert(admissions).values({ patientId: PAYER_PATIENT_ID, currentRoomId: payerRoomId, attendingProviderId: providerId, admittedAt: NOW }).returning()
  payerAdmissionId = payerAdmission.id
  await db.insert(admissionCoverage).values({
    admissionId: payerAdmissionId, mode: 'cashless', policyId, depositRequiredPaise: 0, coverageState: 'unverified', recordedByName: 'Test',
  })
})

afterAll(async () => {
  const db = getDb()
  await db.delete(admissionCoverage).where(eq(admissionCoverage.admissionId, payerAdmissionId))
  await db.delete(admissions).where(inArray(admissions.id, [admissionId, payerAdmissionId]))
  await db.delete(patientPolicies).where(eq(patientPolicies.id, policyId))
  await db.delete(rooms).where(inArray(rooms.id, [roomId, payerRoomId]))
  await db.delete(patients).where(inArray(patients.id, [TEST_PATIENT_ID, PAYER_PATIENT_ID]))
})

describe('listAllRoomsWithOccupant', () => {
  it('joins the occupant patient id and the attending provider name for an occupied, admitted room', async () => {
    const result = await listAllRoomsWithOccupant()
    const row = result.find((r) => r.id === roomId)
    expect(row).toBeDefined()
    expect(row?.occupantName).toBe('Room Occupant Test Patient')
    expect(row?.occupantPatientId).toBe(TEST_PATIENT_ID)
    expect(row?.attendingProviderName).toBe(providerName)
    expect(row?.admittedAt).not.toBeNull()
  })

  // WS3 T4 (spec 3.2 item 12)
  it('adds the admission id, UHID, gender, bed restriction, category, the bed tariff, days stayed and the override mark', async () => {
    const row = (await listAllRoomsWithOccupant(NOW)).find((r) => r.id === roomId)
    expect(row).toMatchObject({
      admissionId, occupantUhid: TEST_UHID, occupantGender: 'female', genderRestriction: 'male', roomCategoryName: 'General ward',
      bedTariffPaise: 1_500_00, daysStayed: 3, wardGenderOverride: true,
    })
  })

  it('resolves the tariff for the admission payer (admission_coverage policy) when a payer rate exists', async () => {
    const row = (await listAllRoomsWithOccupant(NOW)).find((r) => r.id === payerRoomId)
    expect(row).toMatchObject({ admissionId: payerAdmissionId, bedTariffPaise: 4_500_00, daysStayed: 1, wardGenderOverride: false, occupantUhid: null })
  })

  it('gives a free bed its tariff but no stay fields', async () => {
    const db = getDb()
    const [gen] = await db.select({ id: roomCategories.id }).from(roomCategories).where(eq(roomCategories.code, 'GEN_WARD'))
    const [free] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: '903', bedNumber: 'A', roomCategoryId: gen.id }).returning()
    try {
      const row = (await listAllRoomsWithOccupant(NOW)).find((r) => r.id === free.id)
      expect(row).toMatchObject({ admissionId: null, occupantUhid: null, occupantGender: null, bedTariffPaise: 1_500_00, daysStayed: null, wardGenderOverride: false })
    } finally {
      await db.delete(rooms).where(eq(rooms.id, free.id))
    }
  })
})
