import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTableConfig } from 'drizzle-orm/pg-core'
import {
  documentCounters, invoices, invoiceLines, creditNotes, patientPayments, refunds, chargeLines,
  documentSeriesEnum, invoiceStatusEnum, paymentModeEnum, patientPaymentKindEnum,
} from '@/db/schema'
import type { InvoiceSnapshot } from '@/lib/billing/gst'
import { readMigration, idempotencyProblems, missingColumns } from './migration-sql'

const MIGRATION = '2026-10-08-sp4-b-invoices-ledger.sql'
const TABLES = [documentCounters, invoices, invoiceLines, creditNotes, patientPayments, refunds] as const
const TRIGGERS = ['invoices_issued_guard', 'invoice_lines_immutable', 'credit_notes_immutable', 'patient_payments_immutable', 'refunds_immutable']

describe('SP4 migration B (invoices and ledger)', () => {
  it('migration B is idempotent and declares every column', () => {
    const s = readMigration(MIGRATION)
    expect(idempotencyProblems(s)).toEqual([])
    for (const t of TABLES) expect(missingColumns(t, s)).toEqual([])
    for (const n of ['invoices_number_when_issued', 'patient_payments_reference_required', 'invoices_issued_guard', 'invoice_lines_immutable', 'pg_trigger']) expect(s).toContain(n)
    expect(s).toMatch(/ALTER TABLE charge_lines ADD COLUMN IF NOT EXISTS invoice_id integer;/)
    expect(s).toContain('charge_lines_invoice_id_invoices_id_fk')
    expect(s).toContain('charge_lines_invoice_idx')
  })

  it('every FK, unique, check, index and primary-key name is in the SQL and fits 63 chars', () => {
    const s = readMigration(MIGRATION)
    for (const t of TABLES) {
      const c = getTableConfig(t)
      const names = [
        ...c.foreignKeys.map((f) => f.getName()), ...c.checks.map((k) => k.name), ...c.indexes.map((i) => i.config.name!),
        ...c.columns.filter((col) => col.isUnique).map((col) => col.uniqueName!), ...c.primaryKeys.map((p) => p.getName()),
      ]
      for (const n of names) {
        expect(n.length, n).toBeLessThanOrEqual(63)
        expect(s, n).toContain(n)
      }
    }
    expect(getTableConfig(documentCounters).primaryKeys.map((p) => p.getName())).toEqual(['document_counters_pk'])
  })

  it('declares no ON DELETE action on any FK (issued documents are never cascaded away)', () => {
    const s = readMigration(MIGRATION)
    for (const t of [...TABLES, chargeLines]) {
      for (const fk of getTableConfig(t).foreignKeys) {
        expect(fk.onDelete ?? 'no action', fk.getName()).toBe('no action')
        const at = s.indexOf(`ADD CONSTRAINT ${fk.getName()}`)
        if (t === chargeLines && at < 0) continue // migration A's FKs
        const block = s.slice(at)
        expect(block.slice(0, block.indexOf(';')), fk.getName()).not.toMatch(/ON DELETE/)
      }
    }
  })

  it('creates each enum type with every value', () => {
    const s = readMigration(MIGRATION)
    expect(documentSeriesEnum.enumValues).toEqual(['invoice', 'receipt', 'credit_note', 'refund'])
    expect(invoiceStatusEnum.enumValues).toEqual(['draft', 'finalised', 'cancelled', 'discarded'])
    expect(paymentModeEnum.enumValues).toEqual(['cash', 'upi', 'card', 'cheque', 'neft', 'other'])
    expect(patientPaymentKindEnum.enumValues).toEqual(['advance', 'receipt'])
    for (const e of [documentSeriesEnum, invoiceStatusEnum, paymentModeEnum, patientPaymentKindEnum]) {
      expect(s, e.enumName).toContain(`CREATE TYPE ${e.enumName} AS ENUM (${e.enumValues.map((v) => `'${v}'`).join(', ')});`)
    }
  })

  it('money: every amount and total is bigint; the per-unit price is int4', () => {
    const type = (t: (typeof TABLES)[number], name: string) => getTableConfig(t).columns.find((c) => c.name === name)!.getSQLType()
    for (const c of ['taxable_paise', 'cgst_paise', 'sgst_paise', 'igst_paise', 'total_paise']) {
      expect(type(invoices, c), `invoices.${c}`).toBe('bigint')
      expect(type(invoiceLines, c), `invoice_lines.${c}`).toBe('bigint')
      expect(type(creditNotes, c), `credit_notes.${c}`).toBe('bigint')
    }
    expect(type(patientPayments, 'amount_paise')).toBe('bigint')
    expect(type(refunds, 'amount_paise')).toBe('bigint')
    expect(type(invoiceLines, 'unit_price_paise')).toBe('integer')
  })

  it('every trigger is created inside a DO block that tests pg_trigger, and the purge setting is documented', () => {
    const s = readMigration(MIGRATION)
    const doBlocks = [...s.matchAll(/DO\s+\$\$[\s\S]*?\$\$\s*;/gi)].map((m) => m[0])
    for (const name of TRIGGERS) {
      const block = doBlocks.find((b) => b.includes(`CREATE TRIGGER ${name}`))
      expect(block, name).toBeDefined()
      expect(block!, name).toMatch(new RegExp(`pg_trigger[\\s\\S]*tgname = '${name}'`))
      expect(block!, name).toMatch(/BEFORE UPDATE OR DELETE/)
    }
    expect(s.match(/CREATE TRIGGER/g)).toHaveLength(TRIGGERS.length)
    expect(s).toContain('CREATE OR REPLACE FUNCTION sp4_reject_issued_change() RETURNS trigger')
    expect(s).toContain('CREATE OR REPLACE FUNCTION sp4_invoice_guard() RETURNS trigger')
    expect(s).toContain("USING ERRCODE = '55000'")
    // Header comment: migration-only objects, and the transaction-local purge setting.
    const header = s.slice(0, s.indexOf('BEGIN;'))
    expect(header).toMatch(/MIGRATION-ONLY/)
    expect(header).toContain("set_config('hims.allow_document_purge', 'on', true)")
  })

  it('seed clears documents children-first inside one purge transaction', () => {
    const src = readFileSync(join(process.cwd(), 'src/db/seed.ts'), 'utf8')
    const body = src.slice(src.indexOf('async function clearExistingData()'), src.indexOf('export async function seed()'))
    const pos = (t: string) => body.search(new RegExp(`\\.delete\\(${t}\\)`))
    const order = ['refunds', 'patientPayments', 'creditNotes', 'invoiceLines', 'chargeLines', 'invoices', 'documentCounters', 'charges']
    for (const t of order) expect(pos(t), t).toBeGreaterThanOrEqual(0)
    for (let i = 1; i < order.length; i++) expect(pos(order[i - 1]), `${order[i - 1]} before ${order[i]}`).toBeLessThan(pos(order[i]))
    const purge = body.indexOf("set_config('hims.allow_document_purge', 'on', true)")
    expect(purge).toBeGreaterThanOrEqual(0)
    expect(purge).toBeLessThan(pos('refunds'))
    expect(body.indexOf('.transaction(')).toBeLessThan(purge)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('invoices and ledger (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const PID = `TEST-SP4-${RUN}`
  const CODE = `TSP4${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`
  const fx = { departmentId: 0, serviceId: 0, providerId: 0, encounterId: 0, seq: 0 }
  const SNAPSHOT: InvoiceSnapshot = {
    hospital: { legalName: 'Test Hospital', gstin: null, stateCode: 'IN-KA', gstStateCode: '29', address: null },
    patient: { id: PID, name: 'Test SP4', uhid: null, addressLine1: null, addressLine2: null, city: null, district: null, stateCode: null, pinCode: null },
    payer: null,
    context: { encounterId: null, admissionId: null, label: 'OPD' },
  }

  async function errorOf(p: Promise<unknown>): Promise<unknown> {
    try { await p } catch (e) { return e }
    return undefined
  }
  const db = async () => (await import('@/db/client')).getDb()
  const code = async (p: Promise<unknown>) => (await import('@/lib/db-errors')).pgErrorCode(await errorOf(p))
  const constraint = async (p: Promise<unknown>) => (await import('@/lib/db-errors')).pgConstraint(await errorOf(p))

  beforeAll(async () => {
    const { patients, providers, departments, serviceCatalog, encounters } = await import('@/db/schema')
    const d = await db()
    const [prov] = await d.select({ id: providers.id }).from(providers).orderBy(providers.id).limit(1)
    fx.providerId = prov.id
    const [dep] = await d.insert(departments).values({ code: CODE, name: `Test SP4 ${RUN}` }).returning()
    fx.departmentId = dep.id
    const [svc] = await d.insert(serviceCatalog).values({ code: CODE, name: 'Test SP4 consult', departmentId: dep.id, category: 'consultation', hsnSac: '999312' }).returning()
    fx.serviceId = svc.id
    await d.insert(patients).values({ id: PID, name: 'Test SP4 Invoices', dob: '1990-01-01' })
    const [enc] = await d.insert(encounters).values({ patientId: PID, encounterType: 'opd', encounterDate: '2099-06-01', providerId: prov.id, checkedInByName: 'TEST-SP4' }).returning()
    fx.encounterId = enc.id
  })

  afterEach(async () => {
    const { purgeBillingFixtures } = await import('./billing-fixtures')
    await purgeBillingFixtures([PID])
  })

  afterAll(async () => {
    const { purgeBillingFixtures } = await import('./billing-fixtures')
    const { patients, departments, serviceCatalog, encounters } = await import('@/db/schema')
    const { eq } = await import('drizzle-orm')
    const d = await db()
    await purgeBillingFixtures([PID])
    await d.delete(encounters).where(eq(encounters.id, fx.encounterId))
    await d.delete(patients).where(eq(patients.id, PID))
    await d.delete(serviceCatalog).where(eq(serviceCatalog.id, fx.serviceId))
    await d.delete(departments).where(eq(departments.id, fx.departmentId))
  })

  const num = (prefix: string) => `${prefix}/99-00/${String(++fx.seq).padStart(6, '0')}${RUN.slice(-4)}`

  async function insertLine(over: Partial<typeof chargeLines.$inferInsert> = {}) {
    const [r] = await (await db()).insert(chargeLines).values({
      patientId: PID, encounterId: fx.encounterId, source: 'manual', serviceId: fx.serviceId, itemCode: CODE, itemName: 'Consult',
      serviceCategory: 'consultation', serviceDate: '2099-06-01', quantity: 1, unitPricePaise: 50000, priceSource: 'base',
      taxablePaise: 50000, gstRateBp: 0, hsnSac: '999312', createdByName: 'TEST-SP4', ...over,
    }).returning()
    return r
  }

  async function draftInvoice() {
    const [inv] = await (await db()).insert(invoices).values({ patientId: PID, encounterId: fx.encounterId, createdByName: 'TEST-SP4' }).returning()
    return inv
  }

  /** A finalised invoice with one invoice line, built the way Task 10's finalise will. */
  async function finalisedInvoice(totalPaise = 50000) {
    const { eq } = await import('drizzle-orm')
    const d = await db()
    const inv = await draftInvoice()
    const line = await insertLine({ invoiceId: inv.id, taxablePaise: totalPaise })
    const [il] = await d.insert(invoiceLines).values({
      invoiceId: inv.id, chargeLineId: line.id, lineNo: 1, itemCode: CODE, itemName: 'Consult', hsnSac: '999312', serviceDate: '2099-06-01',
      quantity: 1, unitPricePaise: 50000, priceSource: 'base', taxablePaise: totalPaise, gstRateBp: 0, cgstRateBp: 0, sgstRateBp: 0, igstRateBp: 0,
      cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise,
    }).returning()
    const [fin] = await d.update(invoices).set({
      status: 'finalised', invoiceNumber: num('INV'), financialYear: '2099-00', invoiceDate: '2099-06-01', documentTitle: 'Bill of Supply',
      supplyType: 'intra', placeOfSupplyStateCode: 'IN-KA', snapshot: SNAPSHOT, taxablePaise: totalPaise, cgstPaise: 0, sgstPaise: 0, igstPaise: 0,
      totalPaise, finalisedAt: new Date(), finalisedByName: 'TEST-SP4',
    }).where(eq(invoices.id, inv.id)).returning()
    await d.update(chargeLines).set({ status: 'invoiced' }).where(eq(chargeLines.id, line.id))
    return { inv: fin, line, il }
  }

  async function payment(over: Partial<typeof patientPayments.$inferInsert> = {}) {
    const [p] = await (await db()).insert(patientPayments).values({
      receiptNumber: num('RCT'), kind: 'advance', patientId: PID, mode: 'cash', amountPaise: 100000, financialYear: '2099-00',
      receiptDate: '2099-06-01', receivedByName: 'TEST-SP4', ...over,
    }).returning()
    return p
  }

  it('the live columns, constraints and indexes match schema.ts', async () => {
    const { sql } = await import('drizzle-orm')
    const d = await db()
    for (const t of [...TABLES, chargeLines]) {
      const cfg = getTableConfig(t)
      const cols = await d.execute<{ column_name: string; data_type: string; udt_name: string; is_nullable: string }>(sql`
        SELECT column_name, data_type, udt_name, is_nullable FROM information_schema.columns WHERE table_name = ${cfg.name}`)
      const live = new Map(cols.rows.map((r) => [r.column_name, r]))
      expect([...live.keys()].sort(), cfg.name).toEqual(cfg.columns.map((c) => c.name).sort())
      for (const c of cfg.columns) {
        const l = live.get(c.name)!
        const expected = c.getSQLType().replace('serial', 'integer').replace(/^timestamp$/, 'timestamp without time zone')
        expect(l.data_type === 'USER-DEFINED' ? l.udt_name : l.data_type, `${cfg.name}.${c.name}`).toBe(expected)
        expect(l.is_nullable === 'NO', `${cfg.name}.${c.name} not null`).toBe(c.notNull || c.primary || cfg.primaryKeys.some((p) => p.columns.includes(c)))
      }
      const cons = await d.execute<{ conname: string }>(sql`
        SELECT conname FROM pg_constraint WHERE conrelid = ${cfg.name}::regclass AND contype IN ('f', 'c', 'u')`)
      expect(cons.rows.map((r) => r.conname).sort(), cfg.name).toEqual([
        ...cfg.foreignKeys.map((f) => f.getName()), ...cfg.checks.map((k) => k.name),
        ...cfg.columns.filter((col) => col.isUnique).map((col) => col.uniqueName!),
      ].sort())
      const idx = await d.execute<{ indexname: string }>(sql`
        SELECT i.relname AS indexname FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
        WHERE x.indrelid = ${cfg.name}::regclass AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid)`)
      expect(idx.rows.map((r) => r.indexname).sort(), cfg.name).toEqual(cfg.indexes.map((i) => i.config.name!).sort())
    }
    const pk = await d.execute<{ conname: string }>(sql`SELECT conname FROM pg_constraint WHERE conrelid = 'document_counters'::regclass AND contype = 'p'`)
    expect(pk.rows.map((r) => r.conname)).toEqual(['document_counters_pk'])
    const trg = await d.execute<{ tgname: string; tbl: string; fn: string; enabled: string }>(sql`
      SELECT tgname, tgrelid::regclass::text AS tbl, tgfoid::regproc::text AS fn, tgenabled AS enabled FROM pg_trigger
      WHERE NOT tgisinternal AND tgfoid IN ('sp4_invoice_guard'::regproc, 'sp4_reject_issued_change'::regproc)`)
    expect(trg.rows.map((r) => `${r.tbl}.${r.tgname}:${r.fn}:${r.enabled}`).sort()).toEqual([
      'credit_notes.credit_notes_immutable:sp4_reject_issued_change:O',
      'invoice_lines.invoice_lines_immutable:sp4_reject_issued_change:O',
      'invoices.invoices_issued_guard:sp4_invoice_guard:O',
      'patient_payments.patient_payments_immutable:sp4_reject_issued_change:O',
      'refunds.refunds_immutable:sp4_reject_issued_change:O',
    ])
  })

  it('stores and reads back 2^31 paise on payments and invoice totals', async () => {
    const { eq } = await import('drizzle-orm')
    const d = await db()
    const p = await payment({ amountPaise: 2_147_483_648 })
    const [pBack] = await d.select({ a: patientPayments.amountPaise }).from(patientPayments).where(eq(patientPayments.id, p.id))
    expect(pBack.a).toBe(2_147_483_648)
    const { inv, il } = await finalisedInvoice(3_540_000_000)
    const [iBack] = await d.select({ t: invoices.totalPaise, x: invoices.taxablePaise }).from(invoices).where(eq(invoices.id, inv.id))
    expect(iBack).toEqual({ t: 3_540_000_000, x: 3_540_000_000 })
    const [lBack] = await d.select({ t: invoiceLines.totalPaise }).from(invoiceLines).where(eq(invoiceLines.id, il.id))
    expect(lBack.t).toBe(3_540_000_000)
    const [r] = await d.insert(refunds).values({
      refundNumber: num('RFD'), patientId: PID, againstPaymentId: p.id, mode: 'neft', reference: 'UTR123456789012', amountPaise: 2_147_483_649,
      reason: 'Test', financialYear: '2099-00', refundDate: '2099-06-01', issuedByName: 'TEST-SP4',
    }).returning()
    expect(r.amountPaise).toBe(2_147_483_649)
    const [cn] = await d.insert(creditNotes).values({
      creditNoteNumber: num('CRN'), invoiceId: inv.id, financialYear: '2099-00', issueDate: '2099-06-01', reason: 'Test',
      taxablePaise: 3_540_000_000, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 3_540_000_000, issuedByName: 'TEST-SP4',
    }).returning()
    expect(cn.totalPaise).toBe(3_540_000_000)
  })

  it('refuses to update or delete an invoice line', async () => {
    const { eq } = await import('drizzle-orm')
    const d = await db()
    const { il } = await finalisedInvoice()
    expect(await code(d.update(invoiceLines).set({ totalPaise: 1 }).where(eq(invoiceLines.id, il.id)))).toBe('55000')
    expect(await code(d.delete(invoiceLines).where(eq(invoiceLines.id, il.id)))).toBe('55000')
    const [still] = await d.select().from(invoiceLines).where(eq(invoiceLines.id, il.id))
    expect(still.totalPaise).toBe(50000)
  })

  it('allows finalised → cancelled only, and nothing on a cancelled invoice', async () => {
    const { eq } = await import('drizzle-orm')
    const d = await db()
    const { inv } = await finalisedInvoice()
    const where = eq(invoices.id, inv.id)
    expect(await code(d.update(invoices).set({ totalPaise: 1 }).where(where))).toBe('55000')
    expect(await code(d.update(invoices).set({ status: 'draft', invoiceNumber: null }).where(where))).toBe('55000')
    expect(await code(d.update(invoices).set({ status: 'discarded', invoiceNumber: null }).where(where))).toBe('55000')
    // Cancelling while also touching any other column is refused.
    expect(await code(d.update(invoices).set({ status: 'cancelled', cancelledAt: new Date(), totalPaise: 1 }).where(where))).toBe('55000')
    expect(await code(d.update(invoices).set({ status: 'cancelled', snapshot: { ...SNAPSHOT, payer: null, context: { ...SNAPSHOT.context, label: 'X' } } }).where(where))).toBe('55000')
    expect(await code(d.delete(invoices).where(where))).toBe('55000')
    const [cancelled] = await d.update(invoices).set({ status: 'cancelled', cancelledAt: new Date(), cancelledByName: 'TEST-SP4' }).where(where).returning()
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.invoiceNumber).toBe(inv.invoiceNumber)
    expect(cancelled.totalPaise).toBe(inv.totalPaise)
    expect(await code(d.update(invoices).set({ cancelledByName: 'Someone else' }).where(where))).toBe('55000')
    expect(await code(d.update(invoices).set({ status: 'finalised' }).where(where))).toBe('55000')
    expect(await code(d.delete(invoices).where(where))).toBe('55000')
  })

  it('a no-op UPDATE of a finalised invoice is still refused (no silent rewrites)', async () => {
    const { eq } = await import('drizzle-orm')
    const d = await db()
    const { inv } = await finalisedInvoice()
    expect(await code(d.update(invoices).set({ finalisedByName: inv.finalisedByName }).where(eq(invoices.id, inv.id)))).toBe('55000')
  })

  it('drafts stay mutable: update, discard and delete are allowed', async () => {
    const { eq } = await import('drizzle-orm')
    const d = await db()
    const inv = await draftInvoice()
    await d.update(invoices).set({ payerId: null, encounterId: fx.encounterId }).where(eq(invoices.id, inv.id))
    const [disc] = await d.update(invoices).set({ status: 'discarded', discardedAt: new Date(), discardedByName: 'TEST-SP4' }).where(eq(invoices.id, inv.id)).returning()
    expect(disc.status).toBe('discarded')
    await d.update(invoices).set({ discardedByName: 'TEST-SP4 again' }).where(eq(invoices.id, inv.id))
    await d.delete(invoices).where(eq(invoices.id, inv.id))
    expect(await d.select().from(invoices).where(eq(invoices.id, inv.id))).toEqual([])
  })

  it('refuses to update or delete credit notes, payments and refunds', async () => {
    const { eq } = await import('drizzle-orm')
    const d = await db()
    const { inv } = await finalisedInvoice()
    const [cn] = await d.insert(creditNotes).values({
      creditNoteNumber: num('CRN'), invoiceId: inv.id, financialYear: '2099-00', issueDate: '2099-06-01', reason: 'Test',
      taxablePaise: 50000, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 50000, issuedByName: 'TEST-SP4',
    }).returning()
    const p = await payment({ kind: 'receipt', invoiceId: inv.id, mode: 'upi', reference: 'UTR412345678901' })
    const [r] = await d.insert(refunds).values({
      refundNumber: num('RFD'), patientId: PID, againstPaymentId: p.id, mode: 'cash', amountPaise: 100,
      reason: 'Test', financialYear: '2099-00', refundDate: '2099-06-01', issuedByName: 'TEST-SP4',
    }).returning()
    expect(await code(d.update(creditNotes).set({ reason: 'changed' }).where(eq(creditNotes.id, cn.id)))).toBe('55000')
    expect(await code(d.delete(creditNotes).where(eq(creditNotes.id, cn.id)))).toBe('55000')
    expect(await code(d.update(patientPayments).set({ amountPaise: 1 }).where(eq(patientPayments.id, p.id)))).toBe('55000')
    expect(await code(d.delete(patientPayments).where(eq(patientPayments.id, p.id)))).toBe('55000')
    expect(await code(d.update(refunds).set({ amountPaise: 1 }).where(eq(refunds.id, r.id)))).toBe('55000')
    expect(await code(d.delete(refunds).where(eq(refunds.id, r.id)))).toBe('55000')
  })

  it('rejects an accidental UPDATE even on the app connection\'s own (possibly superuser) role', async () => {
    const { sql } = await import('drizzle-orm')
    const d = await db()
    const { inv } = await finalisedInvoice()
    const p = await payment()
    // Triggers are not privilege checks: they fire for table owners and superusers alike.
    const who = await d.execute<{ rolsuper: boolean }>(sql`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)
    expect(who.rows).toHaveLength(1)
    expect(await code(d.execute(sql`UPDATE invoices SET total_paise = 0 WHERE id = ${inv.id}`))).toBe('55000')
    expect(await code(d.execute(sql`UPDATE patient_payments SET amount_paise = 1 WHERE id = ${p.id}`))).toBe('55000')
    expect(await code(d.execute(sql`DELETE FROM patient_payments WHERE id = ${p.id}`))).toBe('55000')
  })

  it('the purge setting is transaction-local: it lets a purge through, then the guard is back', async () => {
    const { eq, sql } = await import('drizzle-orm')
    const d = await db()
    const p1 = await payment()
    const p2 = await payment()
    await d.transaction(async (tx) => {
      await tx.execute(sql`select set_config('hims.allow_document_purge', 'on', true)`)
      await tx.delete(patientPayments).where(eq(patientPayments.id, p1.id))
    })
    expect(await d.select().from(patientPayments).where(eq(patientPayments.id, p1.id))).toEqual([])
    expect(await code(d.delete(patientPayments).where(eq(patientPayments.id, p2.id)))).toBe('55000')
    // A setting of anything other than 'on' does not purge.
    const err = await errorOf(d.transaction(async (tx) => {
      await tx.execute(sql`select set_config('hims.allow_document_purge', 'yes', true)`)
      await tx.delete(patientPayments).where(eq(patientPayments.id, p2.id))
    }))
    expect((await import('@/lib/db-errors')).pgErrorCode(err)).toBe('55000')
  })

  it('enforces the invoice, payment, refund and counter checks', async () => {
    const { eq } = await import('drizzle-orm')
    const d = await db()
    // A draft cannot carry a number; an issued invoice must have one, plus totals, snapshot and date.
    expect(await constraint(d.insert(invoices).values({ patientId: PID, invoiceNumber: num('INV'), createdByName: 'TEST-SP4' }))).toBe('invoices_number_when_issued')
    const inv = await draftInvoice()
    expect(await constraint(d.update(invoices).set({ status: 'finalised' }).where(eq(invoices.id, inv.id)))).toBe('invoices_number_when_issued')
    expect(await constraint(d.update(invoices).set({ status: 'finalised', invoiceNumber: num('INV') }).where(eq(invoices.id, inv.id)))).toBe('invoices_totals_when_issued')
    expect(await constraint(payment({ amountPaise: 0 }))).toBe('patient_payments_amount_positive')
    expect(await constraint(payment({ mode: 'upi' }))).toBe('patient_payments_reference_required')
    const base = { refundNumber: num('RFD'), patientId: PID, mode: 'cash' as const, amountPaise: 1, reason: 'x', financialYear: '2099-00', refundDate: '2099-06-01', issuedByName: 'TEST-SP4' }
    expect(await constraint(d.insert(refunds).values({ ...base, amountPaise: 0 }))).toBe('refunds_amount_positive')
    expect(await constraint(d.insert(refunds).values({ ...base, mode: 'card' }))).toBe('refunds_reference_required')
    expect(await constraint(d.insert(documentCounters).values({ series: 'invoice', financialYear: '2099-2100' }))).toBe('document_counters_fy_format')
    expect(await constraint(d.insert(documentCounters).values({ series: 'invoice', financialYear: '2099-00', lastValue: 1_000_000 }))).toBe('document_counters_value_range')
    await d.insert(documentCounters).values({ series: 'invoice', financialYear: '2099-00' })
    expect(await constraint(d.insert(documentCounters).values({ series: 'invoice', financialYear: '2099-00' }))).toBe('document_counters_pk')
  })

  it('purgeBillingFixtures removes issued fixtures', async () => {
    const { purgeBillingFixtures } = await import('./billing-fixtures')
    const { eq } = await import('drizzle-orm')
    const d = await db()
    const { inv, line } = await finalisedInvoice()
    await d.insert(creditNotes).values({
      creditNoteNumber: num('CRN'), invoiceId: inv.id, financialYear: '2099-00', issueDate: '2099-06-01', reason: 'Test',
      taxablePaise: 50000, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 50000, issuedByName: 'TEST-SP4',
    })
    const p = await payment({ kind: 'receipt', invoiceId: inv.id })
    await d.insert(refunds).values({
      refundNumber: num('RFD'), patientId: PID, againstPaymentId: p.id, mode: 'cash', amountPaise: 100,
      reason: 'Test', financialYear: '2099-00', refundDate: '2099-06-01', issuedByName: 'TEST-SP4',
    })
    await d.insert(documentCounters).values({ series: 'receipt', financialYear: '2099-00', lastValue: 3 })
    await purgeBillingFixtures([PID])
    expect(await d.select().from(invoices).where(eq(invoices.patientId, PID))).toEqual([])
    expect(await d.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id))).toEqual([])
    expect(await d.select().from(creditNotes).where(eq(creditNotes.invoiceId, inv.id))).toEqual([])
    expect(await d.select().from(patientPayments).where(eq(patientPayments.patientId, PID))).toEqual([])
    expect(await d.select().from(refunds).where(eq(refunds.patientId, PID))).toEqual([])
    expect(await d.select().from(chargeLines).where(eq(chargeLines.id, line.id))).toEqual([])
    expect(await d.select().from(documentCounters).where(eq(documentCounters.financialYear, '2099-00'))).toEqual([])
  })

  describe('deletePatient', () => {
    async function makePatient(suffix: string) {
      const { patients, encounters } = await import('@/db/schema')
      const d = await db()
      const pid = `${PID}-${suffix}`
      await d.insert(patients).values({ id: pid, name: 'Test SP4 Delete', dob: '1990-01-01' })
      const [enc] = await d.insert(encounters).values({ patientId: pid, encounterType: 'opd', encounterDate: '2099-06-01', providerId: fx.providerId, checkedInByName: 'TEST-SP4' }).returning()
      return { pid, encounterId: enc.id }
    }
    async function cleanup(pid: string) {
      const { patients, encounters } = await import('@/db/schema')
      const { purgeBillingFixtures } = await import('./billing-fixtures')
      const { eq } = await import('drizzle-orm')
      const d = await db()
      await purgeBillingFixtures([pid])
      await d.delete(encounters).where(eq(encounters.patientId, pid))
      await d.delete(patients).where(eq(patients.id, pid))
    }

    it('deletes a patient whose bills are only drafts and captured lines', { timeout: 30000 }, async () => {
      const { patients } = await import('@/db/schema')
      const { deletePatient } = await import('@/lib/queries/patients')
      const { eq } = await import('drizzle-orm')
      const d = await db()
      const { pid, encounterId } = await makePatient('DRAFT')
      try {
        const [inv] = await d.insert(invoices).values({ patientId: pid, encounterId, createdByName: 'TEST-SP4' }).returning()
        await insertLine({ patientId: pid, encounterId, invoiceId: inv.id })
        await insertLine({ patientId: pid, encounterId })
        await d.insert(invoices).values({ patientId: pid, status: 'discarded', createdByName: 'TEST-SP4' })
        expect(await deletePatient(pid)).toBe(true)
        expect(await d.select().from(patients).where(eq(patients.id, pid))).toEqual([])
        expect(await d.select().from(invoices).where(eq(invoices.patientId, pid))).toEqual([])
        expect(await d.select().from(chargeLines).where(eq(chargeLines.patientId, pid))).toEqual([])
      } finally {
        await cleanup(pid)
      }
    })

    it('refuses, before deleting anything, a patient with a receipt', { timeout: 30000 }, async () => {
      const { patients, encounters } = await import('@/db/schema')
      const { deletePatient } = await import('@/lib/queries/patients')
      const { eq } = await import('drizzle-orm')
      const d = await db()
      const { pid, encounterId } = await makePatient('RCPT')
      try {
        await insertLine({ patientId: pid, encounterId })
        await payment({ patientId: pid })
        // Task 12: the friendly pre-check refuses first (the trigger stays the backstop).
        const { PatientHasFinancialRecordsError } = await import('@/lib/queries/patients')
        expect(await errorOf(deletePatient(pid))).toBeInstanceOf(PatientHasFinancialRecordsError)
        expect(await d.select().from(patients).where(eq(patients.id, pid))).toHaveLength(1)
        expect(await d.select().from(encounters).where(eq(encounters.patientId, pid))).toHaveLength(1)
        expect(await d.select().from(chargeLines).where(eq(chargeLines.patientId, pid))).toHaveLength(1)
      } finally {
        await cleanup(pid)
      }
    })

    it('refuses, before deleting anything, a patient with a finalised invoice', { timeout: 30000 }, async () => {
      const { patients, encounters } = await import('@/db/schema')
      const { deletePatient } = await import('@/lib/queries/patients')
      const { eq } = await import('drizzle-orm')
      const d = await db()
      const { pid, encounterId } = await makePatient('INV')
      try {
        const [inv] = await d.insert(invoices).values({ patientId: pid, encounterId, createdByName: 'TEST-SP4' }).returning()
        const line = await insertLine({ patientId: pid, encounterId, invoiceId: inv.id })
        await d.insert(invoiceLines).values({
          invoiceId: inv.id, chargeLineId: line.id, lineNo: 1, itemCode: CODE, itemName: 'Consult', hsnSac: '999312', serviceDate: '2099-06-01',
          quantity: 1, unitPricePaise: 50000, priceSource: 'base', taxablePaise: 50000, gstRateBp: 0, cgstRateBp: 0, sgstRateBp: 0, igstRateBp: 0,
          cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 50000,
        })
        await d.update(invoices).set({ status: 'finalised', invoiceNumber: num('INV'), financialYear: '2099-00', invoiceDate: '2099-06-01', snapshot: SNAPSHOT, totalPaise: 50000 })
          .where(eq(invoices.id, inv.id))
        const { PatientHasFinancialRecordsError } = await import('@/lib/queries/patients')
        expect(await errorOf(deletePatient(pid))).toBeInstanceOf(PatientHasFinancialRecordsError)
        expect(await d.select().from(patients).where(eq(patients.id, pid))).toHaveLength(1)
        expect(await d.select().from(encounters).where(eq(encounters.patientId, pid))).toHaveLength(1)
        expect(await d.select().from(invoices).where(eq(invoices.patientId, pid))).toHaveLength(1)
      } finally {
        await cleanup(pid)
      }
    })
  })
})
