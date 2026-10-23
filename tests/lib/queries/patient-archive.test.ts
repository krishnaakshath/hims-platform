// WS8 T13 (spec D17): an archived chart is hidden from every list, search, picker, broadcast
// audience, queue and portal sign-in; archive and restore each write one audit row.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissions, auditLog, doctorAssignments, patients, providers } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { formatUhid } from '@/lib/uhid'
import { invalidateCache, invalidateCacheByPrefix, patientListCachePrefix, workbookListCacheKey } from '@/lib/cache'
import { archivePatient, restorePatient, getPatientArchiveState } from '@/lib/queries/patient-archive'
import { listPatientsWithStatus, listPatientNameOptions, deletePatient } from '@/lib/queries/patients'
import { searchAll, lookupPatients, getPickedPatient } from '@/lib/queries/search'
import { findPortalLoginCandidate, findPortalOtpCandidate } from '@/lib/queries/patient-portal'
import { findPatientForCashDesk } from '@/lib/queries/patient-ledger'
import { findPatientsForRcm } from '@/lib/queries/rcm-policies'
import { listBroadcastRecipientCandidates } from '@/lib/queries/broadcasts'
import { listPendingAssignmentsForProvider, listTodaysAssignments } from '@/lib/queries/doctor-assignments'
import { listWorkbookRows } from '@/lib/queries/workbook'

const admin: Session = { role: 'admin', name: 'T13 Admin', userId: null }
const stamp = Date.now()
const rand = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0')
const ID = `TEST-T13-${stamp}`
const ADMITTED_ID = `TEST-T13A-${stamp}`
const UHID = formatUhid('TQ', 1 + (stamp % 90_000_000))
const NAME = `Archtest ${rand(6)} Kumar`
const LAST10 = `9${rand(9)}`
const PIN = `9${rand(5)}`
const ALL_SCOPES = { patients: true, trials: false, formTemplates: false, services: false }

let providerId: number
let assignmentId: number
let admissionId: number

async function hiddenEverywhere(hidden: boolean) {
  const expectHas = (has: boolean, where: string) => expect(has, where).toBe(!hidden)
  expectHas((await listPatientsWithStatus(null)).some((p) => p.id === ID), 'patients list')
  expectHas((await listPatientNameOptions()).some((p) => p.id === ID), 'patient name options')
  expectHas((await listWorkbookRows()).some((r) => r.id === ID), 'workbook')
  expectHas((await searchAll(NAME, ALL_SCOPES)).patients.some((p) => p.id === ID), 'global search')
  expectHas((await lookupPatients(UHID, { includePhone: true })).results.some((p) => p.id === ID), 'PatientPicker lookup')
  expectHas((await getPickedPatient(ID)) !== null, 'picked patient')
  expectHas((await findPatientForCashDesk(UHID)).some((p) => p.id === ID), 'cash desk search')
  expectHas((await findPatientForCashDesk(NAME)).some((p) => p.id === ID), 'cash desk name search')
  expectHas((await findPatientsForRcm(UHID)).some((p) => p.id === ID), 'RCM search')
  expectHas((await listBroadcastRecipientCandidates({ pinCodePrefix: PIN })).some((m) => m.id === ID), 'broadcast candidates')
  expectHas((await findPortalLoginCandidate(UHID)) !== null, 'portal password sign-in')
  expectHas((await findPortalOtpCandidate({ kind: 'uhid', uhid: UHID })) !== null, 'portal OTP sign-in (UHID)')
  expectHas((await findPortalOtpCandidate({ kind: 'mobile', last10: LAST10 })) !== null, 'portal OTP sign-in (mobile)')
  expectHas((await listPendingAssignmentsForProvider(providerId)).some((a) => a.id === assignmentId), 'doctor queue')
  expectHas((await listTodaysAssignments()).some((a) => a.id === assignmentId), "today's OPD queue")
}

