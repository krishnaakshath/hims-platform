// WS3 T7: today's medication round for the nursing station (spec 3.2 item 15).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissions, medicationAdministrations, patients, providers, rooms } from '@/db/schema'
import { listAdmittedForNursing, listMedicationRound } from '@/lib/queries/medication-round'

const RUN = `${Date.now()}`.slice(-7)
const PROBE = `TEST_WS3T7R-${RUN}`
const WARD = `${PROBE} Ward`
const DAY = '2099-05-01'
const at = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00+05:30`)

describe.skipIf(!process.env.DATABASE_URL)('listMedicationRound (DB)', () => {
  const pAdmitted = `TWS3T7R-${RUN}-A`
  const pDischarged = `TWS3T7R-${RUN}-D`
  const pOtherWard = `TWS3T7R-${RUN}-O`
  let providerId = 0
  const roomIds: number[] = []
  const admissionIds: number[] = []
  let admitted = 0

  beforeAll(async () => {
    const db = getDb()
    const [p] = await db.insert(providers).values({ name: `${PROBE} Dr`, specialty: 'Test', colorTag: '#000000' }).returning()
    providerId = p.id
    await db.insert(patients).values([
      { id: pAdmitted, name: 'TEST_WS3T7R Admitted', dob: '1980-01-01', gender: 'female', uhid: `${pAdmitted}-UH` },
      { id: pDischarged, name: 'TEST_WS3T7R Discharged', dob: '1980-01-01', gender: 'male' },
      { id: pOtherWard, name: 'TEST_WS3T7R Other ward', dob: '1980-01-01', gender: 'male' },
    ])
    const [r1] = await db.insert(rooms).values({ ward: WARD, roomNumber: '101', bedNumber: 'A', status: 'occupied', occupiedByPatientId: pAdmitted }).returning()
    const [r2] = await db.insert(rooms).values({ ward: `${WARD} B`, roomNumber: '201', bedNumber: 'A', status: 'occupied', occupiedByPatientId: pOtherWard }).returning()
    roomIds.push(r1.id, r2.id)
    const [a] = await db.insert(admissions).values({ patientId: pAdmitted, currentRoomId: r1.id, attendingProviderId: providerId, status: 'admitted' }).returning()
    const [d] = await db.insert(admissions).values({ patientId: pDischarged, currentRoomId: null, attendingProviderId: providerId, status: 'discharged', dischargedAt: at('07:00') }).returning()
    const [o] = await db.insert(admissions).values({ patientId: pOtherWard, currentRoomId: r2.id, attendingProviderId: providerId, status: 'admitted' }).returning()
    admitted = a.id
    admissionIds.push(a.id, d.id, o.id)
    await db.insert(medicationAdministrations).values([
      { admissionId: a.id, medicationName: 'Paracetamol 650 mg', dose: '1 tab', scheduledFor: at('08:00') },
      { admissionId: a.id, medicationName: 'Pantoprazole 40 mg', dose: '1 tab', scheduledFor: at('14:00') },
      { admissionId: a.id, medicationName: 'Ceftriaxone 1 g', dose: 'IV', scheduledFor: at('06:00'), status: 'given', administeredAt: at('06:05'), administeredByName: PROBE },
      { admissionId: a.id, medicationName: 'Yesterday dose', dose: '1 tab', scheduledFor: at('22:00', '2099-04-30') },
      { admissionId: a.id, medicationName: 'Tomorrow dose', dose: '1 tab', scheduledFor: at('00:30', '2099-05-02') },
      { admissionId: d.id, medicationName: 'Discharged dose', dose: '1 tab', scheduledFor: at('08:00') },
      { admissionId: o.id, medicationName: 'Other ward dose', dose: '1 tab', scheduledFor: at('09:00') },
    ])
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(medicationAdministrations).where(inArray(medicationAdministrations.admissionId, admissionIds))
    await db.delete(admissions).where(inArray(admissions.id, admissionIds))
    await db.delete(rooms).where(inArray(rooms.id, roomIds))
    await db.delete(patients).where(inArray(patients.id, [pAdmitted, pDischarged, pOtherWard]))
    await db.delete(providers).where(eq(providers.id, providerId))
  })

  const mine = (rows: Awaited<ReturnType<typeof listMedicationRound>>) => rows.filter((r) => admissionIds.includes(r.admissionId))

  it('lists the IST day\'s doses for admitted patients only, in time order, with UHID and bed', async () => {
    const rows = mine(await listMedicationRound(DAY, null, at('08:45')))
    expect(rows.map((r) => r.medicationName)).toEqual(['Ceftriaxone 1 g', 'Paracetamol 650 mg', 'Other ward dose', 'Pantoprazole 40 mg'])
    const para = rows.find((r) => r.medicationName === 'Paracetamol 650 mg')!
    expect(para).toMatchObject({ admissionId: admitted, patientName: 'TEST_WS3T7R Admitted', uhid: `${pAdmitted}-UH`, bedLabel: `${WARD} 101-A`, dose: '1 tab', status: 'scheduled' })
    expect(para.scheduledFor.toISOString()).toBe(at('08:00').toISOString())
  })

  it('marks a 08:00 scheduled dose overdue at 08:45 IST but not at 08:20; a given dose is never overdue', async () => {
    const late = mine(await listMedicationRound(DAY, null, at('08:45')))
    expect(late.find((r) => r.medicationName === 'Paracetamol 650 mg')!.overdue).toBe(true)
    expect(late.find((r) => r.medicationName === 'Ceftriaxone 1 g')!.overdue).toBe(false)
    expect(late.find((r) => r.medicationName === 'Pantoprazole 40 mg')!.overdue).toBe(false)
    const early = mine(await listMedicationRound(DAY, null, at('08:20')))
    expect(early.find((r) => r.medicationName === 'Paracetamol 650 mg')!.overdue).toBe(false)
  })

  it('filters by ward', async () => {
    const rows = await listMedicationRound(DAY, `${WARD} B`, at('08:45'))
    expect(rows.map((r) => r.medicationName)).toEqual(['Other ward dose'])
  })

  it('lists admitted patients for the vitals picker (never the discharged one)', async () => {
    const list = (await listAdmittedForNursing()).filter((r) => admissionIds.includes(r.admissionId))
    expect(list.map((r) => r.patientName).sort()).toEqual(['TEST_WS3T7R Admitted', 'TEST_WS3T7R Other ward'])
    expect(list.find((r) => r.admissionId === admitted)).toMatchObject({ uhid: `${pAdmitted}-UH`, bedLabel: `${WARD} 101-A`, ward: WARD })
  })
})
