// Wave D: Indian-hospital demo data written by src/db/seed.ts.
//
// Two layers:
//   - seedIndiaReference(): idempotent masters (departments, payers, room categories and
//     beds, service master and tariffs, lab-test mapping, billing settings, doctors' Indian
//     profiles, SAMPLE code sets, UHIDs for any patient missing one). Safe on every run.
//   - seedIndiaOperations(): the day-to-day demo (appointments, OPD/IPD encounters, lab orders
//     in every status, home collection, coding, charges, invoices, receipts, advances,
//     follow-ups, pharmacy, messages). Only on a fresh or reset database (seed.ts decides).
//
// Operational rows are written through the same query functions the app uses (check-in,
// charge capture, invoicing, lab lifecycle, home collection, coding), so every invariant,
// number series and audit row is real. Times are relative to "today" in IST, so every
// dashboard has today's work whenever the seed is run. Nothing here logs patient data.
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from './client'
import {
  appointments, admissions, billingSettings, bookingRequests, codeSystems, departments, doctorAssignments, encounterNotes,
  encounters, followUpContactAttempts, followUpOrders, homeCollectionWindows, labServiceAreaPins, labTests,
  medicationAdministrations, medicationEpisodes, medications, messages, patientContacts, patients, payers,
  providers, roomCategories, rooms, serviceCatalog, servicePackageItems, signatures, tariffRates,
} from './schema'
import {
  DEMO_HOSPITAL, DEPARTMENT_SEED, DOCTOR_ROSTER, EXISTING_LAB_TEST_SERVICE_MAP, INDIA_LAB_TESTS, PACKAGE_ITEMS_SEED,
  PAYERS_SEED, PAYER_TARIFFS, DEPARTMENT_TARIFFS, PREVIOUS_TARIFF, ROOM_CATEGORY_SEED, ROOM_SEED, SERVICE_AREA_PINS,
  SERVICE_SEED, SYNTHETIC_AADHAAR_RECORDED_BY, TARIFF_VALID_FROM, addressFor, syntheticAadhaar, syntheticMobile,
} from './seed-india-data'
import type { Session } from '../lib/auth'
import { buildAadhaarRow } from '../lib/patient-identity'
import { upsertPatientAadhaar } from '../lib/queries/patient-profile'
import { addDaysIso } from '../lib/follow-ups/rules'
import { todayIsoIn } from '../lib/india-time'
import { CLI_IMPORT_LIMITS, validateCodeSystemImport } from '../lib/coding/import'
import type { CodeSystemKind } from '../lib/coding/code-systems'
import { commitCodeSystemImport, sha256Hex } from '../lib/queries/code-systems'
import { refusesSampleCodes, addEncounterDiagnosis, addEncounterProcedure, applyCodingAction } from '../lib/queries/coding'
import { raiseCodingQuery } from '../lib/queries/coding-queries'
import { nextUhid } from '../lib/queries/uhid'
import { checkInVisit } from '../lib/queries/encounters'
import { captureChargeLine } from '../lib/queries/charge-capture'
import { createDraftInvoice, finaliseInvoice, cancelInvoice } from '../lib/queries/invoices'
import { recordPayment, issueRefund } from '../lib/queries/patient-ledger'
import { postRoomRent } from '../lib/queries/room-rent'
import { dischargeAdmission } from '../lib/queries/admissions'
import { createLabRequisition } from '../lib/queries/lab-requisitions'
import { collectLabOrder, receiveLabSample, recordLabResult, verifyLabResult, cancelLabOrder } from '../lib/queries/lab-lifecycle'
import { bookHomeCollection, assignCollector, collectHomeVisit, cancelHomeCollection } from '../lib/queries/home-collections'
import { releaseLabReport } from '../lib/queries/lab-reports'
import { dispenseMedication, createChargeForDispense } from '../lib/queries/medication-dispenses'
import { createTelemedicineSession } from '../lib/queries/telemedicine-sessions'

type Db = ReturnType<typeof getDb>

/** Throws with the step name and the error code when an app write refuses; never includes PHI. */
function must<T extends { ok: boolean }>(result: T, step: string): Extract<T, { ok: true }> {
  if (!result.ok) {
    const r = result as { error?: unknown; violations?: { code: string }[] }
    const codes = r.violations?.map((v) => v.code).join(',')
    throw new Error(`Seed step failed: ${step} (${String(r.error)}${codes ? `: ${codes}` : ''})`)
  }
  return result as Extract<T, { ok: true }>
}

/** An instant at an IST wall-clock time on an IST calendar date. */
export function istAt(dateIso: string, hhmm: string): Date {
  return new Date(`${dateIso}T${hhmm}:00+05:30`)
}

function plusMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000)
}

// ---------------------------------------------------------------------------
// Reference data (idempotent)
// ---------------------------------------------------------------------------

export interface IndiaRefs {
  deptIds: Map<string, number>
  payerIds: Map<string, number>
  roomCategoryIds: Map<string, number>
  serviceIds: Map<string, number>
  providerIds: Map<string, number>
  labTestIds: Map<string, number>
}

async function upsertDepartments(db: Db): Promise<Map<string, number>> {
  await db.insert(departments).values(DEPARTMENT_SEED).onConflictDoNothing({ target: departments.code })
  const rows = await db.select({ id: departments.id, code: departments.code }).from(departments)
  return new Map(rows.map((r) => [r.code, r.id]))
}

async function upsertPayers(db: Db): Promise<Map<string, number>> {
  const existing = await db.select({ id: payers.id, name: payers.name }).from(payers)
  const have = new Set(existing.map((p) => p.name))
  const toInsert = PAYERS_SEED.filter((p) => !have.has(p.name))
  if (toInsert.length > 0) await db.insert(payers).values(toInsert)
  const rows = await db.select({ id: payers.id, name: payers.name }).from(payers)
  return new Map(rows.map((r) => [r.name, r.id]))
}

async function upsertRoomCategories(db: Db): Promise<Map<string, number>> {
  await db.insert(roomCategories).values([...ROOM_CATEGORY_SEED]).onConflictDoNothing({ target: roomCategories.code })
  const rows = await db.select({ id: roomCategories.id, code: roomCategories.code }).from(roomCategories)
  return new Map(rows.map((r) => [r.code, r.id]))
}

/** Adds the categorised wards unless categorised beds already exist. */
async function ensureCategorisedRooms(db: Db, roomCategoryIds: Map<string, number>): Promise<void> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(rooms).where(sql`${rooms.roomCategoryId} is not null`)
  if (n > 0) return
  await db.insert(rooms).values(ROOM_SEED.map((r) => ({
    ward: r.ward, roomNumber: r.roomNumber, bedNumber: r.bedNumber, status: 'available' as const, roomCategoryId: roomCategoryIds.get(r.category)!,
  })))
}

async function upsertServices(db: Db, deptIds: Map<string, number>): Promise<Map<string, number>> {
  await db.insert(serviceCatalog).values(SERVICE_SEED.map((s) => ({
    code: s.code, name: s.name, departmentId: deptIds.get(s.departmentCode)!, category: s.category, hsnSac: s.hsnSac,
    gstRateBp: s.gstRateBp, requiresPreauth: s.requiresPreauth ?? false, maxQuantity: s.maxQuantity ?? null,
  }))).onConflictDoNothing({ target: serviceCatalog.code })
  const rows = await db.select({ id: serviceCatalog.id, code: serviceCatalog.code }).from(serviceCatalog)
  return new Map(rows.map((r) => [r.code, r.id]))
}

const TARIFF_AUTHOR = 'Demo seed (rate card)'

