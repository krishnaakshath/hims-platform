// Legacy diagnosis readers ignore voided rows (SP6 Task 7, ruling 3); the pharmacy billing
// pick-list also skips SP6 rows without a code value (code = ''). Real local Postgres; the
// fixture patient and its diagnoses are deleted by id.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { diagnoses, patients } from '@/db/schema'
import { getPatientDetail, getPatientPharmacyView } from '@/lib/queries/patients'
import { getPatientPortalData } from '@/lib/queries/patient-portal'
import { listWorkbookRows } from '@/lib/queries/workbook'
import { gatherPatientFhirData } from '@/lib/fhir/gather'
import { liveDiagnosis, withCodeValue } from '@/lib/queries/diagnoses'

const RUN = `${Date.now()}`.slice(-8)
const PATIENT = `TEST-SP6-${RUN}-DL`
const ids: number[] = []
let legacyId = 0
let emptyCodeId = 0

describe.skipIf(!process.env.DATABASE_URL)('live diagnoses in legacy readers (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values({ id: PATIENT, name: 'TEST_SP6 Live Dx Patient', dob: '1980-02-02' })
    const rows = await db.insert(diagnoses).values([
      { patientId: PATIENT, code: 'F32.1', description: 'Legacy free text', date: '2025-01-15' },
      { patientId: PATIENT, code: 'X99.9', description: 'Voided entry', voidedAt: new Date(), voidedByName: 'TEST_SP6' },
      { patientId: PATIENT, code: '', description: 'Uncoded SP6 entry' },
    ]).returning({ id: diagnoses.id })
    ids.push(...rows.map((r) => r.id))
    legacyId = rows[0].id
    emptyCodeId = rows[2].id
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(diagnoses).where(inArray(diagnoses.id, ids))
    await db.delete(patients).where(eq(patients.id, PATIENT))
  })

  it('the shared filters select live rows and rows with a code value', async () => {
    const live = await getDb().select({ id: diagnoses.id }).from(diagnoses).where(and(eq(diagnoses.patientId, PATIENT), liveDiagnosis))
    expect(live.map((r) => r.id).sort()).toEqual([legacyId, emptyCodeId].sort())
    const coded = await getDb().select({ id: diagnoses.id }).from(diagnoses).where(and(eq(diagnoses.patientId, PATIENT), liveDiagnosis, withCodeValue))
    expect(coded.map((r) => r.id)).toEqual([legacyId])
  })

  it('voided diagnoses vanish from the chart, portal, workbook and FHIR gather', async () => {
    const detail = await getPatientDetail(PATIENT)
    expect(detail!.diagnoses.map((d) => d.description).sort()).toEqual(['Legacy free text', 'Uncoded SP6 entry'])
    const fhir = await gatherPatientFhirData(PATIENT)
    expect(fhir!.diagnosisRows.map((d) => d.id).sort()).toEqual([legacyId, emptyCodeId].sort())
    const portal = await getPatientPortalData(PATIENT)
    expect(portal!.diagnoses.map((d) => d.description).sort()).toEqual(['Legacy free text', 'Uncoded SP6 entry'])
    const wb = (await listWorkbookRows()).find((r) => r.id === PATIENT)
    expect(JSON.stringify(wb)).not.toContain('Voided entry')
    expect(JSON.stringify(wb)).toContain('Legacy free text')
  })

  it('the pharmacy billing pick-list shows only live rows with a code value', async () => {
    const view = await getPatientPharmacyView(PATIENT)
    expect(view!.diagnoses.map((d) => d.id)).toEqual([legacyId])
  })
})
