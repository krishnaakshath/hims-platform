// WS2 T8 (spec ruling 7): a dispense bills itself in its own transaction (MRP-backed GST line,
// batch/expiry snapshot), and pharmacy sets the MRP. Runs against the worktree's isolated test DB;
// the session is mocked and every row is a TEST fixture removed afterwards.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  admissions, allergies, auditLog, billingSettings, chargeLines, encounters, medicationBatches, medicationDispenses, medicationEpisodes, medicationInventory,
  medications, patients, payers, prescriptions, providers,
} from '@/db/schema'
import type { Role } from '@/lib/auth'
import { purgeBillingFixtures } from '../db/billing-fixtures'

let sessionRole: Role = 'pharmacy'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: 'TEST_WS2T8 Pharmacist', userId: null })) }
})

import { POST as dispenseRoute } from '@/app/api/pharmacy/dispense/route'
import { PATCH as patchPrice } from '@/app/api/pharmacy/medications/[id]/price/route'
import { loadPharmacyKpis } from '@/lib/queries/hospital-kpis'
import { todayIsoIn } from '@/lib/india-time'

const TAG = `TWS2T8-${Date.now()}`
const OPD = `${TAG}-O` // outpatient with a prescription on a visit
const IPD = `${TAG}-I` // admitted
const ALG = `${TAG}-A` // penicillin allergy
const PIDS = [OPD, IPD, ALG]
const med = { priced: 0, unpriced: 0, amox: 0, plain: 0 }
let providerId = 0
let encounterId = 0
let cancelledEncounterId = 0
let admissionId = 0