/** Writes a service's rate card only when the service has no rates at all (never touches edited cards). */
async function seedTariffs(db: Db, refs: Pick<IndiaRefs, 'deptIds' | 'payerIds' | 'roomCategoryIds' | 'serviceIds'>): Promise<void> {
  const withRates = new Set((await db.select({ id: tariffRates.serviceId }).from(tariffRates)).map((r) => r.id))
  const rows: (typeof tariffRates.$inferInsert)[] = []
  for (const s of SERVICE_SEED) {
    const serviceId = refs.serviceIds.get(s.code)!
    if (withRates.has(serviceId)) continue
    if (s.basePaise !== undefined) {
      rows.push({ serviceId, scope: 'base', amountPaise: s.basePaise, validFrom: TARIFF_VALID_FROM, createdByName: TARIFF_AUTHOR })
      // Last year's card, so the tariff history is not a single row.
      if (s.category === 'consultation') {
        rows.push({ serviceId, scope: 'base', amountPaise: Math.round((s.basePaise * 0.9) / 100) * 100, validFrom: PREVIOUS_TARIFF.validFrom, validTo: PREVIOUS_TARIFF.validTo, createdByName: TARIFF_AUTHOR })
      }
    }
    for (const [cat, amountPaise] of Object.entries(s.byRoomCategory ?? {})) {
      rows.push({ serviceId, scope: 'base', roomCategoryId: refs.roomCategoryIds.get(cat)!, amountPaise, validFrom: TARIFF_VALID_FROM, createdByName: TARIFF_AUTHOR })
    }
    for (const t of DEPARTMENT_TARIFFS.filter((x) => x.serviceCode === s.code)) {
      rows.push({ serviceId, scope: 'department', departmentId: refs.deptIds.get(t.departmentCode)!, amountPaise: t.amountPaise, validFrom: TARIFF_VALID_FROM, createdByName: TARIFF_AUTHOR })
    }
    for (const t of PAYER_TARIFFS.filter((x) => x.serviceCode === s.code)) {
      const payerId = refs.payerIds.get(t.payerName)
      if (payerId === undefined) continue
      rows.push({
        serviceId, scope: 'payer', payerId, roomCategoryId: t.roomCategory ? refs.roomCategoryIds.get(t.roomCategory)! : null,
        amountPaise: t.amountPaise, validFrom: TARIFF_VALID_FROM, createdByName: TARIFF_AUTHOR,
      })
    }
  }
  if (rows.length > 0) await db.insert(tariffRates).values(rows)

  const pkgRows = PACKAGE_ITEMS_SEED.map((i) => ({
    packageServiceId: refs.serviceIds.get(i.packageCode)!, itemServiceId: refs.serviceIds.get(i.itemCode)!, quantity: i.quantity,
  }))
  await db.insert(servicePackageItems).values(pkgRows).onConflictDoNothing()
}

async function seedLabTestMapping(db: Db, serviceIds: Map<string, number>): Promise<Map<string, number>> {
  const existing = new Set((await db.select({ code: labTests.code }).from(labTests)).map((t) => t.code))
  const toInsert = INDIA_LAB_TESTS.filter((t) => !existing.has(t.code)).map((t) => ({
    name: t.name, code: t.code, category: t.category, defaultUnit: t.defaultUnit, referenceRange: t.referenceRange,
    sampleType: t.sampleType, container: t.container, serviceId: t.serviceCode ? serviceIds.get(t.serviceCode) ?? null : null,
  }))
  if (toInsert.length > 0) await db.insert(labTests).values(toInsert)
  for (const [code, m] of Object.entries(EXISTING_LAB_TEST_SERVICE_MAP)) {
    await db.update(labTests)
      .set({ serviceId: serviceIds.get(m.serviceCode) ?? null, sampleType: m.sampleType, container: m.container })
      .where(and(eq(labTests.code, code), isNull(labTests.serviceId)))
  }
  const rows = await db.select({ id: labTests.id, code: labTests.code }).from(labTests)
  return new Map(rows.map((r) => [r.code, r.id]))
}

/** Fills the hospital's legal details and the room-rent service only where they are still blank. */
async function seedBillingSettings(db: Db, serviceIds: Map<string, number>): Promise<void> {
  await db.insert(billingSettings).values({ id: 1 }).onConflictDoNothing()
  const [s] = await db.select().from(billingSettings).where(eq(billingSettings.id, 1))
  const patch: Partial<typeof billingSettings.$inferInsert> = {}
  if (!s.legalName) Object.assign(patch, { legalName: DEMO_HOSPITAL.legalName, gstin: DEMO_HOSPITAL.gstin, stateCode: DEMO_HOSPITAL.stateCode, address: DEMO_HOSPITAL.address, ipdDepositThresholdPaise: DEMO_HOSPITAL.ipdDepositThresholdPaise })
  if (s.roomRentServiceId === null) patch.roomRentServiceId = serviceIds.get('ROOM_RENT') ?? null
  if (Object.keys(patch).length > 0) await db.update(billingSettings).set({ ...patch, updatedByName: 'Demo seed', updatedAt: new Date() }).where(eq(billingSettings.id, 1))
}

/** Inserts the doctors that are missing and fills blank Indian profile fields on the ones that exist. */
async function upsertDoctors(db: Db, deptIds: Map<string, number>): Promise<Map<string, number>> {
  const existing = await db.select().from(providers)
  const byName = new Map(existing.map((p) => [p.name, p]))
  for (const d of DOCTOR_ROSTER) {
    const profile = {
      departmentId: deptIds.get(d.departmentCode)!, registrationCouncil: d.registrationCouncil, registrationStateCode: d.registrationStateCode,
      registrationNumber: d.registrationNumber, consultationFeePaise: d.consultationFeePaise,
    }
    const row = byName.get(d.name)
    if (!row) {
      await db.insert(providers).values({ name: d.name, credentials: d.credentials, specialty: d.specialty, colorTag: d.colorTag, ...profile })
    } else if (row.departmentId === null && row.registrationNumber === null) {
      await db.update(providers).set(profile).where(eq(providers.id, row.id))
    }
  }
  const rows = await db.select({ id: providers.id, name: providers.name }).from(providers)
  return new Map(rows.map((r) => [r.name, r.id]))
}

// ICD-10 and ICD-10-PCS only: the HBP package set is left for the owner to load (and the SP6
// service-code tests create their own current HBP version).
const SAMPLE_CODE_SETS: { kind: CodeSystemKind; file: string; name: string }[] = [
  { kind: 'icd10', file: 'SAMPLE-icd10.csv', name: 'SAMPLE ICD-10 (fictional demo codes)' },
  { kind: 'icd10pcs', file: 'SAMPLE-icd10pcs.csv', name: 'SAMPLE ICD-10-PCS (fictional demo codes)' },
]

/** Loads the repository's fictional SAMPLE code sets for any kind that has no code set yet. */
async function seedSampleCodeSets(db: Db, actor: Session): Promise<void> {
  if (refusesSampleCodes()) return
  const loaded = new Set((await db.select({ kind: codeSystems.kind }).from(codeSystems)).map((r) => r.kind))
  for (const set of SAMPLE_CODE_SETS) {
    if (loaded.has(set.kind)) continue
    const text = readFileSync(join(process.cwd(), 'scripts', 'code-systems', 'samples', set.file), 'utf8')
    const meta = { kind: set.kind, version: 'SAMPLE-demo', name: set.name, licenceNote: null }
    const { rows, issues } = validateCodeSystemImport(text, meta, CLI_IMPORT_LIMITS)
    if (issues.length > 0) throw new Error(`Seed step failed: sample code set ${set.file} did not validate`)
    await commitCodeSystemImport({ ...meta, sourceFileName: set.file, sourceSha256: sha256Hex(text), makeCurrent: true, isSample: true }, rows, actor)
  }
}

/** Issues a UHID to every patient that has none (the same rule as the 2026-10-09 backfill migration). */
export async function backfillMissingUhids(db: Db = getDb()): Promise<number> {
  const missing = await db.select({ id: patients.id }).from(patients).where(isNull(patients.uhid)).orderBy(asc(patients.dateAdded), asc(patients.id))
  for (const p of missing) {
    await db.transaction(async (tx) => {
      const uhid = await nextUhid(tx)
      await tx.update(patients).set({ uhid }).where(and(eq(patients.id, p.id), isNull(patients.uhid)))
    })
  }
  return missing.length
}

