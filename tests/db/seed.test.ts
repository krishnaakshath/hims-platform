import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  trials, patients, charges, insuranceClaims, patientStatements, mockPayments, providers, appointments, rooms, documents, faxes,
  broadcasts, reviews, departments, payers, serviceCatalog, tariffRates, roomCategories, billingSettings, patientAadhaar,
  encounters, admissions, labOrders, homeCollectionVisits, diagnoses, chargeLines, invoices, patientPayments, followUpOrders,
  encounterCoding, codeSystems, users,
} from '@/db/schema'
import { seed, seedResetRequested } from '@/db/seed'
import { SYNTHETIC_AADHAAR_PREFIX, SYNTHETIC_AADHAAR_RECORDED_BY } from '@/db/seed-india-data'
import { parseUhid } from '@/lib/uhid'
import { isIndianStateCode, isValidPinCode } from '@/lib/india/reference'
import { normalizePhone } from '@/lib/india/phone'
import { decryptSensitive } from '@/lib/crypto'
import { isValidAadhaar } from '@/lib/india/aadhaar'
import { recallBucket } from '@/lib/follow-ups/rules'
import { todayIsoIn, istDateOf } from '@/lib/india-time'

// seed() only tops up a database that already has patients; the full Indian hospital demo
// (visits, admissions, lab work, bills) is written on a fresh database or with SEED_RESET=1.
// Tests of that operational data are skipped, with a note, until the demo has been rebuilt
// once (`SEED_RESET=1 npm run db:seed`) -- they never reset a shared database themselves.
let rebuilt = false

