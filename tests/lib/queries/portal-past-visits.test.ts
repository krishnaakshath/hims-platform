// WS7 T7 (spec D6, D20): the portal's "Past visits" come from encounters and admissions, not
// from appointments; only doctors marked portal-bookable in clinical departments are offered.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissions, appointments, departments, encounters, patients, providers, signatures } from '@/db/schema'
import { todayIsoIn } from '@/lib/india-time'
import { listPortalBookableProviders, listPortalPastVisits } from '@/lib/queries/patient-portal-records'

const TAG = `WS7PV${process.pid}`
const A = `${TAG}-A`
const B = `${TAG}-B`
const CODE = `T7${process.pid % 100000}`
const ids = { dept: 0, diagDept: 0, doctor: 0, hidden: 0, pathologist: 0, admA: 0, admUnsignedA: 0, videoAppt: 0 }

const plusDays = (n: number) => new Date(Date.parse(`${todayIsoIn()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  const db = getDb()
  ids.dept = (await db.insert(departments).values({ code: `${CODE}C`, name: `${TAG} Medicine`, kind: 'clinical' }).returning({ id: departments.id }))[0].id
  ids.diagDept = (await db.insert(departments).values({ code: `${CODE}D`, name: `${TAG} Laboratory`, kind: 'diagnostic' }).returning({ id: departments.id }))[0].id
  const doc = (name: string, departmentId: number, portalBookable: boolean) => ({ name, specialty: 'Test', colorTag: 'chart-1', departmentId, portalBookable })
  ids.doctor = (await db.insert(providers).values(doc(`${TAG} Dr. Bookable`, ids.dept, true)).returning({ id: providers.id }))[0].id
  ids.hidden = (await db.insert(providers).values(doc(`${TAG} Dr. Not Bookable`, ids.dept, false)).returning({ id: providers.id }))[0].id
  ids.pathologist = (await db.insert(providers).values(doc(`${TAG} Dr. Pathologist`, ids.diagDept, true)).returning({ id: providers.id }))[0].id

  await db.insert(patients).values([{ id: A, name: 'Past Visits A', dob: '1980-01-01' }, { id: B, name: 'Past Visits B', dob: '1981-01-01' }])
  const enc = (pid: string, encounterType: 'opd' | 'ipd' | 'lab', status: 'completed' | 'cancelled' | 'checked_in', encounterDate: string, extra: Partial<typeof encounters.$inferInsert> = {}) =>
    ({ patientId: pid, encounterType, status, encounterDate, providerId: ids.doctor, departmentId: ids.dept, checkedInByName: TAG, ...extra })

  const videoStart = new Date(`${plusDays(-5)}T05:00:00Z`)
  ids.videoAppt = (await db.insert(appointments).values({ patientId: A, providerId: ids.doctor, startsAt: videoStart, endsAt: new Date(videoStart.getTime() + 900_000), visitReason: 'Video review', status: 'completed', visitMode: 'video' }).returning({ id: appointments.id }))[0].id

  // Discharged at 20:00 UTC: the next calendar day in IST.
  ids.admA = (await db.insert(admissions).values({ patientId: A, attendingProviderId: ids.doctor, status: 'discharged', admittedAt: new Date(`${plusDays(-25)}T04:00:00Z`), dischargedAt: new Date(`${plusDays(-21)}T20:00:00Z`) }).returning({ id: admissions.id }))[0].id
  ids.admUnsignedA = (await db.insert(admissions).values({ patientId: A, attendingProviderId: ids.doctor, status: 'discharged', admittedAt: new Date(`${plusDays(-60)}T04:00:00Z`), dischargedAt: new Date(`${plusDays(-58)}T04:00:00Z`) }).returning({ id: admissions.id }))[0].id
  await db.insert(signatures).values({ signableType: 'admission_discharge', signableId: ids.admA, signerTypedName: 'Dr Test', signerRole: 'pi', attestationText: 'x' })

  await db.insert(encounters).values([
    enc(A, 'opd', 'completed', plusDays(-10)),
    enc(A, 'opd', 'completed', plusDays(-5), { appointmentId: ids.videoAppt }),
    enc(A, 'lab', 'completed', plusDays(-15)),
    enc(A, 'ipd', 'completed', plusDays(-25), { admissionId: ids.admA }), // the stay is listed once, from its admission
    enc(A, 'opd', 'cancelled', plusDays(-3)),
    enc(A, 'opd', 'checked_in', plusDays(0)),
    enc(A, 'opd', 'completed', plusDays(-900)), // older than 24 months
    enc(B, 'opd', 'completed', plusDays(-4)),
  ])
})

afterAll(async () => {
  const db = getDb()
  await db.delete(encounters).where(inArray(encounters.patientId, [A, B]))
  await db.delete(signatures).where(and(eq(signatures.signableType, 'admission_discharge'), inArray(signatures.signableId, [ids.admA, ids.admUnsignedA])))
  await db.delete(admissions).where(inArray(admissions.patientId, [A, B]))
  await db.delete(appointments).where(inArray(appointments.patientId, [A, B]))
  await db.delete(patients).where(inArray(patients.id, [A, B]))
  await db.delete(providers).where(inArray(providers.id, [ids.doctor, ids.hidden, ids.pathologist]))
  await db.delete(departments).where(inArray(departments.id, [ids.dept, ids.diagDept]))
})

describe('listPortalPastVisits', () => {
  it('lists completed encounters and discharged stays of the patient only, newest first, within 24 months', async () => {
    const rows = await listPortalPastVisits(A)
    expect(rows.map((r) => [r.kind, r.date])).toEqual([
      ['video', plusDays(-5)],
      ['opd', plusDays(-10)],
      ['lab', plusDays(-15)],
      ['ipd', plusDays(-20)], // IST date of the discharge instant
      ['ipd', plusDays(-58)],
    ])
    expect(rows[1]).toEqual({ kind: 'opd', date: plusDays(-10), doctorName: `${TAG} Dr. Bookable`, departmentName: `${TAG} Medicine`, status: 'completed', dischargeSummaryHref: null })
  })

  it('a discharged stay links to its summary only once the summary is signed', async () => {
    const rows = await listPortalPastVisits(A)
    const stays = rows.filter((r) => r.kind === 'ipd')
    expect(stays[0]).toMatchObject({ status: 'discharged', doctorName: `${TAG} Dr. Bookable`, departmentName: `${TAG} Medicine`, dischargeSummaryHref: `/patient-portal/documents/discharge/${ids.admA}` })
    expect(stays[1].dischargeSummaryHref).toBeNull()
  })

  it('another patient finds none of these', async () => {
    const rows = await listPortalPastVisits(B)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'opd', date: plusDays(-4) })
  })
})

describe('listPortalBookableProviders', () => {
  it('offers only portal-bookable doctors in clinical departments (no pathologist)', async () => {
    const rows = await listPortalBookableProviders()
    const names = rows.map((r) => r.name)
    expect(names).toContain(`${TAG} Dr. Bookable`)
    expect(names).not.toContain(`${TAG} Dr. Not Bookable`)
    expect(names).not.toContain(`${TAG} Dr. Pathologist`)
    expect(Object.keys(rows[0]).sort()).toEqual(['id', 'name', 'specialty'])
  })
})