export async function seedIndiaReference(actor: Session): Promise<IndiaRefs> {
  const db = getDb()
  const deptIds = await upsertDepartments(db)
  const payerIds = await upsertPayers(db)
  const roomCategoryIds = await upsertRoomCategories(db)
  await ensureCategorisedRooms(db, roomCategoryIds)
  const serviceIds = await upsertServices(db, deptIds)
  await seedTariffs(db, { deptIds, payerIds, roomCategoryIds, serviceIds })
  const labTestIds = await seedLabTestMapping(db, serviceIds)
  await seedBillingSettings(db, serviceIds)
  const providerIds = await upsertDoctors(db, deptIds)
  await seedSampleCodeSets(db, actor)
  await backfillMissingUhids(db)
  return { deptIds, payerIds, roomCategoryIds, serviceIds, providerIds, labTestIds }
}

// ---------------------------------------------------------------------------
// Patient identity extras (fresh seed only): Aadhaar (synthetic, encrypted), NOK contacts
// ---------------------------------------------------------------------------

/**
 * Synthetic, consented Aadhaar values for `patientIds` and recorded declines for `declines`,
 * written only through the app's one Aadhaar path (buildAadhaarRow encrypts; the upsert audits
 * status codes, never the value). The recording name marks every value as synthetic.
 */
export async function seedAadhaar(patientIds: string[], declines: { id: string; reason: 'patient_declined' | 'not_available' }[], actor: Session): Promise<void> {
  const now = new Date()
  for (const [i, id] of patientIds.entries()) {
    const row = buildAadhaarRow(id, { status: 'provided', number: syntheticAadhaar(i + 1), consent: true }, SYNTHETIC_AADHAAR_RECORDED_BY, now)
    await upsertPatientAadhaar(id, row, actor)
  }
  for (const d of declines) {
    await upsertPatientAadhaar(d.id, buildAadhaarRow(d.id, { status: 'declined', reason: d.reason }, 'Demo seed', now), actor)
  }
}

const NOK_NAMES = ['Suma', 'Prakash', 'Revathi', 'Kumar', 'Shanthi', 'Mahadev', 'Asha', 'Naveen', 'Latha', 'Gopal']

export async function seedContacts(patientIds: string[]): Promise<void> {
  const rels = ['spouse', 'parent', 'child', 'sibling'] as const
  const rows = patientIds.map((patientId, i) => ({
    patientId, kind: 'next_of_kin' as const, name: `${NOK_NAMES[i % NOK_NAMES.length]} (demo contact)`, relationship: rels[i % rels.length],
    phone: syntheticMobile(70000 + i), isPrimary: true,
  }))
  if (rows.length > 0) await getDb().insert(patientContacts).values(rows)
}

// ---------------------------------------------------------------------------
// Operations (fresh seed only)
// ---------------------------------------------------------------------------

export interface OperationsInput {
  refs: IndiaRefs
  /** The ids of RD-0007 .. RD-0050 in roster order (local-PIN patients are chosen from these). */
  patientIds: string[]
  heroIds: string[]
  /** Demo staff sessions, by DEMO_USERS local part. */
  sessions: Record<'admin' | 'frontdesk' | 'billing' | 'labs' | 'pathologist' | 'collector' | 'coder' | 'pharmacy' | 'crc' | 'pi', Session>
  now?: Date
}

type CodeIds = { icd10: Map<string, number>; pcs: Map<string, number> }

async function currentCodeIds(db: Db): Promise<CodeIds> {
  const res = await db.execute(sql`select c.id, c.code, s.kind from codes c join code_systems s on s.id = c.code_system_id where s.is_current`)
  const rows = (res as unknown as { rows: { id: number; code: string; kind: string }[] }).rows
  const icd10 = new Map<string, number>()
  const pcs = new Map<string, number>()
  for (const r of rows) {
    if (r.kind === 'icd10') icd10.set(r.code, r.id)
    if (r.kind === 'icd10pcs') pcs.set(r.code, r.id)
  }
  return { icd10, pcs }
}

const CONSULT_BY_DEPT: Record<string, string> = {
  GEN_MED: 'CONS_GENMED', GEN_SURG: 'CONS_SURG', PAED: 'CONS_PAED', OBG: 'CONS_OBG', ORTHO: 'CONS_ORTHO', CARDIO: 'CONS_CARDIO',
  PSYCH: 'CONS_PSYCH', EMERG: 'CONS_EMERG',
}

// The demo roster has no children, so routine OPD rotates over the adult specialities.
const CLINICAL_DOCTORS = DOCTOR_ROSTER.filter((d) => d.departmentCode in CONSULT_BY_DEPT && d.departmentCode !== 'PAED')
const GENERAL_PHYSICIAN = DOCTOR_ROSTER.find((d) => d.departmentCode === 'GEN_MED')!

const OPD_REASONS: Record<string, string[]> = {
  GEN_MED: ['Fever and body ache for 3 days', 'Type 2 diabetes review', 'Hypertension follow-up', 'Cough and cold'],
  GEN_SURG: ['Inguinal swelling', 'Post-operative wound check'],
  PAED: ['Child with fever and loose stools', 'Vaccination and growth check'],
  OBG: ['Antenatal check-up (24 weeks)', 'Irregular periods'],
  ORTHO: ['Knee pain on climbing stairs', 'Low back pain'],
  CARDIO: ['Chest discomfort on exertion', 'Palpitations'],
  PSYCH: ['Low mood and poor sleep', 'Medication review'],
  EMERG: ['Fall with forearm laceration', 'Acute abdominal pain'],
}

const DIAGNOSIS_TEXT: Record<string, string> = {
  GEN_MED: 'Acute febrile illness', GEN_SURG: 'Inguinal hernia', PAED: 'Acute gastroenteritis', OBG: 'Normal pregnancy, second trimester',
  ORTHO: 'Osteoarthritis of knee', CARDIO: 'Stable angina', PSYCH: 'Depressive episode, moderate', EMERG: 'Laceration of forearm',
}

export interface OperationsSummary {
  encounters: number
  admissions: number
  labOrders: number
  invoices: number
}