describe('seed', () => {
  beforeAll(async () => {
    await seed({ reset: false })
    const [{ n }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(encounters)
    rebuilt = n > 0
  }, 120000)

  it('SEED_RESET=1 (and only that) asks for a rebuild', () => {
    expect(seedResetRequested({ SEED_RESET: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true)
    expect(seedResetRequested({ SEED_RESET: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(seedResetRequested({} as NodeJS.ProcessEnv)).toBe(false)
  })

  it('creates exactly 2 trials covering different conditions', async () => {
    const rows = await getDb().select().from(trials)
    expect(rows.length).toBe(2)
    const conditions = rows.map((r) => r.condition)
    expect(new Set(conditions).size).toBe(2)
  })

  it('creates at least 15 patients, every one with a valid UHID', async () => {
    const rows = await getDb().select({ id: patients.id, uhid: patients.uhid }).from(patients)
    expect(rows.length).toBeGreaterThanOrEqual(15)
    for (const r of rows) expect(r.uhid !== null && parseUhid(r.uhid) !== null, r.id).toBe(true)
  })

  it('creates charges covering every status in the workflow', async () => {
    const rows = await getDb().select().from(charges)
    expect(rows.length).toBeGreaterThanOrEqual(11)
    const statuses = new Set(rows.map((r) => r.status))
    expect(statuses).toEqual(new Set(['draft', 'pending_approval', 'approved', 'submitted']))
  })

  it('creates insurance claims covering rejected/denied/waiting/needs-investigation/paid', async () => {
    const rows = await getDb().select().from(insuranceClaims)
    const statuses = new Set(rows.map((r) => r.status))
    expect(statuses).toEqual(new Set(['rejected', 'denied', 'waiting_adjudication', 'needs_investigation', 'paid']))
  })

  it('creates patient statements and mock payments', async () => {
    const statements = await getDb().select().from(patientStatements)
    const payments = await getDb().select().from(mockPayments)
    expect(statements.length).toBeGreaterThanOrEqual(4)
    expect(payments.length).toBeGreaterThanOrEqual(2)
    expect(payments.some((p) => p.result === 'success')).toBe(true)
    expect(payments.some((p) => p.result === 'failed')).toBe(true)
  })

  it('creates the doctor roster with departments, NMC/SMC registrations and fees in paise', async () => {
    const rows = await getDb().select().from(providers)
    const indian = rows.filter((r) => r.registrationNumber?.startsWith('DEMO/'))
    expect(indian.length).toBeGreaterThanOrEqual(8)
    for (const p of indian) {
      expect(p.departmentId, p.name).not.toBeNull()
      expect(p.registrationCouncil, p.name).not.toBeNull()
      expect(p.consultationFeePaise, p.name).not.toBeNull()
      expect(p.colorTag).toMatch(/^chart-[1-5]$/)
    }
  })

  it('creates categorised rooms across multiple wards', async () => {
    const rows = await getDb().select().from(rooms)
    expect(rows.length).toBeGreaterThanOrEqual(6)
    expect(new Set(rows.map((r) => r.ward)).size).toBeGreaterThanOrEqual(2)
    const categorised = rows.filter((r) => r.roomCategoryId !== null)
    expect(new Set(categorised.map((r) => r.roomCategoryId)).size).toBeGreaterThanOrEqual(4)
  })

  it('creates appointments spanning multiple statuses', async () => {
    const rows = await getDb().select().from(appointments)
    expect(rows.length).toBeGreaterThanOrEqual(10)
    const statuses = new Set(rows.map((r) => r.status))
    expect(statuses.has('scheduled')).toBe(true)
    expect(statuses.has('completed')).toBe(true)
    expect(statuses.has('cancelled')).toBe(true)
    expect(statuses.has('no_show')).toBe(true)
  })
})

describe('India masters (topped up on every run)', () => {
  it('departments, Indian payers, room categories, services and every kind of tariff exist', async () => {
    const db = getDb()
    const deptCodes = new Set((await db.select({ code: departments.code }).from(departments)).map((d) => d.code))
    for (const c of ['GEN_MED', 'CARDIO', 'OBG', 'LAB', 'PSYCH']) expect(deptCodes.has(c)).toBe(true)
    const payerNames = (await db.select({ name: payers.name }).from(payers)).map((p) => p.name)
    for (const n of ['Star Health and Allied Insurance', 'Medi Assist TPA', 'Ayushman Bharat PM-JAY']) expect(payerNames).toContain(n)
    expect((await db.select().from(roomCategories)).length).toBeGreaterThanOrEqual(4)
    expect((await db.select().from(serviceCatalog)).length).toBeGreaterThanOrEqual(20)
    const rates = await db.select().from(tariffRates)
    expect(rates.some((r) => r.scope === 'base' && r.roomCategoryId !== null)).toBe(true)
    expect(rates.some((r) => r.scope === 'payer')).toBe(true)
    expect(rates.some((r) => r.scope === 'department')).toBe(true)
    expect(rates.every((r) => Number.isInteger(r.amountPaise) && r.currency === 'INR')).toBe(true)
  })

  it('billing settings carry the hospital, its state and the room-rent service', async () => {
    const [s] = await getDb().select().from(billingSettings)
    expect(s.legalName).toBeTruthy()
    expect(isIndianStateCode(s.stateCode ?? '')).toBe(true)
    expect(s.roomRentServiceId).not.toBeNull()
  })

  it('the fictional SAMPLE code sets are loaded for coding', async () => {
    const rows = await getDb().select().from(codeSystems)
    expect(rows.some((r) => r.kind === 'icd10')).toBe(true)
  })
})

describe('India hospital demo (after a fresh seed or SEED_RESET=1)', () => {
  const today = () => todayIsoIn()

  it('patients carry Indian addresses, +91 mobiles, ABHA numbers and synthetic, encrypted Aadhaar', async (ctx) => {
    if (!rebuilt) ctx.skip()
    const db = getDb()
    const rows = await db.select().from(patients)
    for (const p of rows) {
      expect(isIndianStateCode(p.stateCode ?? ''), p.id).toBe(true)
      expect(isValidPinCode(p.pinCode ?? ''), p.id).toBe(true)
      if (p.phone !== null) expect(normalizePhone(p.phone), p.id).toBe(p.phone)
    }
    expect(rows.filter((p) => p.abhaNumber !== null).length).toBeGreaterThanOrEqual(10)
    const aadhaar = await db.select().from(patientAadhaar)
    const provided = aadhaar.filter((a) => a.aadhaarEncrypted !== null)
    expect(provided.length).toBeGreaterThanOrEqual(10)
    expect(aadhaar.some((a) => a.declineReason !== null)).toBe(true)
    for (const a of provided) {
      const value = decryptSensitive(a.aadhaarEncrypted!)
      // Asserted, never printed.
      expect(isValidAadhaar(value) && value.startsWith(SYNTHETIC_AADHAAR_PREFIX)).toBe(true)
      expect(a.aadhaarLast4).toBe(value.slice(-4))
      expect(a.recordedByName).toBe(SYNTHETIC_AADHAAR_RECORDED_BY)
    }
  })

  it('there is work today: appointments, checked-in OPD visits, a pending walk-in and inpatients', async (ctx) => {
    if (!rebuilt) ctx.skip()
    const db = getDb()
    const appts = await db.select().from(appointments)
    expect(appts.filter((a) => istDateOf(a.startsAt) === today()).length).toBeGreaterThanOrEqual(5)
    const enc = await db.select().from(encounters)
    const todays = enc.filter((e) => e.encounterDate === today())
    for (const s of ['checked_in', 'in_consultation', 'completed'] as const) expect(todays.some((e) => e.status === s), s).toBe(true)
    expect(todays.every((e) => e.opdToken !== null && e.opdToken > 0)).toBe(true)
    expect(enc.some((e) => e.encounterType === 'ipd')).toBe(true)
    const adm = await db.select().from(admissions)
    expect(adm.filter((a) => a.status === 'admitted').length).toBeGreaterThanOrEqual(3)
    expect(adm.some((a) => a.status === 'discharged' && a.dischargeDiagnosis)).toBe(true)
  })

  it('lab orders cover every status, with home collection booked, collected and cancelled', async (ctx) => {
    if (!rebuilt) ctx.skip()
    const db = getDb()
    const statuses = new Set((await db.select({ s: labOrders.status }).from(labOrders)).map((r) => r.s))
    for (const s of ['ordered', 'scheduled', 'collected', 'received', 'resulted', 'verified', 'reported', 'cancelled']) expect(statuses.has(s as never), s).toBe(true)
    const visits = new Set((await db.select({ s: homeCollectionVisits.status }).from(homeCollectionVisits)).map((r) => r.s))
    expect(visits).toEqual(new Set(['booked', 'collected', 'cancelled']))
  })

  it('coding: sample-coded diagnoses and encounters in several coding states', async (ctx) => {
    if (!rebuilt) ctx.skip()
    const db = getDb()
    const dx = await db.select().from(diagnoses)
    expect(dx.some((d) => d.codingStatus === 'coded' && d.codeId !== null)).toBe(true)
    const states = new Set((await db.select({ s: encounterCoding.status }).from(encounterCoding)).map((r) => r.s))
    for (const s of ['coded', 'finalised', 'queried']) expect(states.has(s as never), s).toBe(true)
  })

  it('billing: charge lines, draft/finalised/cancelled invoices, receipts and advances in paise', async (ctx) => {
    if (!rebuilt) ctx.skip()
    const db = getDb()
    const lines = await db.select().from(chargeLines)
    expect(lines.some((l) => l.source === 'room_rent')).toBe(true)
    expect(lines.some((l) => l.source === 'pharmacy')).toBe(true)
    expect(lines.some((l) => l.status === 'captured' && l.invoiceId === null)).toBe(true)
    const inv = new Set((await db.select({ s: invoices.status }).from(invoices)).map((r) => r.s))
    for (const s of ['draft', 'finalised', 'cancelled']) expect(inv.has(s as never), s).toBe(true)
    const kinds = new Set((await db.select({ k: patientPayments.kind }).from(patientPayments)).map((r) => r.k))
    expect(kinds).toEqual(new Set(['advance', 'receipt']))
  })

  it('follow-ups fall in every recall bucket', async (ctx) => {
    if (!rebuilt) ctx.skip()
    const rows = await getDb().select().from(followUpOrders)
    const buckets = new Set(rows.map((r) => recallBucket(r.status, r.windowStart, r.windowEnd, today())))
    for (const b of ['due', 'overdue', 'upcoming', 'scheduled', 'missed']) expect(buckets.has(b as never), b).toBe(true)
  })

  it('every staff role has a demo login', async (ctx) => {
    if (!rebuilt) ctx.skip()
    const roles = new Set((await getDb().select({ r: users.role }).from(users)).map((u) => u.r))
    for (const r of ['admin', 'crc', 'pi', 'frontdesk', 'pharmacy', 'billing', 'labs', 'collector', 'coder']) expect(roles.has(r as never), r).toBe(true)
  })
})

describe('documents and faxes seed data', () => {
  it('seeds documents with a mix of New/Processed statuses', async () => {
    const rows = await getDb().select().from(documents)
    expect(rows.length).toBeGreaterThanOrEqual(10)
    expect(rows.some((d) => d.status === 'new')).toBe(true)
    expect(rows.some((d) => d.status === 'processed')).toBe(true)
  })

  it('seeds faxes with a mix of simulated delivered/failed statuses', async () => {
    const rows = await getDb().select().from(faxes)
    expect(rows.length).toBeGreaterThanOrEqual(8)
    expect(rows.some((f) => f.deliveryStatus === 'delivered')).toBe(true)
    expect(rows.some((f) => f.deliveryStatus === 'failed')).toBe(true)
  })
})

describe('broadcasts and reviews seed data', () => {
  it('creates the seeded broadcasts with recipient snapshots', async () => {
    const rows = await getDb().select().from(broadcasts)
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(rows.every((r) => Array.isArray(r.recipients) && r.recipients.length === r.recipientCount)).toBe(true)
  })

  it('creates the seeded pre-screening experience surveys, including at least one still-sent response', async () => {
    const rows = await getDb().select().from(reviews)
    expect(rows.length).toBeGreaterThanOrEqual(3)
    expect(rows.some((r) => r.status === 'sent')).toBe(true)
    expect(rows.some((r) => r.status === 'completed' && r.ratingOverall !== null)).toBe(true)
  })
})

describe('seed source hygiene', () => {
  const sources = ['src/db/seed.ts', 'src/db/seed-india-data.ts', 'src/db/seed-india.ts']
    .map((f) => readFileSync(join(process.cwd(), f), 'utf8'))
    .join('\n')

  it('carries no US demo identities, ZIP codes or US payer rows', () => {
    for (const us of ['Redlands', '909-555', 'Maria Alvarez', 'Loma Linda', "payerId: '60054'", "payerType: 'medicare'", 'chargeCents: 15000']) {
      expect(sources.includes(us), us).toBe(false)
    }
  })

  it('never logs an Aadhaar value', () => {
    expect(/console\.\w+\([^)]*aadhaar/i.test(sources)).toBe(false)
  })

  it('still refuses production and still requires SEED_DEMO_PASSWORD before clearing anything', () => {
    const seedSrc = readFileSync(join(process.cwd(), 'src/db/seed.ts'), 'utf8')
    const body = seedSrc.slice(seedSrc.indexOf('export async function seed('))
    expect(body.indexOf('assertSeedAllowed()')).toBeGreaterThanOrEqual(0)
    expect(body.indexOf('seedDemoPassword()')).toBeLessThan(body.indexOf('await clearExistingData()'))
  })
})