function req(body: unknown, method = 'POST') {
  return new Request('http://localhost', { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}
const dispense = (body: Record<string, unknown>) => dispenseRoute(req(body) as never)
const BATCH = { batchNo: 'B1234', expiryMonth: '2099-12' }

async function stockOf(medicationId: number) {
  const [inv] = await getDb().select({ q: medicationInventory.quantityOnHand }).from(medicationInventory).where(eq(medicationInventory.medicationId, medicationId))
  return inv.q
}
async function setStock(medicationId: number, q: number) {
  await getDb().update(medicationInventory).set({ quantityOnHand: q }).where(eq(medicationInventory.medicationId, medicationId))
}
async function linesFor(dispenseId: number) {
  return getDb().select().from(chargeLines).where(eq(chargeLines.medicationDispenseId, dispenseId))
}
async function episodeOn(patientId: string, encounter: number | null, medicationId: number, name: string) {
  const db = getDb()
  const [rx] = await db.insert(prescriptions).values({ patientId, encounterId: encounter, prescribedByProviderId: providerId, enteredByName: 'TEST_WS2T8' }).returning()
  const [ep] = await db.insert(medicationEpisodes).values({
    patientId, name, medicationClass: 'Test', dose: '1 tab', startDate: '2026-10-20', status: 'active', medicationId,
    prescriptionId: rx.id, quantityPrescribed: 15, prescribedByProviderId: providerId, enteredByName: 'TEST_WS2T8',
  }).returning()
  return ep.id
}

beforeAll(async () => {
  const db = getDb()
  const [prov] = await db.select({ id: providers.id }).from(providers).where(eq(providers.isActive, true)).limit(1)
  providerId = prov.id
  await db.insert(patients).values(PIDS.map((id) => ({ id, name: `TEST_WS2T8 ${id.slice(-1)}`, dob: '1990-01-01' })))
  const [e] = await db.insert(encounters).values({ patientId: OPD, encounterType: 'opd', status: 'in_consultation', encounterDate: '2026-10-20', providerId, checkedInByName: 'TEST_WS2T8' }).returning()
  encounterId = e.id
  const [c] = await db.insert(encounters).values({ patientId: OPD, encounterType: 'opd', status: 'cancelled', encounterDate: '2026-10-19', providerId, checkedInByName: 'TEST_WS2T8' }).returning()
  cancelledEncounterId = c.id
  const [a] = await db.insert(admissions).values({ patientId: IPD, attendingProviderId: providerId, admittedAt: new Date('2026-10-18T06:00:00Z') }).returning()
  admissionId = a.id
  const rows = await db.insert(medications).values([
    { name: `${TAG} Dolo 650`, genericName: 'Paracetamol', medicationClass: 'Analgesic', form: 'tablet', mrpPerUnitPaise: 350, gstRateBp: 1200, hsn: '30049099' },
    { name: `${TAG} Unpriced`, genericName: null, medicationClass: 'Test', form: 'tablet' },
    { name: `${TAG} Mox 500`, genericName: 'Amoxicillin', medicationClass: 'Antibiotic', form: 'capsule', mrpPerUnitPaise: 1000, gstRateBp: 1200 },
    { name: `${TAG} Plain`, genericName: null, medicationClass: 'Test', form: 'tablet', mrpPerUnitPaise: 105 },
  ]).returning()
  ;[med.priced, med.unpriced, med.amox, med.plain] = rows.map((r) => r.id)
  await db.insert(medicationInventory).values(rows.map((r) => ({ medicationId: r.id, quantityOnHand: 100, unit: 'tablets' })))
  await db.insert(allergies).values({ patientId: ALG, allergen: 'Penicillin', severity: 'severe' })
})

afterEach(async () => {
  sessionRole = 'pharmacy'
  const db = getDb()
  await purgeBillingFixtures(PIDS)
  await db.delete(medicationDispenses).where(inArray(medicationDispenses.patientId, PIDS))
  await db.delete(medicationEpisodes).where(inArray(medicationEpisodes.patientId, PIDS))
  await db.delete(prescriptions).where(inArray(prescriptions.patientId, PIDS))
  for (const id of Object.values(med)) await setStock(id, 100)
})

afterAll(async () => {
  const db = getDb()
  await db.delete(allergies).where(inArray(allergies.patientId, PIDS))
  await db.delete(admissions).where(inArray(admissions.patientId, PIDS))
  await db.delete(encounters).where(inArray(encounters.patientId, PIDS))
  const ids = Object.values(med)
  await db.delete(medicationBatches).where(inArray(medicationBatches.medicationId, ids)) // WS5: dispensing creates the OPENING batch
  await db.delete(medicationInventory).where(inArray(medicationInventory.medicationId, ids))
  await db.delete(medications).where(inArray(medications.id, ids))
  await db.delete(patients).where(inArray(patients.id, PIDS))
})

describe('POST /api/pharmacy/dispense bills the dispense', () => {
  it('a prescription on an OPD visit: one MRP-backed line on that encounter, batch/expiry snapshot, no legacy charge', async () => {
    const episodeId = await episodeOn(OPD, encounterId, med.priced, `${TAG} Dolo 650`)
    const res = await dispense({ patientId: OPD, medicationId: med.priced, medicationEpisodeId: episodeId, quantity: 15, ...BATCH })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.message).toBe('Dispensed 15 tablets. ₹52.42 added to the bill.')
    expect(body.charge).toEqual({ lineId: expect.any(Number), quantity: 15, unitMrpPaise: 350, totalPaise: 5242 })

    const [d] = await getDb().select().from(medicationDispenses).where(eq(medicationDispenses.id, body.id))
    expect(d).toMatchObject({ batchNo: 'B1234', expiryMonth: '2099-12', unitMrpPaise: 350, noChargeReason: null, chargeId: null, quantity: 15 })
    const lines = await linesFor(body.id)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      id: body.charge.lineId, patientId: OPD, encounterId, admissionId: null, source: 'pharmacy', priceSource: 'pharmacy', serviceId: null,
      itemCode: `MED-${med.priced}`, itemName: `${TAG} Dolo 650 (Batch B1234, Exp 12/2099)`, quantity: 15, unitPricePaise: 312, taxablePaise: 4680,
      gstRateBp: 1200, hsnSac: '30049099', status: 'captured', legacyChargeId: null, createdByName: 'TEST_WS2T8 Pharmacist',
    })
    expect(await stockOf(med.priced)).toBe(85)
    const [audit] = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, OPD), eq(auditLog.action, 'dispensed medication'))).orderBy(desc(auditLog.id)).limit(1)
    expect(audit.details).toBe(`dispense=${body.id} line=${body.charge.lineId}`)
  })

  it('an admitted patient: the line goes on the active admission', async () => {
    const res = await dispense({ patientId: IPD, medicationId: med.priced, quantity: 2, ...BATCH })
    expect(res.status).toBe(201)
    const body = await res.json()
    const [line] = await linesFor(body.id)
    expect(line).toMatchObject({ admissionId, encounterId: null })
  })

  // WS2 T14 (ruling on T8): a pharmacy line in an admission follows the automatic bill-to rule
  // (autoBillTo: the primary payer when set), at the same MRP-backed price; an OPD line stays self-pay.
  it('an admitted patient with a primary payer: the line bills the payer, at the MRP-backed price', async () => {
    const db = getDb()
    const [payer] = await db.insert(payers).values({ name: `${TAG} Insurer`, payerId: `${TAG}-P`, requiresPreauth: true }).returning()
    await db.update(patients).set({ primaryPayerId: payer.id }).where(inArray(patients.id, [IPD, OPD]))
    try {
      const res = await dispense({ patientId: IPD, medicationId: med.priced, quantity: 15, ...BATCH })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.charge).toEqual({ lineId: expect.any(Number), quantity: 15, unitMrpPaise: 350, totalPaise: 5242 })
      const lines = await linesFor(body.id)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({ admissionId, encounterId: null, payerId: payer.id, unitPricePaise: 312, taxablePaise: 4680, priceSource: 'pharmacy', serviceId: null })

      const opd = await dispense({ patientId: OPD, medicationId: med.priced, quantity: 1, ...BATCH })
      expect(opd.status).toBe(201)
      const [opdLine] = await linesFor((await opd.json()).id)
      expect(opdLine.payerId).toBeNull()
    } finally {
      await purgeBillingFixtures(PIDS)
      await db.update(patients).set({ primaryPayerId: null }).where(inArray(patients.id, PIDS))
      await db.delete(payers).where(eq(payers.id, payer.id))
    }
  })

  it('a prescription on a cancelled visit: a line with no visit or stay', async () => {
    const episodeId = await episodeOn(OPD, cancelledEncounterId, med.priced, `${TAG} Dolo 650`)
    const res = await dispense({ patientId: OPD, medicationId: med.priced, medicationEpisodeId: episodeId, quantity: 1, ...BATCH })
    expect(res.status).toBe(201)
    const [line] = await linesFor((await res.json()).id)
    expect(line).toMatchObject({ admissionId: null, encounterId: null })
  })

  // Final fix wave (item 1): a visit cancel detaches the visit's live pharmacy lines (the medicine
  // was dispensed; the line is not voided) so they bill on their own as context-less ready lines.
  describe('a visit cancel after a dispense on that visit', () => {
    const admin = { role: 'admin' as const, name: 'TEST_WS2T8 Admin', userId: null }
    const LATER = new Date('2099-07-01T09:00:00Z')
    async function dispenseOnNewVisit() {
      const [v] = await getDb().insert(encounters).values({ patientId: OPD, encounterType: 'opd', status: 'checked_in', encounterDate: '2026-10-21', providerId, checkedInByName: 'TEST_WS2T8' }).returning()
      const episodeId = await episodeOn(OPD, v.id, med.priced, `${TAG} Dolo 650`)
      const res = await dispense({ patientId: OPD, medicationId: med.priced, medicationEpisodeId: episodeId, quantity: 2, ...BATCH })
      expect(res.status).toBe(201)
      const [line] = await linesFor((await res.json()).id)
      expect(line).toMatchObject({ encounterId: v.id, admissionId: null, status: 'captured' })
      return { visitId: v.id, line }
    }
    const lineById = async (id: number) => (await getDb().select().from(chargeLines).where(eq(chargeLines.id, id)))[0]

    it('the line stays live with no visit (encounter_id null), is audited as detached, and is invoice-ready', async () => {
      const { transitionEncounter } = await import('@/lib/queries/encounters')
      const { previewInvoiceReady, listUnbilledOrders } = await import('@/lib/queries/invoice-ready')
      const { visitId, line } = await dispenseOnNewVisit()
      const c = await transitionEncounter(visitId, 'cancelled', admin, { cancelReason: 'Left', now: LATER })
      expect(c.ok).toBe(true)
      const after = await lineById(line.id)
      expect([after.status, after.encounterId, after.admissionId, after.invoiceId, after.voidReason]).toEqual(['captured', null, null, null, null])
      const audits = (await getDb().select().from(auditLog).where(eq(auditLog.patientId, OPD))).map((a) => `${a.action}|${a.details}`)
      expect(audits).toContain(`billing: pharmacy line detached|line=${line.id} cause=visit_cancelled`)
      expect(await previewInvoiceReady({ patientId: OPD })).toMatchObject({ lines: 1, taxablePaise: after.taxablePaise, waitingLines: 0 })
      expect((await listUnbilledOrders()).filter((o) => o.patientId === OPD)).toEqual([])
    })

    it('a line on a draft invoice leaves the draft and is detached', async () => {
      const { transitionEncounter } = await import('@/lib/queries/encounters')
      const { createDraftInvoice } = await import('@/lib/queries/invoices')
      const { visitId, line } = await dispenseOnNewVisit()
      const d = await createDraftInvoice([line.id], admin)
      expect(d.ok).toBe(true)
      expect((await transitionEncounter(visitId, 'cancelled', admin, { cancelReason: 'Left', now: LATER })).ok).toBe(true)
      const after = await lineById(line.id)
      expect([after.status, after.encounterId, after.invoiceId]).toEqual(['captured', null, null])
    })

    it('a line on a finalised invoice keeps the visit_billed refusal and nothing changes', async () => {
      const { transitionEncounter } = await import('@/lib/queries/encounters')
      const { createDraftInvoice, finaliseInvoice } = await import('@/lib/queries/invoices')
      const db = getDb()
      const [saved] = await db.select().from(billingSettings).where(eq(billingSettings.id, 1))
      await db.update(billingSettings).set({ legalName: 'Test WS2T8 Hospital', stateCode: 'IN-KA', gstin: '29AAGCB7383J1Z4', placeOfSupplyMode: 'location_of_service' }).where(eq(billingSettings.id, 1))
      try {
        const { visitId, line } = await dispenseOnNewVisit()
        const d = await createDraftInvoice([line.id], admin)
        if (!d.ok) throw new Error(d.error)
        const f = await finaliseInvoice(d.invoiceId, admin, new Date('2099-07-01T06:00:00Z'))
        if (!f.ok) throw new Error(f.error)
        expect(await transitionEncounter(visitId, 'cancelled', admin, { cancelReason: 'Left', now: LATER }))
          .toEqual({ ok: false, error: 'visit_billed', invoiceNumber: f.invoiceNumber })
        const after = await lineById(line.id)
        expect([after.status, after.encounterId, after.invoiceId]).toEqual(['invoiced', visitId, d.invoiceId])
      } finally {
        await purgeBillingFixtures(PIDS)
        if (saved) await db.update(billingSettings).set(saved).where(eq(billingSettings.id, 1))
      }
    })
  })

  it('a medicine with no own GST rate or HSN uses the billing settings defaults', async () => {
    const [s] = await getDb().select().from(billingSettings).where(eq(billingSettings.id, 1))
    const res = await dispense({ patientId: OPD, medicationId: med.plain, quantity: 3, ...BATCH })
    expect(res.status).toBe(201)
    const [line] = await linesFor((await res.json()).id)
    expect(line).toMatchObject({ gstRateBp: s.pharmacyGstRateBp, hsnSac: s.pharmacyHsn })
  })

  it('an unpriced medicine is 422 medication_unpriced and leaves stock untouched', async () => {
    const res = await dispense({ patientId: OPD, medicationId: med.unpriced, quantity: 5, ...BATCH })
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe('medication_unpriced')
    expect(await stockOf(med.unpriced)).toBe(100)
  })

  it('an expired batch is 422 batch_expired; a charged dispense without batch or expiry is 422 batch_required', async () => {
    const expired = await dispense({ patientId: OPD, medicationId: med.priced, quantity: 5, batchNo: 'OLD1', expiryMonth: '2020-01' })
    expect(expired.status).toBe(422)
    expect((await expired.json()).code).toBe('batch_expired')
    const noBatch = await dispense({ patientId: OPD, medicationId: med.priced, quantity: 5, expiryMonth: '2099-12' })
    expect(noBatch.status).toBe(422)
    expect((await noBatch.json()).code).toBe('batch_required')
    const noExpiry = await dispense({ patientId: OPD, medicationId: med.priced, quantity: 5, batchNo: 'B1' })
    expect(noExpiry.status).toBe(422)
    expect((await noExpiry.json()).code).toBe('batch_required')
    expect(await stockOf(med.priced)).toBe(100)
  })

  it('a no-charge dispense (even of an unpriced medicine) is 201 with charge null and is not counted as unbilled', async () => {
    const before = (await loadPharmacyKpis(todayIsoIn())).unbilledDispenses
    const res = await dispense({ patientId: OPD, medicationId: med.unpriced, quantity: 2, noChargeReason: 'Free sample for the trial' })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.charge).toBeNull()
    expect(body.message).toBe('Dispensed 2 tablets at no charge.')
    expect(await linesFor(body.id)).toHaveLength(0)
    expect((await loadPharmacyKpis(todayIsoIn())).unbilledDispenses).toBe(before)
    const [audit] = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, OPD), eq(auditLog.action, 'dispensed medication'))).orderBy(desc(auditLog.id)).limit(1)
    expect(audit.details).toBe(`dispense=${body.id} line=none`)
  })

  it('an allergy conflict is 409 with the conflicts, then 201 once acknowledged', async () => {
    const first = await dispense({ patientId: ALG, medicationId: med.amox, quantity: 10, ...BATCH })
    expect(first.status).toBe(409)
    const body = await first.json()
    expect(body.code).toBe('allergy_conflict')
    expect(body.conflicts).toEqual([expect.objectContaining({ allergen: 'Penicillin', severity: 'severe' })])
    expect(await stockOf(med.amox)).toBe(100)
    const second = await dispense({ patientId: ALG, medicationId: med.amox, quantity: 10, ...BATCH, allergyAcknowledged: true })
    expect(second.status).toBe(201)
    expect(await stockOf(med.amox)).toBe(90)
  })

  it('the same payload twice makes two dispenses only while stock allows, each with its own line', async () => {
    await setStock(med.priced, 20)
    const payload = { patientId: OPD, medicationId: med.priced, quantity: 10, ...BATCH }
    const results = await Promise.all([dispense(payload), dispense(payload), dispense(payload)])
    const statuses = results.map((r) => r.status).sort()
    expect(statuses).toEqual([201, 201, 409])
    const created = await getDb().select({ id: medicationDispenses.id }).from(medicationDispenses).where(eq(medicationDispenses.patientId, OPD))
    expect(created).toHaveLength(2)
    for (const d of created) expect(await linesFor(d.id)).toHaveLength(1)
    expect(await stockOf(med.priced)).toBe(0)
  })

  it('rejects a body with unknown keys and an out-of-range quantity', async () => {
    expect((await dispense({ patientId: OPD, medicationId: med.priced, quantity: 1, ...BATCH, diagnosisId: 1 })).status).toBe(400)
    expect((await dispense({ patientId: OPD, medicationId: med.priced, quantity: 1001, ...BATCH })).status).toBe(400)
  })
})

