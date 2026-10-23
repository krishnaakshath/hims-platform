import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import type { Session } from '@/lib/auth'

// WS2 T11: procedure orders from the workspace, billed at order time through the auto-charge seam
// (one `procedure` line per order, linked by encounter_procedure_id). Cancel soft-voids the
// procedure (SP6) and handles its line as a lab order cancel does; a visit cancel takes the visit's
// procedures with it. Real DB. Query-level checks pin `now` to 2099 (finalised invoices number in
// the test-only 2099-00 year); the route checks use today.
let role = 'admin'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role, name: 'TEST-WS2T11 route', userId: null })) }
})
let routeProviderId = 0
vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => (routeProviderId ? { id: routeProviderId, name: 'Dr' } : null)) }))

const NOW = new Date('2099-07-01T06:00:00Z') // 11:30 IST
const LATER = new Date('2099-07-01T09:00:00Z')
const DAY = '2099-07-01'

describe.skipIf(!process.env.DATABASE_URL)('procedure orders billed at order time (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const CODE = `TW11${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const doctor: Session = { role: 'admin', name: `TEST-WS2T11-${RUN}-dr`, userId: null }
  const billing: Session = { role: 'billing', name: `TEST-WS2T11-${RUN}-billing`, userId: null }
  const fx = { dep: 0, prov: 0, prov2: 0, procA: 0, procB: 0, procOff: 0, lab: 0, codeSystemId: 0, codeId: 0, rateIds: [] as number[] }
  const PIDS: string[] = []
  let savedSettings: Record<string, unknown> | null = null
  let savedDepositRule: Record<string, unknown>[] = []
  let seq = 0

  const m = async () => ({
    ...(await import('@/db/client')), ...(await import('@/db/schema')), ...(await import('drizzle-orm')),
    po: await import('@/lib/queries/procedure-orders'),
    enc: await import('@/lib/queries/encounters'),
    inv: await import('@/lib/queries/invoices'),
    india: await import('@/lib/india-time'),
  })

  async function newPatient(over: Record<string, unknown> = {}): Promise<string> {
    const { getDb, patients } = await m()
    const id = `TEST-WS2T11-${RUN}-${++seq}`
    PIDS.push(id)
    await getDb().insert(patients).values({ id, name: `Test WS2T11 ${seq}`, dob: '1990-01-01', uhid: `${CODE}${seq}`, stateCode: 'IN-KA', phone: '9999999999', ...over } as never)
    return id
  }

  async function opdEncounter(patientId: string, over: Record<string, unknown> = {}) {
    const { getDb, encounters } = await m()
    const [e] = await getDb().insert(encounters).values({
      patientId, encounterType: 'opd', encounterDate: DAY, providerId: fx.prov, departmentId: fx.dep, checkedInByName: doctor.name, ...over,
    } as never).returning()
    return e
  }

  async function orderAt(e: Awaited<ReturnType<typeof opdEncounter>>, over: Record<string, unknown> = {}, now = NOW) {
    const { po } = await m()
    const r = await po.orderProcedure(e, { serviceId: fx.procA, quantity: 1, ...over } as never, doctor, now)
    if (!r.ok) throw new Error(`order failed: ${r.error}`)
    return r
  }

  async function linesOf(patientId: string) {
    const { getDb, chargeLines, eq, asc } = await m()
    return getDb().select().from(chargeLines).where(eq(chargeLines.patientId, patientId)).orderBy(asc(chargeLines.id))
  }

  async function proceduresOf(encounterId: number) {
    const { getDb, encounterProcedures, eq, asc } = await m()
    return getDb().select().from(encounterProcedures).where(eq(encounterProcedures.encounterId, encounterId)).orderBy(asc(encounterProcedures.id))
  }

  async function finalise(lineIds: number[]) {
    const { inv } = await m()
    const d = await inv.createDraftInvoice(lineIds, billing)
    if (!d.ok) throw new Error(d.error)
    const f = await inv.finaliseInvoice(d.invoiceId, billing, NOW)
    if (!f.ok) throw new Error(f.error)
    return { invoiceId: d.invoiceId, invoiceNumber: f.invoiceNumber }
  }

  async function markCoded(procedureId: number) {
    const { getDb, encounterProcedures, eq } = await m()
    await getDb().update(encounterProcedures).set({ codingStatus: 'coded', codeId: fx.codeId, codeSystemKind: 'icd10pcs', code: `${CODE}X`, codeDisplay: 'Test' })
      .where(eq(encounterProcedures.id, procedureId))
  }

  beforeAll(async () => {
    const { getDb, departments, providers, serviceCatalog, billingSettings, tariffRates, chargeRuleConfigs, codeSystems, codes, eq } = await m()
    const db = getDb()
    const [s] = await db.select().from(billingSettings).where(eq(billingSettings.id, 1))
    savedSettings = s ?? null
    savedDepositRule = await db.select().from(chargeRuleConfigs).where(eq(chargeRuleConfigs.ruleCode, 'deposit_below_threshold'))
    await db.delete(chargeRuleConfigs).where(eq(chargeRuleConfigs.ruleCode, 'deposit_below_threshold'))
    const [dep] = await db.insert(departments).values({ code: `${CODE}D`, name: `Test WS2T11 Dept ${RUN}` }).returning()
    fx.dep = dep.id
    const prov = async (name: string) => (await db.insert(providers).values({ name, specialty: 'Test', colorTag: '#000000', departmentId: dep.id }).returning())[0].id
    fx.prov = await prov(`TEST-WS2T11 Dr A ${RUN}`)
    fx.prov2 = await prov(`TEST-WS2T11 Dr B ${RUN}`)
    const svc = async (suffix: string, category: 'procedure' | 'investigation_lab', isActive = true) =>
      (await db.insert(serviceCatalog).values({ code: `${CODE}${suffix}`, name: `Test WS2T11 ${suffix}`, departmentId: dep.id, category, hsnSac: '999312', gstRateBp: 0, isActive }).returning())[0].id
    fx.procA = await svc('PA', 'procedure')
    fx.procB = await svc('PB', 'procedure')
    fx.procOff = await svc('PX', 'procedure', false)
    fx.lab = await svc('LB', 'investigation_lab')
    const rates = await db.insert(tariffRates).values([
      { serviceId: fx.procA, scope: 'base', amountPaise: 150000, validFrom: '2020-01-01', createdByName: 'TEST-WS2T11' },
      { serviceId: fx.procA, scope: 'department', departmentId: dep.id, amountPaise: 120000, validFrom: '2020-01-01', createdByName: 'TEST-WS2T11' },
      { serviceId: fx.procOff, scope: 'base', amountPaise: 99000, validFrom: '2020-01-01', createdByName: 'TEST-WS2T11' },
      { serviceId: fx.lab, scope: 'base', amountPaise: 30000, validFrom: '2020-01-01', createdByName: 'TEST-WS2T11' },
    ]).returning()
    fx.rateIds.push(...rates.map((r) => r.id))
    const [cs] = await db.insert(codeSystems).values({
      kind: 'icd10pcs', version: `TEST-WS2T11-${RUN}`, name: 'Test', isSample: true, sourceFileName: 'test', sourceSha256: 'x', codeCount: 1, importedByName: 'TEST-WS2T11',
    }).returning()
    fx.codeSystemId = cs.id
    const [code] = await db.insert(codes).values({ codeSystemId: cs.id, code: `${CODE}X`, display: 'Test' }).returning()
    fx.codeId = code.id
    await db.update(billingSettings).set({
      legalName: 'Test WS2T11 Hospital', stateCode: 'IN-KA', gstin: null, placeOfSupplyMode: 'location_of_service', ipdDepositThresholdPaise: 500000, consultationWindowDays: 30,
    }).where(eq(billingSettings.id, 1))
  })

  async function purge() {
    const { getDb, encounterProcedures, encounters, admissions, inArray } = await m()
    const { purgeBillingFixtures } = await import('../db/billing-fixtures')
    await purgeBillingFixtures([...PIDS])
    if (PIDS.length === 0) return
    const db = getDb()
    await db.delete(encounterProcedures).where(inArray(encounterProcedures.patientId, PIDS))
    await db.delete(encounters).where(inArray(encounters.patientId, PIDS))
    await db.delete(admissions).where(inArray(admissions.patientId, PIDS))
  }

  afterEach(async () => {
    role = 'admin'
    routeProviderId = 0
    await purge()
  })

  afterAll(async () => {
    const { getDb, departments, providers, serviceCatalog, tariffRates, patients, billingSettings, chargeRuleConfigs, auditLog, codes, codeSystems, eq, inArray, or } = await m()
    const db = getDb()
    await purge()
    if (savedSettings) await db.update(billingSettings).set(savedSettings).where(eq(billingSettings.id, 1))
    if (savedDepositRule.length) await db.insert(chargeRuleConfigs).values(savedDepositRule as never).onConflictDoNothing()
    if (PIDS.length) {
      await db.delete(auditLog).where(or(inArray(auditLog.patientId, PIDS), inArray(auditLog.userName, [doctor.name, billing.name, 'TEST-WS2T11 route'])))
      await db.delete(patients).where(inArray(patients.id, PIDS))
    }
    await db.delete(codes).where(eq(codes.id, fx.codeId))
    await db.delete(codeSystems).where(eq(codeSystems.id, fx.codeSystemId))
    await db.delete(tariffRates).where(inArray(tariffRates.id, fx.rateIds))
    await db.delete(serviceCatalog).where(inArray(serviceCatalog.id, [fx.procA, fx.procB, fx.procOff, fx.lab]))
    await db.delete(providers).where(inArray(providers.id, [fx.prov, fx.prov2]))
    await db.delete(departments).where(eq(departments.id, fx.dep))
  })

  // ---------- routes ----------
  const today = async () => (await m()).india.todayIsoIn('Asia/Kolkata')
  const ctx = (p: Record<string, string>) => ({ params: Promise.resolve(p) })
  const postOrder = async (encounterId: number | string, body: unknown) => {
    const { POST } = await import('@/app/api/encounters/[id]/procedures/route')
    return POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }) as never, ctx({ id: String(encounterId) }) as never)
  }
  const del = async (encounterId: number, procedureId: number) => {
    const { DELETE } = await import('@/app/api/encounters/[id]/procedures/[procedureId]/route')
    return DELETE(new Request('http://localhost', { method: 'DELETE' }) as never, ctx({ id: String(encounterId), procedureId: String(procedureId) }) as never)
  }
  const options = async (encounterId: number, q: string) => {
    const { GET } = await import('@/app/api/encounters/[id]/procedure-options/route')
    return GET(new Request(`http://localhost/api/encounters/${encounterId}/procedure-options?q=${encodeURIComponent(q)}`) as never, ctx({ id: String(encounterId) }) as never)
  }
  const list = async (encounterId: number) => {
    const { GET } = await import('@/app/api/encounters/[id]/procedures/route')
    return GET(new Request(`http://localhost/api/encounters/${encounterId}/procedures`) as never, ctx({ id: String(encounterId) }) as never)
  }

  describe('order', () => {
    it('the visit doctor orders a procedure service: the procedure row and a procedure line linked by encounter_procedure_id (201)', async () => {
      const pid = await newPatient()
      const day = await today()
      const e = await opdEncounter(pid, { encounterDate: day })
      role = 'pi'
      routeProviderId = fx.prov
      const res = await postOrder(e.id, { serviceId: fx.procA, quantity: 2, notes: '  Left knee  ' })
      expect(res.status).toBe(201)
      const body = await res.json()
      const [p] = await proceduresOf(e.id)
      const [line] = await linesOf(pid)
      expect(p).toMatchObject({
        patientId: pid, description: 'Test WS2T11 PA', serviceId: fx.procA, performedOn: day, performedByProviderId: fx.prov,
        codingStatus: 'uncoded', codeId: null, createdByName: 'TEST-WS2T11 route', orderNotes: 'Left knee', voidedAt: null,
      })
      expect([line.source, line.encounterProcedureId, line.encounterId, line.admissionId, line.payerId, line.serviceId, line.quantity, line.unitPricePaise, line.taxablePaise, line.serviceDate, line.status, line.priceSource])
        .toEqual(['procedure', p.id, e.id, null, null, fx.procA, 2, 120000, 240000, day, 'captured', 'department'])
      expect(body).toEqual({
        procedureId: p.id,
        charge: { ok: true, source: 'procedure', lineId: line.id, itemName: 'Test WS2T11 PA', taxablePaise: 240000, billTo: 'self', existing: false },
      })
      const { getDb, auditLog, eq } = await m()
      const audits = (await getDb().select().from(auditLog).where(eq(auditLog.patientId, pid))).map((a) => `${a.action}|${a.details}`)
      expect(audits).toContain(`ordered procedure|encounter=${e.id} procedure=${p.id} service=${CODE}PA qty=2`)
      expect(audits).toContain(`billing: auto-captured procedure|line=${line.id} service=${CODE}PA`)
      expect(audits.join('\n')).not.toContain('Left knee')
    })

    it('a service that is not an active procedure is refused (422) and nothing is written', async () => {
      const pid = await newPatient()
      const e = await opdEncounter(pid, { encounterDate: await today() })
      for (const serviceId of [fx.lab, fx.procOff, 2147483000]) {
        const res = await postOrder(e.id, { serviceId })
        expect(res.status).toBe(422)
        expect(await res.json()).toEqual({ error: 'Choose an active procedure.', code: 'service_not_procedure' })
      }
      expect(await proceduresOf(e.id)).toEqual([])
      expect(await linesOf(pid)).toEqual([])
    })

    it('rejects a bad body (400): unknown field, quantity out of range, notes over 300', async () => {
      const pid = await newPatient()
      const e = await opdEncounter(pid, { encounterDate: await today() })
      for (const body of [{ serviceId: fx.procA, extra: 1 }, { serviceId: fx.procA, quantity: 11 }, { serviceId: fx.procA, quantity: 0 }, { serviceId: fx.procA, notes: 'x'.repeat(301) }, { serviceId: 0 }]) {
        expect((await postOrder(e.id, body)).status).toBe(400)
      }
      expect((await postOrder('abc', { serviceId: fx.procA })).status).toBe(400)
    })

    it('an IPD stay below the deposit threshold keeps the procedure: 201 with a blocked charge (deposit_below_threshold), no line', async () => {
      const pid = await newPatient()
      const { getDb, admissions } = await m()
      const day = await today()
      const [adm] = await getDb().insert(admissions).values({ patientId: pid, attendingProviderId: fx.prov }).returning()
      const e = await opdEncounter(pid, { encounterType: 'ipd', admissionId: adm.id, encounterDate: day })
      const res = await postOrder(e.id, { serviceId: fx.procA })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.charge).toEqual({ ok: false, source: 'procedure', reason: 'blocked', rules: ['deposit_below_threshold'] })
      const procs = await proceduresOf(e.id)
      expect(procs.map((p) => [p.id, p.voidedAt])).toEqual([[body.procedureId, null]])
      expect(await linesOf(pid)).toEqual([])
    })

    it('a closed visit is refused: the route (409 visit_closed) and the in-transaction re-check on a stale row', async () => {
      const pid = await newPatient()
      const e = await opdEncounter(pid, { encounterDate: await today(), status: 'completed' })
      const res = await postOrder(e.id, { serviceId: fx.procA })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'Visit is closed', code: 'visit_closed' })
      // The row the route read may be stale: the query re-checks the status under its own lock.
      const open = await opdEncounter(pid)
      const { getDb, encounters, eq, po } = await m()
      await getDb().update(encounters).set({ status: 'cancelled' }).where(eq(encounters.id, open.id))
      expect(await po.orderProcedure(open, { serviceId: fx.procA, quantity: 1 }, doctor, NOW)).toEqual({ ok: false, error: 'visit_closed' })
      expect(await proceduresOf(open.id)).toEqual([])
    })

    it('another doctor cannot order, cancel, or list options on the visit (403 not_owner); a pi with no profile is 403', async () => {
      const pid = await newPatient()
      const e = await opdEncounter(pid, { encounterDate: await today() })
      const r = await orderAt(e)
      role = 'pi'
      routeProviderId = fx.prov2
      for (const res of [await postOrder(e.id, { serviceId: fx.procA }), await del(e.id, r.procedureId), await options(e.id, CODE)]) {
        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ error: 'Forbidden', code: 'not_owner' })
      }
      routeProviderId = 0
      expect((await postOrder(e.id, { serviceId: fx.procA })).status).toBe(403)
      for (const r2 of ['billing', 'labs', 'frontdesk', 'crc', 'pharmacy']) {
        role = r2
        expect((await postOrder(e.id, { serviceId: fx.procA })).status).toBe(403)
        expect((await del(e.id, r.procedureId)).status).toBe(403)
        expect((await options(e.id, CODE)).status).toBe(403)
      }
      expect((await proceduresOf(e.id)).map((p) => p.voidedAt)).toEqual([null])
    })

    it('the options route lists only active procedure services, priced for the visit (department rate; null when unpriced)', async () => {
      const pid = await newPatient()
      const e = await opdEncounter(pid, { encounterDate: await today() })
      role = 'pi'
      routeProviderId = fx.prov
      const res = await options(e.id, CODE)
      expect(res.status).toBe(200)
      const depName = `Test WS2T11 Dept ${RUN}`
      expect(await res.json()).toEqual({
        options: [
          { serviceId: fx.procA, code: `${CODE}PA`, name: 'Test WS2T11 PA', departmentName: depName, pricePaise: 120000 },
          { serviceId: fx.procB, code: `${CODE}PB`, name: 'Test WS2T11 PB', departmentName: depName, pricePaise: null },
        ],
      })
      const byName = await (await options(e.id, 'WS2T11 pb')).json()
      expect(byName.options.map((o: { serviceId: number }) => o.serviceId)).toContain(fx.procB)
      expect(byName.options.map((o: { serviceId: number }) => o.serviceId)).not.toContain(fx.procA)
      // A LIKE wildcard in the query is literal.
      expect((await (await options(e.id, `${CODE}%`)).json()).options).toEqual([])
      expect((await options(e.id, 'x'.repeat(101))).status).toBe(400)
    })

    it('the list route returns the visit procedures with their billing state', async () => {
      const pid = await newPatient()
      const e = await opdEncounter(pid, { encounterDate: await today() })
      const a = await orderAt(e, {}, new Date())
      const { po } = await m()
      const b = await orderAt(e, { serviceId: fx.procA }, new Date())
      await po.cancelProcedure(e, b.procedureId, doctor)
      role = 'crc'
      const res = await list(e.id)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.procedures.map((p: Record<string, unknown>) => [p.id, p.name, p.status, p.billing, p.taxablePaise, p.quantity])).toEqual([
        [a.procedureId, 'Test WS2T11 PA', 'active', 'billed', 120000, 1],
        [b.procedureId, 'Test WS2T11 PA', 'cancelled', 'void', 120000, 1],
      ])
      role = 'billing'
      expect((await list(e.id)).status).toBe(403)
    })
  })

  describe('cancel', () => {
    it('cancelling a captured procedure voids both (billing: voided); a draft invoice loses the line (route 200)', async () => {
      const pid = await newPatient()
      const e = await opdEncounter(pid, { encounterDate: await today() })
      const r = await orderAt(e, {}, new Date())
      const { inv } = await m()
      const [line] = await linesOf(pid)
      const d = await inv.createDraftInvoice([line.id], billing)
      expect(d.ok).toBe(true)
      role = 'pi'
      routeProviderId = fx.prov
      const res = await del(e.id, r.procedureId)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, billing: 'voided' })
      const [p] = await proceduresOf(e.id)
      expect(p.voidedAt).not.toBeNull()
      expect(p.voidedByName).toBe('TEST-WS2T11 route')
      const [after] = await linesOf(pid)
      expect([after.status, after.voidReason, after.invoiceId]).toEqual(['void', 'Procedure cancelled', null])
      const { getDb, auditLog, eq } = await m()
      const audits = (await getDb().select().from(auditLog).where(eq(auditLog.patientId, pid))).map((a) => `${a.action}|${a.details}`)
      expect(audits).toContain(`cancelled procedure|encounter=${e.id} procedure=${r.procedureId}`)
      expect(audits).toContain(`billing: voided charge line|line=${line.id} procedure=${r.procedureId} cause=procedure_cancelled`)
      // Again: already void (409); unknown or another visit's procedure: 404.
      const again = await del(e.id, r.procedureId)
      expect(again.status).toBe(409)
      expect(await again.json()).toEqual({ error: 'This procedure is already cancelled.', code: 'already_void' })
      const other = await opdEncounter(pid, { encounterDate: await today() })
      expect((await del(other.id, r.procedureId)).status).toBe(404)
      expect((await del(e.id, 2147483000)).status).toBe(404)
    })

    it('a coded procedure cannot be cancelled (409 coded) and nothing changes', async () => {
      const pid = await newPatient()
      const e = await opdEncounter(pid, { encounterDate: await today() })
      const r = await orderAt(e, {}, new Date())
      await markCoded(r.procedureId)
      const res = await del(e.id, r.procedureId)
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'This procedure is coded; raise a coding query to change it.', code: 'coded' })
      expect((await proceduresOf(e.id)).map((p) => p.voidedAt)).toEqual([null])
      expect((await linesOf(pid)).map((l) => l.status)).toEqual(['captured'])
    })

    it('a procedure with no line cancels with billing: none', async () => {
      const pid = await newPatient()
      const { getDb, admissions, po } = await m()
      const [adm] = await getDb().insert(admissions).values({ patientId: pid, attendingProviderId: fx.prov }).returning()
      const e = await opdEncounter(pid, { encounterType: 'ipd', admissionId: adm.id })
      const r = await orderAt(e)
      expect(r.charge).toMatchObject({ ok: false, reason: 'blocked' })
      expect(await po.cancelProcedure(e, r.procedureId, doctor, LATER)).toEqual({ ok: true, billing: 'none' })
    })

    it('after a finalised invoice the procedure still cancels, the line is unchanged and billing is credit_note_needed', async () => {
      const pid = await newPatient()
      const e = await opdEncounter(pid)
      const r = await orderAt(e)
      const [line] = await linesOf(pid)
      const f = await finalise([line.id])
      const { po } = await m()
      expect(await po.cancelProcedure(e, r.procedureId, doctor, LATER)).toEqual({ ok: true, billing: 'credit_note_needed' })
      const [after] = await linesOf(pid)
      expect([after.status, after.invoiceId, after.voidReason]).toEqual(['invoiced', f.invoiceId, null])
      expect((await proceduresOf(e.id))[0].voidedAt).not.toBeNull()
    })
  })

  describe('visit cancel and procedures', () => {
    it('cancelling the visit voids its procedure lines and soft-voids its uncoded procedures', async () => {
      const pid = await newPatient()
      const e = await opdEncounter(pid)
      const a = await orderAt(e)
      const b = await orderAt(e, { quantity: 2 })
      const { enc, getDb, auditLog, eq } = await m()
      const c = await enc.transitionEncounter(e.id, 'cancelled', doctor, { cancelReason: 'Left', now: LATER })
      expect(c.ok).toBe(true)
      const procs = await proceduresOf(e.id)
      expect(procs.map((p) => [p.id, p.voidedAt?.toISOString() ?? null, p.voidedByName])).toEqual([
        [a.procedureId, LATER.toISOString(), doctor.name],
        [b.procedureId, LATER.toISOString(), doctor.name],
      ])
      const lines = await linesOf(pid)
      expect(lines.map((l) => [l.encounterProcedureId, l.status, l.voidReason])).toEqual([
        [a.procedureId, 'void', 'Visit cancelled'],
        [b.procedureId, 'void', 'Visit cancelled'],
      ])
      const audits = (await getDb().select().from(auditLog).where(eq(auditLog.patientId, pid))).map((x) => `${x.action}|${x.details}`)
      expect(audits).toContain(`cancelled procedure|encounter=${e.id} procedure=${a.procedureId} cause=visit_cancelled`)
      expect(audits).toContain(`billing: voided charge line|line=${lines[0].id} encounter=${e.id} cause=visit_cancelled`)
    })

    // WS2 T12 (controller ruling, consistent with T10's performed lab orders): a coded procedure
    // means the procedure was performed; the visit cannot be cancelled. Refused before any write.
    it('a coded live procedure refuses the visit cancel (visit_has_performed_orders) and changes nothing', async () => {
      const pid = await newPatient()
      const e = await opdEncounter(pid)
      const a = await orderAt(e)
      const b = await orderAt(e, { quantity: 2 })
      await markCoded(b.procedureId)
      const { enc, getDb, encounters, eq } = await m()
      const c = await enc.transitionEncounter(e.id, 'cancelled', doctor, { cancelReason: 'Left', now: LATER })
      expect(c).toEqual({ ok: false, error: 'visit_has_performed_orders' })
      expect((await proceduresOf(e.id)).map((p) => [p.id, p.voidedAt, p.codingStatus])).toEqual([[a.procedureId, null, 'uncoded'], [b.procedureId, null, 'coded']])
      expect((await linesOf(pid)).map((l) => [l.encounterProcedureId, l.status])).toEqual([[a.procedureId, 'captured'], [b.procedureId, 'captured']])
      const [after] = await getDb().select().from(encounters).where(eq(encounters.id, e.id))
      expect([after.status, after.cancelReason]).toEqual(['checked_in', null])
      // A voided coded procedure no longer blocks.
      await getDb().update((await m()).encounterProcedures).set({ voidedAt: NOW, voidedByName: 'TEST' }).where(eq((await m()).encounterProcedures.id, b.procedureId))
      expect((await enc.transitionEncounter(e.id, 'cancelled', doctor, { cancelReason: 'Left', now: LATER })).ok).toBe(true)
    })

    it('a procedure line on a finalised invoice blocks the visit cancel (visit_billed) and changes nothing', async () => {
      const pid = await newPatient()
      const e = await opdEncounter(pid)
      const a = await orderAt(e)
      const b = await orderAt(e)
      const [l0] = await linesOf(pid)
      const f = await finalise([l0.id])
      const { enc, getDb, encounters, eq } = await m()
      const c = await enc.transitionEncounter(e.id, 'cancelled', doctor, { cancelReason: 'Left', now: LATER })
      expect(c).toEqual({ ok: false, error: 'visit_billed', invoiceNumber: f.invoiceNumber })
      expect((await linesOf(pid)).map((l) => l.status)).toEqual(['invoiced', 'captured'])
      expect((await proceduresOf(e.id)).map((p) => [p.id, p.voidedAt])).toEqual([[a.procedureId, null], [b.procedureId, null]])
      const [after] = await getDb().select().from(encounters).where(eq(encounters.id, e.id))
      expect(after.status).toBe('checked_in')
    })

    it('lock order: the procedure rows are locked before the patient billing lock', async () => {
      const pid = await newPatient()
      const e = await opdEncounter(pid)
      const r = await orderAt(e)
      const { enc, getDb, sql } = await m()
      const db = getDb()
      let release!: () => void
      const gate = new Promise<void>((res) => { release = res })
      let held!: () => void
      const holding = new Promise<void>((res) => { held = res })
      const holder = db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`billing:patient:${pid}`}))`)
        held()
        await gate
      })
      await holding
      const cancel = enc.transitionEncounter(e.id, 'cancelled', doctor, { cancelReason: 'Left', now: LATER })
      for (let i = 0; i < 200; i++) {
        const res = await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`)
        if (Number((res as unknown as { rows: { n: number }[] }).rows[0].n) > 0) break
        await new Promise((res) => setTimeout(res, 25))
      }
      let nowait: string | null = null
      try {
        await db.transaction(async (tx) => { await tx.execute(sql`select id from encounter_procedures where id = ${r.procedureId} for update nowait`) })
      } catch (err) {
        const { pgErrorCode } = await import('@/lib/db-errors')
        nowait = pgErrorCode(err)
      }
      release()
      await holder
      expect((await cancel).ok).toBe(true)
      expect(nowait).toBe('55P03')
    })
  })
})