export async function seedIndiaOperations(input: OperationsInput): Promise<OperationsSummary> {
  const db = getDb()
  const { refs, sessions } = input
  const realNow = input.now ?? new Date()
  const today = todayIsoIn('Asia/Kolkata', realNow)
  const day = (offset: number) => addDaysIso(today, offset)
  const doctorId = (name: string) => refs.providerIds.get(name)!
  const doctorSession = (name: string): Session => ({ role: 'pi', name, userId: name === 'Dr. Rajiv Kunam' ? sessions.pi.userId : null })
  const svc = (code: string) => refs.serviceIds.get(code)!
  const pid = (n: number) => `RD-${String(n).padStart(4, '0')}`

  // Lab service area for home collection (demo PINs only; real sites configure their own).
  await db.insert(labServiceAreaPins).values(SERVICE_AREA_PINS.map((p) => ({ ...p, createdByName: 'Demo seed' }))).onConflictDoNothing()
  const [morningWindow] = await db.select().from(homeCollectionWindows).where(eq(homeCollectionWindows.label, 'Morning')).limit(1)
  const [earlyWindow] = await db.select().from(homeCollectionWindows).where(eq(homeCollectionWindows.label, 'Early morning')).limit(1)

  // Payers on a few patient records (insurance, TPA and government schemes).
  const payerFor: Record<string, string> = {
    [pid(15)]: 'Star Health and Allied Insurance', [pid(10)]: 'ICICI Lombard General Insurance', [pid(18)]: 'Medi Assist TPA',
    [pid(22)]: 'CGHS (Central Government Health Scheme)', [pid(48)]: 'Ayushman Bharat PM-JAY', [pid(28)]: 'HDFC ERGO General Insurance',
  }
  for (const [patientId, payerName] of Object.entries(payerFor)) {
    const payerId = refs.payerIds.get(payerName)
    if (payerId === undefined) continue
    await db.update(patients).set({ primaryPayerId: payerId, primaryMemberId: `DEMO-${payerId}-${patientId.slice(3)}`, primarySubscriberRelationship: 'self' }).where(eq(patients.id, patientId))
  }

  const roomRows = await db.select({ id: rooms.id, ward: rooms.ward, roomNumber: rooms.roomNumber, bedNumber: rooms.bedNumber }).from(rooms)
  const room = (ward: string, roomNumber: string, bed: string) => roomRows.find((r) => r.ward === ward && r.roomNumber === roomNumber && r.bedNumber === bed)!.id

  const codeIds = await currentCodeIds(db)
  const genderRows = await db.select({ id: patients.id, gender: patients.gender }).from(patients)
  const genderOf = new Map(genderRows.map((r) => [r.id, r.gender]))
  /** Rotates the OPD doctors; obstetrics only sees women (others go to the general physician). */
  const pickDoctor = (k: number, patientId: string) => {
    const d = CLINICAL_DOCTORS[k % CLINICAL_DOCTORS.length]
    return d.departmentCode === 'OBG' && genderOf.get(patientId) !== 'female' ? GENERAL_PHYSICIAN : d
  }
  let encounterCount = 0
  let invoiceCount = 0

  // ---- helpers -----------------------------------------------------------------------------

  async function bookAppointment(patientId: string, providerId: number, startsAt: Date, visitReason: string, status: 'scheduled' | 'completed' | 'cancelled' | 'no_show' = 'scheduled', minutes = 15) {
    const [a] = await db.insert(appointments).values({ patientId, providerId, startsAt, endsAt: plusMinutes(startsAt, minutes), visitReason, status }).returning({ id: appointments.id })
    return a.id
  }

  async function checkIn(patientId: string, providerId: number, at: Date, reason: string, opts: { appointmentId?: number | null; inpatient?: boolean; roomId?: number | null; urgency?: 'routine' | 'urgent' | 'emergency' } = {}) {
    const r = must(await checkInVisit({
      patientId, providerId, visitType: opts.inpatient ? 'inpatient' : 'outpatient', urgency: opts.urgency ?? 'routine', reason,
      roomId: opts.roomId ?? null, appointmentId: opts.appointmentId ?? null, createAdmission: Boolean(opts.inpatient),
    }, sessions.frontdesk, at), `check-in ${patientId}`)
    encounterCount++
    return r
  }

  async function setEncounterStatus(encounterId: number, status: 'in_consultation' | 'completed', at: Date, byName: string) {
    await db.update(encounters).set({ status, statusChangedAt: at, statusChangedByName: byName, ...(status === 'completed' ? { completedAt: at } : {}) }).where(eq(encounters.id, encounterId))
  }

  async function capture(ctx: { encounterId: number } | { admissionId: number }, serviceCode: string, serviceDate: string, at: Date, opts: { billTo?: 'patient' | 'payer'; quantity?: number; preAuth?: string } = {}) {
    const r = must(await captureChargeLine({
      context: ctx, serviceId: svc(serviceCode), quantity: opts.quantity ?? 1, serviceDate, billTo: opts.billTo ?? 'patient',
      ...(opts.preAuth ? { preAuthReference: opts.preAuth } : {}),
    }, sessions.billing, at), `capture ${serviceCode}`)
    return r.line.id
  }

  async function invoice(lineIds: number[], finaliseAt: Date | null) {
    const draft = must(await createDraftInvoice(lineIds, sessions.billing), 'draft invoice')
    invoiceCount++
    if (finaliseAt === null) return { invoiceId: draft.invoiceId, number: null as string | null }
    const fin = must(await finaliseInvoice(draft.invoiceId, sessions.billing, finaliseAt), 'finalise invoice')
    return { invoiceId: draft.invoiceId, number: fin.invoiceNumber as string | null }
  }

  async function invoiceTotal(invoiceId: number): Promise<number> {
    const res = await db.execute(sql`select total_paise::bigint as t from invoices where id = ${invoiceId}`)
    return Number((res as unknown as { rows: { t: string }[] }).rows[0].t)
  }

  // ---- 1. Past OPD visits (completed), oldest first so invoice numbers follow the calendar ------

  type PastVisit = { encounterId: number; patientId: string; doctor: (typeof CLINICAL_DOCTORS)[number]; date: string }
  const pastVisits: PastVisit[] = []
  const pastPatients = input.patientIds.slice(0, 16)
  const plan = pastPatients.map((patientId, i) => ({ patientId, i, offset: -(12 - (i % 12)), doctor: pickDoctor(i, patientId) }))
    .sort((a, b) => a.offset - b.offset || a.i - b.i)
  for (const v of plan) {
    const date = day(v.offset)
    const hh = String(9 + (v.i % 8)).padStart(2, '0')
    const start = istAt(date, `${hh}:${v.i % 2 === 0 ? '00' : '30'}`)
    const reason = OPD_REASONS[v.doctor.departmentCode][v.i % OPD_REASONS[v.doctor.departmentCode].length]
    const providerId = doctorId(v.doctor.name)
    const appointmentId = await bookAppointment(v.patientId, providerId, start, reason)
    const ci = await checkIn(v.patientId, providerId, plusMinutes(start, -10), reason, { appointmentId })
    const encounterId = ci.encounter.id
    await setEncounterStatus(encounterId, 'in_consultation', plusMinutes(start, 5), v.doctor.name)
    await setEncounterStatus(encounterId, 'completed', plusMinutes(start, 25), v.doctor.name)
    await db.update(appointments).set({ status: 'completed' }).where(eq(appointments.id, appointmentId))
    pastVisits.push({ encounterId, patientId: v.patientId, doctor: v.doctor, date })

    // Charges: consultation (to the payer when the patient has one), plus an investigation for some.
    const hasPayer = v.patientId in payerFor
    const billTo = hasPayer ? 'payer' as const : 'patient' as const
    const preAuth = hasPayer ? `PA-DEMO-${String(encounterId).padStart(5, '0')}` : undefined
    const billAt = plusMinutes(start, 40)
    const lines = [await capture({ encounterId }, CONSULT_BY_DEPT[v.doctor.departmentCode], date, billAt, { billTo, preAuth })]
    if (v.i % 3 === 0) lines.push(await capture({ encounterId }, 'LAB_CBC', date, billAt, { billTo, preAuth }))
    if (v.doctor.departmentCode === 'CARDIO') lines.push(await capture({ encounterId }, 'PROC_ECG', date, billAt, { billTo, preAuth }))
    if (v.i % 7 === 3) lines.push(await capture({ encounterId }, 'MED_CERT', date, billAt, { billTo }))

    // Billing state by visit: unbilled, draft, finalised & paid, finalised & unpaid, cancelled.
    const state = v.i % 5
    if (state === 0 || hasPayer) continue // captured, not yet invoiced (payer lines wait for the claim)
    const sameBillTo = lines
    if (state === 1) { await invoice(sameBillTo, null); continue }
    const inv = await invoice(sameBillTo, plusMinutes(start, 50))
    const total = await invoiceTotal(inv.invoiceId)
    if (state === 2 || state === 3) {
      must(await recordPayment({ patientId: v.patientId, kind: 'receipt', invoiceId: inv.invoiceId, mode: state === 2 ? 'cash' : 'upi', reference: state === 3 ? `UPI-DEMO-${inv.invoiceId}` : undefined, amountPaise: total }, sessions.billing, plusMinutes(start, 55)), 'receipt')
    }
    if (state === 4 && v.i === 4) {
      must(await cancelInvoice(inv.invoiceId, 'Billed under the wrong department; re-billing', sessions.billing, plusMinutes(start, 90)), 'cancel invoice')
    }
  }

  // ---- 2. Coding on past visits: proposed, coded, finalised, queried --------------------------

  const icd = (code: string) => codeIds.icd10.get(code)
  const pcs = (code: string) => codeIds.pcs.get(code)
  for (const [k, v] of pastVisits.entries()) {
    const description = DIAGNOSIS_TEXT[v.doctor.departmentCode]
    const codeId = icd(k % 2 === 0 ? 'U8Z.0' : 'U9Z.0')
    if (k % 4 === 0 || codeId === undefined) {
      // The doctor's working diagnosis, not yet coded (or proposed with a code).
      must(await addEncounterDiagnosis(v.encounterId, { type: 'primary', description, ...(k % 8 === 0 && codeId ? { codeId } : {}) }, doctorSession(v.doctor.name), istAt(v.date, '13:00')), 'propose diagnosis')
      continue
    }
    must(await applyCodingAction(v.encounterId, { action: 'claim' }, sessions.coder, istAt(v.date, '17:00')), 'claim')
    if (k % 4 === 3) {
      must(await raiseCodingQuery(v.encounterId, { addressedToProviderId: doctorId(v.doctor.name), question: 'Please confirm the laterality and whether this is the primary reason for the visit.' }, sessions.coder, istAt(v.date, '17:10')), 'coding query')
      continue
    }
    must(await addEncounterDiagnosis(v.encounterId, { type: 'primary', codeId, description }, sessions.coder, istAt(v.date, '17:05')), 'code diagnosis')
    const procCode = pcs('ZZ00000')
    if (v.doctor.departmentCode === 'EMERG' && procCode) {
      must(await addEncounterProcedure(v.encounterId, { codeId: procCode, description: 'Suturing of forearm laceration', performedOn: v.date, performedByProviderId: doctorId(v.doctor.name), serviceId: svc('PROC_SUTURE') }, sessions.coder, istAt(v.date, '17:06')), 'code procedure')
    }
    must(await applyCodingAction(v.encounterId, { action: 'mark_coded' }, sessions.coder, istAt(v.date, '17:20')), 'mark coded')
    if (k % 4 === 1) must(await applyCodingAction(v.encounterId, { action: 'finalise' }, sessions.coder, istAt(v.date, '17:30')), 'finalise coding')
  }

  // Signed and draft progress notes on a few past visits.
  for (const v of pastVisits.slice(0, 3)) {
    await db.insert(encounterNotes).values({
      patientId: v.patientId, appointmentId: null, admissionId: null, noteType: 'progress', authorName: v.doctor.name, authorRole: 'pi',
      subjective: 'Symptoms improving since the last visit.', objective: 'Afebrile. Vitals stable.', assessment: DIAGNOSIS_TEXT[v.doctor.departmentCode],
      plan: 'Continue medication. Review after results.', status: v === pastVisits[2] ? 'draft' : 'signed', createdAt: istAt(v.date, '12:00'), signedAt: v === pastVisits[2] ? null : istAt(v.date, '12:30'),
    })
  }

  // ---- 3. Follow-ups in every recall bucket ---------------------------------------------------

  const fuRows: (typeof followUpOrders.$inferInsert)[] = []
  const fu = (v: PastVisit, dueOffset: number, extra: Partial<typeof followUpOrders.$inferInsert> = {}) => {
    const due = day(dueOffset)
    fuRows.push({
      patientId: v.patientId, source: 'encounter', status: 'planned', prescribedByProviderId: doctorId(v.doctor.name),
      departmentId: refs.deptIds.get(v.doctor.departmentCode) ?? null, baseDate: v.date, dueDate: due, windowStart: addDaysIso(due, -3), windowEnd: addDaysIso(due, 7),
      reason: `Review: ${DIAGNOSIS_TEXT[v.doctor.departmentCode]}`, originatingEncounterId: v.encounterId, createdByName: v.doctor.name,
      createdAt: istAt(v.date, '12:45'), updatedAt: istAt(v.date, '12:45'), ...extra,
    })
  }
  fu(pastVisits[0], 1) // due
  fu(pastVisits[1], 0) // due today
  fu(pastVisits[2], -9) // overdue (window ended 2 days ago)
  fu(pastVisits[3], -12) // overdue
  fu(pastVisits[4], 14) // upcoming
  fu(pastVisits[5], 21) // upcoming
  fu(pastVisits[6], -30, { status: 'missed' }) // missed
  const bookedAppt = await bookAppointment(pastVisits[7].patientId, doctorId(pastVisits[7].doctor.name), istAt(day(3), '11:00'), 'Follow-up visit')
  fu(pastVisits[7], 3, { status: 'scheduled', appointmentId: bookedAppt, scheduledAt: realNow, scheduledByName: sessions.frontdesk.name }) // booked
  fu(pastVisits[8], -2, { status: 'cancelled', cancelledAt: realNow, cancelledByName: pastVisits[8].doctor.name, cancelReason: 'Patient moved to another city' })
  const insertedFu = await db.insert(followUpOrders).values(fuRows).returning({ id: followUpOrders.id, dueDate: followUpOrders.dueDate, status: followUpOrders.status })
  const attempts = insertedFu.filter((f) => f.status === 'planned' && f.dueDate < today).flatMap((f, i) => [
    { followUpOrderId: f.id, channel: 'phone' as const, outcome: 'no_answer' as const, attemptedByName: sessions.frontdesk.name, attemptedByUserId: sessions.frontdesk.userId, attemptedAt: istAt(day(-1), '11:00') },
    ...(i === 0 ? [{ followUpOrderId: f.id, channel: 'whatsapp' as const, outcome: 'message_left' as const, note: 'Sent the clinic timings on WhatsApp.', attemptedByName: sessions.frontdesk.name, attemptedByUserId: sessions.frontdesk.userId, attemptedAt: istAt(today, '10:00') }] : []),
  ])
  if (attempts.length > 0) await db.insert(followUpContactAttempts).values(attempts)

  // ---- 4. Inpatients: four active admissions and one discharged stay ---------------------------

  type Stay = { patientId: string; doctor: string; ward: [string, string, string]; offset: number; reason: string; type: 'elective' | 'emergency'; payer?: boolean }
  const stays: Stay[] = [
    { patientId: pid(49), doctor: 'Dr. Arjun Reddy', ward: ['General Ward (Male)', '101', 'A'], offset: -6, reason: 'Closed fracture of right distal radius', type: 'emergency' },
    { patientId: pid(12), doctor: 'Dr. Ananya Rao', ward: ['General Ward (Female)', '102', 'A'], offset: -3, reason: 'Dengue fever with thrombocytopenia', type: 'emergency' },
    { patientId: pid(15), doctor: 'Dr. Farhan Qureshi', ward: ['Private', '301', 'A'], offset: -2, reason: 'Unstable angina for evaluation', type: 'elective', payer: true },
    { patientId: pid(20), doctor: 'Dr. Kavya Hegde', ward: ['ICU', 'ICU-1', '1'], offset: -1, reason: 'Road traffic accident, head injury under observation', type: 'emergency' },
    { patientId: pid(48), doctor: 'Dr. Lakshmi Narayanan', ward: ['Semi-Private', '201', 'A'], offset: -1, reason: 'Term pregnancy in early labour', type: 'elective', payer: true },
  ]
  const admissionIds: number[] = []
  for (const s of stays) {
    const at = istAt(day(s.offset), '10:30')
    const roomId = room(...s.ward)
    const ci = await checkIn(s.patientId, doctorId(s.doctor), at, s.reason, { inpatient: true, roomId, urgency: s.type === 'emergency' ? 'emergency' : 'routine' })
    const admissionId = ci.admissionId!
    admissionIds.push(admissionId)
    await db.update(admissions).set({ admittedAt: at, admissionType: s.type }).where(eq(admissions.id, admissionId))
    await db.update(doctorAssignments).set({ status: 'scheduled' }).where(eq(doctorAssignments.id, ci.assignment.id))
    await db.update(rooms).set({ status: 'occupied', occupiedByPatientId: s.patientId }).where(eq(rooms.id, roomId))
    await setEncounterStatus(ci.encounter.id, 'in_consultation', plusMinutes(at, 20), s.doctor)

    // Advance (deposit) on admission for self-pay stays.
    if (!s.payer) {
      must(await recordPayment({ patientId: s.patientId, kind: 'advance', admissionId, mode: 'cash', amountPaise: 15_000_00 }, sessions.billing, plusMinutes(at, 15)), 'advance')
    }
    const billTo = s.payer ? 'payer' as const : 'patient' as const
    const preAuth = s.payer ? `PA-DEMO-IPD-${admissionId}` : undefined
    const consult = CONSULT_BY_DEPT[DOCTOR_ROSTER.find((d) => d.name === s.doctor)!.departmentCode]
    await capture({ admissionId }, consult, day(s.offset), plusMinutes(at, 30), { billTo, preAuth })
    await capture({ admissionId }, 'LAB_CBC', day(s.offset), plusMinutes(at, 31), { billTo, preAuth })
    if (s.patientId === pid(12)) await capture({ admissionId }, 'CONSUM_IV_SET', day(s.offset), plusMinutes(at, 32), { quantity: 2 })
    if (s.patientId === pid(15)) await capture({ admissionId }, 'IMG_ECHO', day(s.offset), plusMinutes(at, 33), { billTo, preAuth })
    if (s.patientId === pid(49)) await capture({ admissionId }, 'PROC_PLASTER', day(s.offset), plusMinutes(at, 34))
  }

  // Room rent through yesterday for the active stays (today's day is posted by the billing desk).
  for (const admissionId of admissionIds.slice(1)) must(await postRoomRent(admissionId, sessions.billing, { throughDate: day(-1), now: realNow }), 'room rent')

  // Medication administration record for the dengue inpatient.
  await db.insert(medicationAdministrations).values([
    { admissionId: admissionIds[1], medicationName: 'Paracetamol', dose: '650 mg oral', scheduledFor: istAt(today, '06:00'), status: 'given', administeredAt: istAt(today, '06:05'), administeredByName: 'Sister Mary Joseph' },
    { admissionId: admissionIds[1], medicationName: 'Paracetamol', dose: '650 mg oral', scheduledFor: istAt(today, '14:00'), status: 'scheduled' },
    { admissionId: admissionIds[1], medicationName: 'Normal saline', dose: '500 mL IV over 4 hours', scheduledFor: istAt(today, '08:00'), status: 'given', administeredAt: istAt(today, '08:10'), administeredByName: 'Sister Mary Joseph' },
  ])

  // Discharge the fracture patient two days ago, with a signed summary, final bill and refund.
  const dischargedId = admissionIds[0]
  const discharged = stays[0]
  // Room rent is posted while the stay still has its bed (discharge releases the bed).
  must(await postRoomRent(dischargedId, sessions.billing, { throughDate: day(-2), now: realNow }), 'room rent (discharged)')
  must(await dischargeAdmission(dischargedId, {
    dischargeDiagnosis: 'Closed fracture of right distal radius, treated with closed reduction and cast',
    dischargeDrugs: 'Tab. Aceclofenac 100 mg twice daily after food for 5 days; Tab. Pantoprazole 40 mg once daily before breakfast for 5 days; Tab. Calcium + Vitamin D3 once daily for 6 weeks',
    dischargeDevices: 'Below-elbow plaster cast, arm sling',
    dischargeDiet: 'Normal diet',
    dischargeSummaryNotes: 'Keep the cast dry. Elevate the hand. Return immediately for swelling, numbness or blue fingers.',
    followUp: null,
    followUpPlan: { timing: { kind: 'interval', interval: { value: 3, unit: 'weeks' } }, reason: 'Cast check and X-ray', planNotes: null },
  }, doctorSession(discharged.doctor)), 'discharge')
  const dischargedAt = istAt(day(-2), '11:00')
  await db.update(admissions).set({ dischargedAt }).where(eq(admissions.id, dischargedId))
  await db.update(encounters).set({ completedAt: dischargedAt, statusChangedAt: dischargedAt }).where(eq(encounters.admissionId, dischargedId))
  await db.insert(signatures).values({
    signableType: 'admission_discharge', signableId: dischargedId, signerTypedName: discharged.doctor, signerRole: 'pi',
    attestationText: 'I attest that this discharge summary is accurate and complete.', signedAt: dischargedAt,
  })
  const finalLines = (await db.execute(sql`select id from charge_lines where admission_id = ${dischargedId} and status = 'captured' and invoice_id is null order by id`)) as unknown as { rows: { id: number }[] }
  const finalBill = await invoice(finalLines.rows.map((r) => r.id), plusMinutes(dischargedAt, 30))
  const finalTotal = await invoiceTotal(finalBill.invoiceId)
  // The ₹15,000 advance is set off against the final bill: collect any balance, refund any excess.
  if (finalTotal > 15_000_00) {
    must(await recordPayment({ patientId: discharged.patientId, kind: 'receipt', invoiceId: finalBill.invoiceId, admissionId: dischargedId, mode: 'card', reference: `POS-DEMO-${finalBill.invoiceId}`, amountPaise: finalTotal - 15_000_00 }, sessions.billing, plusMinutes(dischargedAt, 40)), 'discharge receipt')
  } else if (finalTotal < 15_000_00) {
    must(await issueRefund({ patientId: discharged.patientId, admissionId: dischargedId, mode: 'neft', reference: `NEFT-DEMO-${finalBill.invoiceId}`, amountPaise: 15_000_00 - finalTotal, reason: 'Unused advance refunded at discharge' }, sessions.billing, plusMinutes(dischargedAt, 40)), 'discharge refund')
  }

  // ---- 5. Today: queue, consultations and walk-ins --------------------------------------------

  const todayStart = istAt(today, '00:01')
  const earlier = (minutes: number) => new Date(Math.max(todayStart.getTime(), realNow.getTime() - minutes * 60_000))
  const todayPatients = input.patientIds.slice(16, 28)
  const todayCompleted: number[] = []
  for (const [i, patientId] of todayPatients.entries()) {
    const doctor = pickDoctor(i, patientId)
    const providerId = doctorId(doctor.name)
    const reason = OPD_REASONS[doctor.departmentCode][i % OPD_REASONS[doctor.departmentCode].length]
    if (i < 8) {
      // Arrived: the appointment is around the check-in time.
      const checkInAt = earlier(180 - i * 15)
      const appointmentId = await bookAppointment(patientId, providerId, plusMinutes(checkInAt, 10), reason)
      const ci = await checkIn(patientId, providerId, checkInAt, reason, { appointmentId })
      if (i < 3) {
        await setEncounterStatus(ci.encounter.id, 'in_consultation', plusMinutes(checkInAt, 15), doctor.name)
        await setEncounterStatus(ci.encounter.id, 'completed', plusMinutes(checkInAt, 30), doctor.name)
        await db.update(appointments).set({ status: 'completed' }).where(eq(appointments.id, appointmentId))
        todayCompleted.push(ci.encounter.id)
        const line = await capture({ encounterId: ci.encounter.id }, CONSULT_BY_DEPT[doctor.departmentCode], today, plusMinutes(checkInAt, 35))
        if (i === 0) {
          const inv = await invoice([line], plusMinutes(checkInAt, 40))
          must(await recordPayment({ patientId, kind: 'receipt', invoiceId: inv.invoiceId, mode: 'upi', reference: `UPI-DEMO-${inv.invoiceId}`, amountPaise: await invoiceTotal(inv.invoiceId) }, sessions.billing, plusMinutes(checkInAt, 42)), 'today receipt')
        }
      } else if (i < 5) {
        await setEncounterStatus(ci.encounter.id, 'in_consultation', plusMinutes(checkInAt, 15), doctor.name)
      }
    } else if (i < 10) {
      // Walk-ins waiting for the doctor to accept (pending assignment).
      await checkIn(patientId, providerId, earlier(40 - (i - 8) * 10), reason, { urgency: i === 9 ? 'urgent' : 'routine' })
    } else {
      // Booked for later today.
      await bookAppointment(patientId, providerId, istAt(today, i === 10 ? '16:00' : '17:30'), reason)
    }
  }
  // A declined assignment the front desk still has to acknowledge.
  await db.insert(doctorAssignments).values({
    patientId: input.patientIds[28], providerId: doctorId('Dr. Vikram Shetty'), visitType: 'outpatient', urgency: 'routine', reason: 'Lump in the neck',
    status: 'declined', declineReason: 'In theatre all afternoon; please book with the duty surgeon', assignedByName: sessions.frontdesk.name, createdAt: earlier(90),
  })

  // ---- 6. Appointments: missed and cancelled in the past, a fortnight ahead -------------------

  await bookAppointment(input.patientIds[29], doctorId('Dr. Meera Iyer'), istAt(day(-4), '10:00'), 'Vaccination and growth check', 'no_show')
  await bookAppointment(input.patientIds[30], doctorId('Dr. Ananya Rao'), istAt(day(-2), '12:00'), 'Thyroid review', 'no_show')
  await bookAppointment(input.patientIds[31], doctorId('Dr. Arjun Reddy'), istAt(day(-3), '15:00'), 'Knee pain on climbing stairs', 'cancelled')
  await bookAppointment(input.patientIds[32], doctorId('Dr. Lakshmi Narayanan'), istAt(day(-1), '11:30'), 'Irregular periods', 'cancelled')
  for (let k = 0; k < 14; k++) {
    const patientId = input.patientIds[33 + (k % 11)]
    const doctor = pickDoctor(k, patientId)
    const reason = OPD_REASONS[doctor.departmentCode][k % OPD_REASONS[doctor.departmentCode].length]
    await bookAppointment(patientId, doctorId(doctor.name), istAt(day(1 + k), `${String(9 + (k % 7)).padStart(2, '0')}:${k % 2 ? '30' : '00'}`), reason)
  }
  // Clinical-research visits for the trial patients, and one video consultation.
  const kunamId = doctorId('Dr. Rajiv Kunam')
  await bookAppointment(input.heroIds[1], kunamId, istAt(today, '15:00'), 'PHQ-9 rescreen')
  await bookAppointment(input.heroIds[3], kunamId, istAt(day(1), '10:30'), 'ASRS follow-up')
  await bookAppointment(input.heroIds[0], kunamId, istAt(day(-7), '11:15'), 'Pre-screening follow-up', 'completed')
  const teleAppt = await bookAppointment(input.heroIds[4], kunamId, istAt(day(2), '18:00'), 'Video consultation: medication review', 'scheduled', 20)
  must(await createTelemedicineSession(teleAppt), 'telemedicine session')

  // ---- 7. Lab: requisitions in every status, home collection -----------------------------------

  const t = (code: string) => refs.labTestIds.get(code)!
  const labs = sessions.labs
  const pathologist = sessions.pathologist
  async function requisition(patientId: string, doctorName: string, codes: string[], at: Date, encounterId: number | null = null) {
    const r = must(await createLabRequisition({ patientId, orderedByProviderId: doctorId(doctorName), labTestIds: codes.map(t), followUp: null, originatingEncounterId: encounterId }, doctorSession(doctorName), at), 'lab requisition')
    return { requisitionId: r.requisition.id, orderIds: r.lines.map((l) => l.orderId) }
  }
  async function collectAndReceive(orderId: number, at: Date) {
    const c = must(await collectLabOrder(orderId, labs, at), 'collect sample')
    must(await receiveLabSample(c.sampleId, labs, plusMinutes(at, 30)), 'receive sample')
  }
  async function result(orderId: number, value: string, flag: 'normal' | 'abnormal' | 'critical', at: Date, unit?: string, referenceRange?: string, notes?: string) {
    must(await recordLabResult(orderId, { value, flag, ...(unit ? { unit } : {}), ...(referenceRange ? { referenceRange } : {}), ...(notes ? { notes } : {}) }, { kind: 'staff', session: labs }, { now: at }), 'lab result')
  }
  const fakeRelease = (at: Date) => ({
    render: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    putBlob: async (path: string) => ({ url: `seed-demo://${path}` }),
    now: () => at,
  })
  let labOrderCount = 0

  // R1: reported (CBC normal + LFT abnormal), from a past visit.
  {
    const v = pastVisits[0]
    const r = await requisition(v.patientId, v.doctor.name, ['CBC-DIFF', 'LFT'], istAt(day(-5), '09:30'), v.encounterId)
    labOrderCount += r.orderIds.length
    for (const id of r.orderIds) await collectAndReceive(id, istAt(day(-5), '09:45'))
    await result(r.orderIds[0], '7.8', 'normal', istAt(day(-5), '13:00'), 'x10^3/µL', '4.0-11.0')
    await result(r.orderIds[1], 'ALT 86', 'abnormal', istAt(day(-5), '13:10'), 'U/L', '7-56', 'Mildly raised transaminases')
    for (const id of r.orderIds) must(await verifyLabResult(id, pathologist, istAt(day(-5), '15:00')), 'verify')
    must(await releaseLabReport(r.requisitionId, pathologist, fakeRelease(istAt(day(-5), '15:30'))), 'release report')
  }
  // R2: critical result entered today, awaiting verification (dengue inpatient).
  {
    const r = await requisition(pid(12), 'Dr. Ananya Rao', ['DENGUE-NS1', 'CBC-DIFF'], istAt(day(-3), '11:00'))
    labOrderCount += r.orderIds.length
    for (const id of r.orderIds) await collectAndReceive(id, istAt(day(-3), '11:15'))
    await result(r.orderIds[0], 'Positive', 'abnormal', istAt(day(-3), '16:00'), undefined, 'Negative')
    must(await verifyLabResult(r.orderIds[0], pathologist, istAt(day(-3), '17:00')), 'verify')
    await result(r.orderIds[1], 'Platelets 38', 'critical', earlier(60), 'x10^3/µL', '150-450', 'Critical value phoned to the ward')
  }
  // R3: received at the bench, awaiting result.
  {
    const v = pastVisits[1]
    const r = await requisition(v.patientId, v.doctor.name, ['HBA1C', 'FBS'], istAt(day(-1), '09:00'), v.encounterId)
    labOrderCount += r.orderIds.length
    for (const id of r.orderIds) await collectAndReceive(id, istAt(day(-1), '09:20'))
  }
  // R4: collected in-house, not yet received.
  {
    const v = pastVisits[2]
    const r = await requisition(v.patientId, v.doctor.name, ['TSH'], earlier(120), v.encounterId)
    labOrderCount += r.orderIds.length
    must(await collectLabOrder(r.orderIds[0], labs, earlier(100)), 'collect sample')
  }
  // R5: ordered today, waiting at the collection counter.
  {
    const encounterId = todayCompleted[0] ?? null
    const patientId = todayPatients[0]
    const doctor = pickDoctor(0, patientId)
    const r = await requisition(patientId, doctor.name, ['LIPID', 'URINE-RM'], earlier(50), encounterId)
    labOrderCount += r.orderIds.length
  }
  // R6: imaging resulted and verified.
  {
    const r = await requisition(pid(49), 'Dr. Arjun Reddy', ['XR-CHEST-1V'], istAt(day(-6), '11:00'))
    labOrderCount += r.orderIds.length
    await collectAndReceive(r.orderIds[0], istAt(day(-6), '11:10'))
    await result(r.orderIds[0], 'No active lung lesion. Cardiac size normal.', 'normal', istAt(day(-6), '12:00'))
    must(await verifyLabResult(r.orderIds[0], pathologist, istAt(day(-6), '12:30')), 'verify')
  }
  // Home collection (patients whose registered PIN is in the service area).
  const localPatients = await db.select({ id: patients.id, addressLine1: patients.addressLine1, city: patients.city, district: patients.district, stateCode: patients.stateCode, pinCode: patients.pinCode, phone: patients.phone })
    .from(patients).where(inArray(patients.pinCode, SERVICE_AREA_PINS.map((p) => p.pinCode)))
  const homePatients = localPatients.filter((p) => input.patientIds.slice(28).includes(p.id)).slice(0, 3)
  const addressOf = (p: (typeof homePatients)[number]) => ({
    line1: p.addressLine1 ?? addressFor(0, 0).addressLine1, city: p.city ?? 'Bengaluru', district: p.district ?? undefined, stateCode: p.stateCode ?? 'IN-KA', pinCode: p.pinCode!,
  })
  if (morningWindow && earlyWindow && homePatients.length === 3) {
    const collectorId = sessions.collector.userId
    // H1: booked for tomorrow morning, collector assigned.
    {
      const p = homePatients[0]
      const r = await requisition(p.id, 'Dr. Ananya Rao', ['KFT', 'CBC-DIFF'], istAt(today, '00:05'))
      labOrderCount += r.orderIds.length
      const b = must(await bookHomeCollection({ patientId: p.id, labOrderIds: r.orderIds, visitDate: day(1), windowId: morningWindow.id, address: addressOf(p), contactPhone: p.phone ?? syntheticMobile(1), notes: 'Ring the bell twice; elderly patient' }, sessions.frontdesk, istAt(today, '00:10')), 'book home collection')
      if (collectorId !== null) must(await assignCollector(b.visit.id, collectorId, sessions.labs, istAt(today, '00:15')), 'assign collector')
    }
    // H2: collected at home yesterday, received and resulted.
    {
      const p = homePatients[1]
      const r = await requisition(p.id, 'Dr. Farhan Qureshi', ['LIPID'], istAt(day(-2), '17:00'))
      labOrderCount += r.orderIds.length
      const b = must(await bookHomeCollection({ patientId: p.id, labOrderIds: r.orderIds, visitDate: day(-1), windowId: earlyWindow.id, address: addressOf(p), contactPhone: p.phone ?? syntheticMobile(2) }, sessions.frontdesk, istAt(day(-2), '17:05')), 'book home collection')
      if (collectorId !== null) must(await assignCollector(b.visit.id, collectorId, sessions.labs, istAt(day(-2), '17:10')), 'assign collector')
      const sampleIds = [...b.sampleIds.values()]
      must(await collectHomeVisit(b.visit.id, sampleIds, sessions.collector, istAt(day(-1), '07:40')), 'collect at home')
      for (const sampleId of sampleIds) must(await receiveLabSample(sampleId, labs, istAt(day(-1), '10:00')), 'receive home sample')
      await result(r.orderIds[0], 'LDL 168', 'abnormal', istAt(day(-1), '14:00'), 'mg/dL', '<100')
    }
    // H3: home visit cancelled at the patient's request, the test then cancelled.
    {
      const p = homePatients[2]
      const r = await requisition(p.id, 'Dr. Ananya Rao', ['CRP'], istAt(day(-2), '18:00'))
      labOrderCount += r.orderIds.length
      const b = must(await bookHomeCollection({ patientId: p.id, labOrderIds: r.orderIds, visitDate: day(-1), windowId: morningWindow.id, address: addressOf(p), contactPhone: p.phone ?? syntheticMobile(3) }, sessions.frontdesk, istAt(day(-2), '18:05')), 'book home collection')
      must(await cancelHomeCollection(b.visit.id, { reason: 'patient_request', note: 'Travelling; will come to the hospital instead' }, sessions.frontdesk, istAt(day(-2), '20:00')), 'cancel home collection')
      must(await cancelLabOrder(r.orderIds[0], 'Ordered in error', labs, istAt(day(-2), '20:05')), 'cancel lab order')
    }
  }

  // ---- 8. Pharmacy: prescriptions, dispenses and their draft charges ---------------------------

  const formulary = await db.select({ id: medications.id, name: medications.name }).from(medications)
  const med = (name: string) => formulary.find((m) => m.name === name)?.id
  const rx: { patientId: string; doctor: string; name: string; cls: string; dose: string; perDay: number; days: number; qty: number; paise: number }[] = [
    { patientId: pastVisits[0].patientId, doctor: pastVisits[0].doctor.name, name: 'Paracetamol 650 mg', cls: 'Analgesic / antipyretic', dose: '650 mg', perDay: 3, days: 3, qty: 9, paise: 2_00 },
    { patientId: pid(12), doctor: 'Dr. Ananya Rao', name: 'Pantoprazole 40 mg', cls: 'Proton pump inhibitor', dose: '40 mg', perDay: 1, days: 5, qty: 5, paise: 8_50 },
    { patientId: pastVisits[3].patientId, doctor: pastVisits[3].doctor.name, name: 'Metformin 500 mg', cls: 'Biguanide', dose: '500 mg', perDay: 2, days: 30, qty: 60, paise: 2_50 },
    { patientId: pastVisits[4].patientId, doctor: pastVisits[4].doctor.name, name: 'Amoxicillin + Clavulanic acid 625 mg', cls: 'Antibiotic', dose: '625 mg', perDay: 2, days: 5, qty: 10, paise: 22_00 },
  ]
  for (const [k, r] of rx.entries()) {
    const medicationId = med(r.name)
    if (medicationId === undefined) continue
    const [episode] = await db.insert(medicationEpisodes).values({
      patientId: r.patientId, name: r.name, medicationClass: r.cls, dose: r.dose, startDate: day(-1), status: 'active', medicationId,
      frequencyPerDay: r.perDay, durationDays: r.days, instructions: 'After food', prescribedByProviderId: doctorId(r.doctor), enteredByName: r.doctor, prescribedAt: istAt(day(-1), '12:00'),
    }).returning({ id: medicationEpisodes.id })
    if (k === rx.length - 1) continue // left in the pharmacy queue, not yet dispensed
    const d = await dispenseMedication({ patientId: r.patientId, medicationId, medicationEpisodeId: episode.id, quantity: r.qty, dispensedByName: sessions.pharmacy.name, notes: null })
    if (!d.ok || d.dispenseId === undefined) throw new Error(`Seed step failed: dispense (${d.error})`)
    must(await createChargeForDispense({
      dispenseId: d.dispenseId, patientId: r.patientId, providerName: r.doctor, dateOfService: today,
      diagnosisCode: { code: '', description: 'Dispensed against prescription' },
      procedureCode: { code: `RX-${medicationId}`, description: r.name, units: r.qty, chargeCents: r.paise },
      amountCents: r.qty * r.paise, serviceDate: today, createdByName: sessions.pharmacy.name,
    }, sessions.pharmacy), 'dispense charge')
  }

  // ---- 9. Booking requests, messages, portal ---------------------------------------------------

  await db.insert(bookingRequests).values([
    { requesterName: 'Nagaraj Swamy', requesterDob: '1967-04-21', requesterPhone: syntheticMobile(81001), preferredProviderId: doctorId('Dr. Farhan Qureshi'), preferredDateRangeStart: day(1), preferredDateRangeEnd: day(5), reason: 'Breathlessness on walking', submittedAt: earlier(200) },
    { requesterName: 'Priyanka Hebbar', requesterDob: '1996-08-02', requesterEmail: 'priyanka.hebbar.demo@example.com', preferredProviderId: doctorId('Dr. Lakshmi Narayanan'), preferredDateRangeStart: day(2), preferredDateRangeEnd: day(9), reason: 'First antenatal visit', submittedAt: earlier(30) },
    { requesterName: 'Mohan Lal', requesterDob: '1958-12-11', requesterPhone: syntheticMobile(81003), preferredProviderId: null, preferredDateRangeStart: day(0), preferredDateRangeEnd: day(3), reason: 'Blood sugar check and medicine refill', submittedAt: istAt(day(-1), '19:30') },
    { requesterName: 'Ritu Agarwal', requesterDob: '1989-03-15', requesterPhone: syntheticMobile(81004), preferredProviderId: doctorId('Dr. Arjun Reddy'), preferredDateRangeStart: day(-3), preferredDateRangeEnd: day(-1), reason: 'Shoulder pain', status: 'declined', reviewedByName: sessions.frontdesk.name, reviewedAt: istAt(day(-3), '10:00'), declineReason: 'Doctor on leave that week; asked to rebook', submittedAt: istAt(day(-4), '09:00') },
  ])

  const thread = (patientId: string, rows: { from: 'provider' | 'patient'; name: string; body: string; at: Date; read?: boolean }[]) => rows.map((m) => ({
    patientId, senderRole: m.from, senderName: m.name, body: m.body, createdAt: m.at,
    readByPatientAt: m.from === 'provider' && m.read ? plusMinutes(m.at, 30) : null,
    readByProviderAt: m.from === 'patient' && m.read ? plusMinutes(m.at, 30) : null,
  }))
  await db.insert(messages).values([
    ...thread(input.heroIds[0], [
      { from: 'patient', name: 'Meera Krishnan', body: 'Doctor, can I take the new tablet at night instead of morning?', at: istAt(day(-2), '20:10'), read: true },
      { from: 'provider', name: 'Dr. Rajiv Kunam', body: 'Yes, you can take it after dinner. Continue the same dose.', at: istAt(day(-1), '09:15'), read: true },
    ]),
    ...thread(input.heroIds[3], [
      { from: 'patient', name: 'Ananya Iyer', body: 'Is my appointment tomorrow still at 10:30?', at: earlier(25) },
    ]),
    ...thread(pid(12), [
      { from: 'patient', name: 'Patient family', body: 'When will the platelet count be repeated?', at: earlier(70) },
    ]),
  ])

  // Policies and portal: a portal password is set separately by seed.ts (it owns the demo password).
  return { encounters: encounterCount, admissions: admissionIds.length, labOrders: labOrderCount, invoices: invoiceCount }
}