describe('no HCPCS J3490 remains', () => {
  it('src/ has no J3490 string', () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx|sql)$/.test(name) && readFileSync(p, 'utf8').includes('J3490')) hits.push(p)
      }
    }
    walk(join(process.cwd(), 'src'))
    expect(hits).toEqual([])
  })
})

describe('PATCH /api/pharmacy/medications/[id]/price', () => {
  const patch = (id: number, body: unknown) => patchPrice(req(body, 'PATCH') as never, { params: Promise.resolve({ id: String(id) }) })

  it('billing is 403', async () => {
    sessionRole = 'billing'
    expect((await patch(med.plain, { mrpPerUnitPaise: 200 })).status).toBe(403)
  })

  it('pharmacy sets the MRP, GST and HSN; the audit carries the old and new amounts only', async () => {
    const res = await patch(med.plain, { mrpPerUnitPaise: 240, gstRateBp: 500, hsn: '3004' })
    expect(res.status).toBe(200)
    const [m] = await getDb().select().from(medications).where(eq(medications.id, med.plain))
    expect(m).toMatchObject({ mrpPerUnitPaise: 240, gstRateBp: 500, hsn: '3004' })
    const [audit] = await getDb().select().from(auditLog).where(eq(auditLog.action, 'set medication price')).orderBy(desc(auditLog.id)).limit(1)
    expect(audit.details).toBe(`medication=${med.plain} mrp=105→240 gst=default→500`)
    expect(audit.details).not.toContain(TAG)
    // Omitted fields stay; null clears back to the default.
    expect((await patch(med.plain, { mrpPerUnitPaise: 105, gstRateBp: null, hsn: null })).status).toBe(200)
    const [back] = await getDb().select().from(medications).where(eq(medications.id, med.plain))
    expect(back).toMatchObject({ mrpPerUnitPaise: 105, gstRateBp: null, hsn: null })
  })

  it('a bad body is 400, an unknown medication 404', async () => {
    expect((await patch(med.plain, { mrpPerUnitPaise: 100, gstRateBp: 700 })).status).toBe(400)
    expect((await patch(med.plain, { mrpPerUnitPaise: 100, name: 'x' })).status).toBe(400)
    expect((await patch(999999999, { mrpPerUnitPaise: 100 })).status).toBe(404)
  })
})