describe.skipIf(!process.env.DATABASE_URL)('WS8 T13 archive instead of delete', () => {
  beforeAll(async () => {
    const db = getDb()
    const [provider] = await db.select({ id: providers.id }).from(providers).limit(1)
    providerId = provider.id
    await db.insert(patients).values([
      { id: ID, uhid: UHID, name: NAME, dob: '1980-05-05', phone: `+91${LAST10}`, pinCode: PIN, portalPasswordHash: 'scrypt$test$not-a-real-hash' },
      { id: ADMITTED_ID, name: 'Archtest Admitted', dob: '1981-06-06' },
    ])
    const [a] = await db.insert(doctorAssignments).values({
      patientId: ID, providerId, visitType: 'outpatient', reason: 'T13 queue probe', assignedByName: 'T13', queueTicketNumber: 0,
    }).returning({ id: doctorAssignments.id })
    assignmentId = a.id
    const [adm] = await db.insert(admissions).values({ patientId: ADMITTED_ID, attendingProviderId: providerId }).returning({ id: admissions.id })
    admissionId = adm.id
    // Direct inserts bypass the cached lists' invalidation; drop any list another file cached first.
    await invalidateCacheByPrefix(patientListCachePrefix())
    await invalidateCache(workbookListCacheKey())
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(doctorAssignments).where(eq(doctorAssignments.id, assignmentId))
    await db.delete(admissions).where(eq(admissions.id, admissionId))
    await deletePatient(ID)
    await deletePatient(ADMITTED_ID)
    await db.delete(auditLog).where(inArray(auditLog.patientId, [ID, ADMITTED_ID]))
  })

  it('an active chart is found everywhere', async () => {
    await hiddenEverywhere(false)
  })

  it('a wrong typed UHID is refused and nothing changes', async () => {
    expect(await archivePatient(ID, { reason: 'Duplicate registration', confirmUhid: 'TQ000000000' }, admin)).toEqual({ ok: false, error: 'uhid_mismatch' })
    expect(await getPatientArchiveState(ID)).toBeNull()
    expect(await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, ID), eq(auditLog.action, 'archived patient')))).toHaveLength(0)
  })

  it('an unknown chart is not_found', async () => {
    expect(await archivePatient(`${ID}-NOPE`, { reason: 'Duplicate registration', confirmUhid: UHID }, admin)).toEqual({ ok: false, error: 'not_found' })
  })

  it('an admitted patient cannot be archived', async () => {
    expect(await archivePatient(ADMITTED_ID, { reason: 'Duplicate registration', confirmUhid: ADMITTED_ID }, admin)).toEqual({ ok: false, error: 'active_admission' })
    expect(await getPatientArchiveState(ADMITTED_ID)).toBeNull()
  })

  it('archives (UHID typed in any case), hides the chart everywhere, and audits only the reason length', async () => {
    const reason = '  Duplicate registration of the same person  '
    expect(await archivePatient(ID, { reason, confirmUhid: ` ${UHID.toLowerCase()} ` }, admin)).toEqual({ ok: true })
    const state = await getPatientArchiveState(ID)
    expect(state).toMatchObject({ archivedByName: 'T13 Admin', archiveReason: reason.trim() })
    await hiddenEverywhere(true)

    const rows = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, ID), eq(auditLog.action, 'archived patient')))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ userName: 'T13 Admin', role: 'admin', details: `reason_length=${reason.trim().length}` })
  })

  it('archiving twice is already_archived', async () => {
    expect(await archivePatient(ID, { reason: 'Duplicate registration', confirmUhid: UHID }, admin)).toEqual({ ok: false, error: 'already_archived' })
  })

  it('restores, shows the chart everywhere again, and audits the restore', async () => {
    expect(await restorePatient(ID, admin)).toEqual({ ok: true })
    expect(await getPatientArchiveState(ID)).toBeNull()
    await hiddenEverywhere(false)
    const rows = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, ID), eq(auditLog.action, 'restored patient')))
    expect(rows).toHaveLength(1)
    expect(await restorePatient(ID, admin)).toEqual({ ok: false, error: 'not_archived' })
    expect(await restorePatient(`${ID}-NOPE`, admin)).toEqual({ ok: false, error: 'not_found' })
  })
})
