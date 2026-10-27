// WS3 T6: the discharge dialog's context (spec 3.2 item 14): the stay's diagnoses from the IPD
// encounter, the MAR drugs of the last 24 h, and the dues. Own patient, so nothing touches the
// shared fixtures.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissions, auditLog, codeSystems, codes, diagnoses, encounters, medicationAdministrations, patients, providers } from '@/db/schema'
import { loadDischargeContext } from '@/lib/queries/discharge-context'

describe.skipIf(!process.env.DATABASE_URL)('loadDischargeContext (DB)', () => {
  const RUN = `${Date.now() % 1e8}${Math.floor(Math.random() * 1e3)}`
  const PID = `TEST-WS3T6-CTX-${RUN}`
  const NOW = new Date('2099-06-03T06:00:00Z')
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000)
  let admissionId = 0
  let encounterId = 0
  let code: { id: number; code: string; display: string }

  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values({ id: PID, name: 'TEST_WS3T6 Context Patient', dob: '1985-01-01', gender: 'male' })
    const [p] = await db.select({ id: providers.id }).from(providers).orderBy(providers.id).limit(1)
    ;[code] = await db.select({ id: codes.id, code: codes.code, display: codes.display }).from(codes)
      .innerJoin(codeSystems, eq(codeSystems.id, codes.codeSystemId))
      .where(and(eq(codeSystems.kind, 'icd10'), eq(codeSystems.isCurrent, true), eq(codes.selectable, true), eq(codes.active, true), isNull(codes.sexRestriction)))
      .orderBy(codes.id).limit(1)
    const [a] = await db.insert(admissions).values({ patientId: PID, attendingProviderId: p.id, admittedAt: hoursAgo(96) }).returning()
    admissionId = a.id
    // Task 2's admission shape: an IPD encounter carrying the provisional diagnosis.
    const [e] = await db.insert(encounters).values({
      patientId: PID, encounterType: 'ipd', status: 'checked_in', encounterDate: '2099-05-30', providerId: p.id, admissionId, checkedInByName: 'TEST_WS3T6',
    }).returning()
    encounterId = e.id
    await db.insert(diagnoses).values({
      patientId: PID, code: code.code, description: code.display, date: '2099-05-30', encounterId, codeId: code.id, codeSystemKind: 'icd10',
      codeDisplay: code.display, diagnosisType: 'provisional', codingStatus: 'proposed', createdByName: 'TEST_WS3T6', createdAt: hoursAgo(96),
    })
    // A voided diagnosis never shows.
    await db.insert(diagnoses).values({
      patientId: PID, code: '', description: 'TEST_WS3T6 voided', date: '2099-05-30', encounterId, diagnosisType: 'secondary',
      createdByName: 'TEST_WS3T6', createdAt: hoursAgo(90), voidedAt: hoursAgo(80), voidedByName: 'TEST_WS3T6',
    })
    await db.insert(medicationAdministrations).values([
      { admissionId, medicationName: 'Paracetamol', dose: '650 mg', scheduledFor: hoursAgo(10), status: 'given', administeredAt: hoursAgo(10) },
      { admissionId, medicationName: 'Paracetamol', dose: '650 mg', scheduledFor: hoursAgo(4), status: 'given', administeredAt: hoursAgo(4) },
      { admissionId, medicationName: 'Ceftriaxone', dose: '1 g', scheduledFor: hoursAgo(2), status: 'scheduled' },
      // Last scheduled three days ago: not a discharge drug.
      { admissionId, medicationName: 'Pantoprazole', dose: '40 mg', scheduledFor: hoursAgo(72), status: 'given', administeredAt: hoursAgo(72) },
      // Held / refused only in the window: not a discharge drug either.
      { admissionId, medicationName: 'Ondansetron', dose: '4 mg', scheduledFor: hoursAgo(3), status: 'held' },
    ])
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(medicationAdministrations).where(eq(medicationAdministrations.admissionId, admissionId))
    await db.delete(diagnoses).where(eq(diagnoses.patientId, PID))
    await db.delete(encounters).where(eq(encounters.patientId, PID))
    await db.delete(admissions).where(eq(admissions.patientId, PID))
    await db.delete(auditLog).where(eq(auditLog.patientId, PID))
    await db.delete(patients).where(inArray(patients.id, [PID]))
  })

  it('returns the provisional diagnosis, the two MAR drugs of the last 24 h and the dues', async () => {
    const ctx = await loadDischargeContext(admissionId, NOW)
    expect(ctx).not.toBeNull()
    expect(ctx!.diagnoses).toEqual([{ codeId: code.id, code: code.code, display: code.display, type: 'provisional' }])
    expect(ctx!.medications).toEqual([
      { name: 'Ceftriaxone', dose: '1 g', lastStatus: 'scheduled' },
      { name: 'Paracetamol', dose: '650 mg', lastStatus: 'given' },
    ])
    expect(ctx!.dues).toMatchObject({ chargesPaise: 0, outstandingPaise: 0 })
    expect(ctx!.latestClearance).toBeNull()
    expect(ctx!.unpostedRoomRentDays).toBeGreaterThan(0)
  })

  it('is null for an unknown admission', async () => {
    expect(await loadDischargeContext(2_147_483_000, NOW)).toBeNull()
  })
})
