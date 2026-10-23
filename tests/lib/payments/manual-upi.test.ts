import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import type { Session } from '@/lib/auth'
import { upiUri } from '@/lib/payments/manual-upi'

// Foundations T11: UPI QR payments. The URI builder is pure; the request/confirm path runs
// against the real DB in its own financial year (2098-99) so it never collides with the
// 2099-00 numbering the SP4 ledger tests pin.

describe('upiUri', () => {
  it('builds a upi://pay URI with the amount in rupees to two decimals and INR', () => {
    expect(upiUri('hospital@icici', 'Sunrise Hospital', 250050, 'OPD bill')).toBe(
      'upi://pay?pa=hospital@icici&pn=Sunrise%20Hospital&am=2500.50&cu=INR&tn=OPD%20bill',
    )
    expect(upiUri('a.b-c@okaxis', 'X', 5, 'n')).toContain('am=0.05&')
    expect(upiUri('a@ybl', 'X', 100, 'n')).toContain('am=1.00&')
    expect(upiUri('a@ybl', 'X', 1_000_000_000_000, 'n')).toContain('am=10000000000.00&')
  })

  it('URL-encodes the payee name and note, so & = # ? cannot break out of a parameter', () => {
    const uri = upiUri('a@ybl', 'A&B Hospital', 100, 'Bill #12 & more=yes?')
    expect(uri).toBe('upi://pay?pa=a@ybl&pn=A%26B%20Hospital&am=1.00&cu=INR&tn=Bill%20%2312%20%26%20more%3Dyes%3F')
    const params = new URLSearchParams(uri.split('?')[1])
    expect([...params.keys()]).toEqual(['pa', 'pn', 'am', 'cu', 'tn'])
    expect(params.get('tn')).toBe('Bill #12 & more=yes?')
  })

  it('refuses a non-integer, zero or negative amount and a malformed VPA', () => {
    expect(() => upiUri('a@ybl', 'X', 10.5, 'n')).toThrow()
    expect(() => upiUri('a@ybl', 'X', 0, 'n')).toThrow()
    expect(() => upiUri('a@ybl', 'X', -100, 'n')).toThrow()
    expect(() => upiUri('not a vpa', 'X', 100, 'n')).toThrow()
    expect(() => upiUri('a@ybl&pn=evil', 'X', 100, 'n')).toThrow()
  })
})

describe('gateway provider stub', () => {
  it('reports not configured and refuses to create a request', async () => {
    const { gatewayProvider } = await import('@/lib/payments/gateway')
    expect(gatewayProvider.name).toBe('gateway')
    expect(gatewayProvider.status()).toEqual({ configured: false, reason: expect.any(String) })
    await expect(gatewayProvider.createRequest({ patientId: 'RD-1', amountPaise: 100, note: 'x' })).rejects.toMatchObject({ code: 'not_configured' })
    await expect(gatewayProvider.recordConfirmation({ requestId: 1, utr: '123456789012' })).rejects.toMatchObject({ code: 'not_configured' })
  })
})

const NOW = new Date('2098-06-01T06:00:00Z')
const FY = '2098-99'

describe.skipIf(!process.env.DATABASE_URL)('manual UPI QR requests (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const PID = `TEST-T11-${RUN}`
  const PID2 = `TEST-T11-${RUN}-B` // a second patient: the cross-patient UTR race is not serialised by the billing lock
  const desk: Session = { role: 'frontdesk', name: `TEST-T11-${RUN}-desk`, userId: null }
  const utr = (n: number) => `${String(Date.now()).slice(-8)}${String(n).padStart(4, '0')}`

  const m = async () => ({
    ...(await import('@/db/client')), ...(await import('@/db/schema')), ...(await import('drizzle-orm')),
    upi: await import('@/lib/payments/manual-upi'),
    pl: await import('@/lib/queries/patient-ledger'),
  })

  async function purge() {
    const { getDb, paymentRequests, patientPayments, refunds, invoices, documentCounters, eq, inArray, sql } = await m()
    await getDb().transaction(async (tx) => {
      await tx.execute(sql`select set_config('hims.allow_document_purge', 'on', true)`)
      await tx.delete(paymentRequests).where(inArray(paymentRequests.patientId, [PID, PID2]))
      await tx.delete(refunds).where(inArray(refunds.patientId, [PID, PID2]))
      await tx.delete(patientPayments).where(inArray(patientPayments.patientId, [PID, PID2]))
      await tx.delete(invoices).where(inArray(invoices.patientId, [PID, PID2]))
      await tx.delete(documentCounters).where(eq(documentCounters.financialYear, FY))
    })
  }

  beforeAll(async () => {
    vi.stubEnv('HOSPITAL_UPI_VPA', 'sunrise.hospital@icici')
    vi.stubEnv('HOSPITAL_UPI_PAYEE', 'Sunrise Hospital')
    const { getDb, patients } = await m()
    await getDb().insert(patients).values([
      { id: PID, name: `Test T11 Upi ${RUN}`, dob: '1990-01-01' },
      { id: PID2, name: `Test T11 Upi B ${RUN}`, dob: '1990-01-01' },
    ])
  })

  afterEach(async () => {
    vi.stubEnv('HOSPITAL_UPI_VPA', 'sunrise.hospital@icici')
    await purge()
  })

  afterAll(async () => {
    const { getDb, patients, auditLog, inArray } = await m()
    await purge()
    await getDb().delete(auditLog).where(inArray(auditLog.patientId, [PID, PID2]))
    await getDb().delete(patients).where(inArray(patients.id, [PID, PID2]))
    vi.unstubAllEnvs()
  })

  async function receiptsOf() {
    const { getDb, patientPayments, eq } = await m()
    return getDb().select().from(patientPayments).where(eq(patientPayments.patientId, PID))
  }

  it('without HOSPITAL_UPI_VPA a request is refused as not configured and nothing is stored', async () => {
    const { upi, getDb, paymentRequests, eq } = await m()
    vi.stubEnv('HOSPITAL_UPI_VPA', '')
    expect(await upi.createUpiRequest({ patientId: PID, amountPaise: 50000 }, desk, NOW)).toEqual({ ok: false, error: 'not_configured' })
    expect(await getDb().select().from(paymentRequests).where(eq(paymentRequests.patientId, PID))).toEqual([])
  })

  it('creates a pending request with a server-rendered QR of the UPI URI', async () => {
    const { upi } = await m()
    const r = await upi.createUpiRequest({ patientId: PID, amountPaise: 123456, note: 'OPD bill' }, desk, NOW)
    if (!r.ok) throw new Error(r.error)
    expect(r.uri).toBe('upi://pay?pa=sunrise.hospital@icici&pn=Sunrise%20Hospital&am=1234.56&cu=INR&tn=OPD%20bill')
    expect(r.qrDataUrl).toMatch(/^data:image\/png;base64,/)
    expect(r).toMatchObject({ vpa: 'sunrise.hospital@icici', payeeName: 'Sunrise Hospital', amountPaise: 123456 })
    expect(await upi.createUpiRequest({ patientId: `${PID}-missing`, amountPaise: 100 }, desk)).toEqual({ ok: false, error: 'patient_not_found' })
  })

  it('confirming with a UTR posts exactly one receipt (RCT numbering, mode upi, UTR as reference)', async () => {
    const { upi, pl, getDb } = await m()
    const r = await upi.createUpiRequest({ patientId: PID, amountPaise: 50000 }, desk, NOW)
    if (!r.ok) throw new Error(r.error)
    const ref = utr(1)
    const c = await upi.confirmUpiRequest({ requestId: r.requestId, utr: ref }, desk, NOW)
    expect(c).toMatchObject({ ok: true, receiptNumber: 'RCT/98-99/000001' })
    const rows = await receiptsOf()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'receipt', mode: 'upi', reference: ref, amountPaise: 50000, financialYear: FY })
    const ledger = await pl.loadLedgerEntries(getDb(), PID)
    expect(ledger.map((e) => [e.kind, e.amountPaise])).toEqual([['receipt', 50000]])
  })

  it('the same UTR a second time is a duplicate with no extra row, on the same or another request', async () => {
    const { upi, getDb, paymentRequests, eq } = await m()
    const a = await upi.createUpiRequest({ patientId: PID, amountPaise: 50000 }, desk, NOW)
    const b = await upi.createUpiRequest({ patientId: PID, amountPaise: 50000 }, desk, NOW)
    if (!a.ok || !b.ok) throw new Error('create failed')
    const ref = utr(2)
    expect((await upi.confirmUpiRequest({ requestId: a.requestId, utr: ref }, desk, NOW)).ok).toBe(true)
    expect(await upi.confirmUpiRequest({ requestId: a.requestId, utr: ref }, desk, NOW)).toEqual({ ok: false, error: 'already_confirmed' })
    expect(await upi.confirmUpiRequest({ requestId: b.requestId, utr: ref }, desk, NOW)).toEqual({ ok: false, error: 'duplicate_utr' })
    expect(await receiptsOf()).toHaveLength(1)
    const [still] = await getDb().select().from(paymentRequests).where(eq(paymentRequests.id, b.requestId))
    expect(still).toMatchObject({ status: 'pending', utr: null })
  })

  it('a double-click (two confirmations at once) records one receipt only', async () => {
    const { upi } = await m()
    const a = await upi.createUpiRequest({ patientId: PID, amountPaise: 70000 }, desk, NOW)
    const b = await upi.createUpiRequest({ patientId: PID, amountPaise: 70000 }, desk, NOW)
    if (!a.ok || !b.ok) throw new Error('create failed')
    const ref = utr(3)
    const results = await Promise.all([
      upi.confirmUpiRequest({ requestId: a.requestId, utr: ref }, desk, NOW),
      upi.confirmUpiRequest({ requestId: a.requestId, utr: ref }, desk, NOW),
      upi.confirmUpiRequest({ requestId: b.requestId, utr: ref }, desk, NOW),
    ])
    expect(results.filter((x) => x.ok)).toHaveLength(1)
    expect(results.filter((x) => !x.ok).map((x) => (x as { error: string }).error).sort().every((e) => ['already_confirmed', 'duplicate_utr'].includes(e))).toBe(true)
    expect(await receiptsOf()).toHaveLength(1)
  })

  it('a UTR already recorded by hand as a UPI payment is refused as a duplicate', async () => {
    const { upi, pl } = await m()
    const ref = utr(4)
    const manual = await pl.recordPayment({ patientId: PID, kind: 'receipt', mode: 'upi', reference: ref, amountPaise: 1000 }, desk, NOW)
    expect(manual.ok).toBe(true)
    const r = await upi.createUpiRequest({ patientId: PID, amountPaise: 1000 }, desk, NOW)
    if (!r.ok) throw new Error(r.error)
    expect(await upi.confirmUpiRequest({ requestId: r.requestId, utr: ref }, desk, NOW)).toEqual({ ok: false, error: 'duplicate_utr' })
    expect(await receiptsOf()).toHaveLength(1)
  })

  it('every payment mode lands in the same ledger and the same RCT series', async () => {
    const { upi, pl, getDb } = await m()
    const modes = [
      { mode: 'cash' }, { mode: 'card', reference: 'APPR123456' }, { mode: 'cheque', reference: 'CHQ004512' },
      { mode: 'neft', reference: 'NEFTN12345' }, { mode: 'other', reference: 'VOUCHER77' },
    ] as const
    for (const m0 of modes) {
      const p = await pl.recordPayment({ patientId: PID, kind: 'receipt', amountPaise: 1000, ...m0 }, desk, NOW)
      expect(p.ok, m0.mode).toBe(true)
    }
    const r = await upi.createUpiRequest({ patientId: PID, amountPaise: 1000 }, desk, NOW)
    if (!r.ok) throw new Error(r.error)
    expect((await upi.confirmUpiRequest({ requestId: r.requestId, utr: utr(5) }, desk, NOW)).ok).toBe(true)
    const rows = await receiptsOf()
    expect(rows.map((x) => x.mode).sort()).toEqual(['card', 'cash', 'cheque', 'neft', 'other', 'upi'])
    expect(rows.map((x) => x.receiptNumber).sort()).toEqual([1, 2, 3, 4, 5, 6].map((n) => `RCT/98-99/00000${n}`))
    const ledger = await pl.loadLedgerEntries(getDb(), PID)
    expect(ledger.filter((e) => e.kind === 'receipt')).toHaveLength(6)
  })

  it('the provider interface wraps the same path', async () => {
    const { upi } = await m()
    const provider = upi.manualUpiProvider(desk, () => NOW)
    expect(provider.name).toBe('manual_upi_qr')
    const req = await provider.createRequest({ patientId: PID, amountPaise: 2500, note: 'Pharmacy' })
    expect(req.qrPayload).toMatch(/^upi:\/\/pay\?pa=sunrise\.hospital@icici&/)
    const ref = utr(6)
    expect(await provider.recordConfirmation({ requestId: req.requestId, utr: ref })).toEqual({ receiptNo: 'RCT/98-99/000001' })
    await expect(provider.recordConfirmation({ requestId: req.requestId, utr: ref })).rejects.toMatchObject({ code: 'already_confirmed' })
  })

  it('audit rows carry ids only, never the UTR', async () => {
    const { upi, getDb, auditLog, eq } = await m()
    const r = await upi.createUpiRequest({ patientId: PID, amountPaise: 3000 }, desk, NOW)
    if (!r.ok) throw new Error(r.error)
    const ref = utr(7)
    await upi.confirmUpiRequest({ requestId: r.requestId, utr: ref }, desk, NOW)
    const rows = await getDb().select().from(auditLog).where(eq(auditLog.patientId, PID))
    expect(rows.length).toBeGreaterThan(0)
    for (const a of rows) expect(`${a.action} ${a.details ?? ''}`).not.toContain(ref)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('Foundations T11 fixes: duplicate UTR paths, races, expiry, note (DB)', () => {
  // Kept in the same file so it shares nothing but the module; own patients, own FY purge.
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}-fx`
  const PID = `TEST-T11F-${RUN}`
  const PID2 = `TEST-T11F-${RUN}-B`
  const desk: Session = { role: 'frontdesk', name: `TEST-T11F-${RUN}-desk`, userId: null }
  const FY2 = '2097-98'
  const NOW2 = new Date('2097-06-01T06:00:00Z')
  const utr = (n: number) => `${String(Date.now()).slice(-7)}9${String(n).padStart(4, '0')}`

  const m = async () => ({
    ...(await import('@/db/client')), ...(await import('@/db/schema')), ...(await import('drizzle-orm')),
    upi: await import('@/lib/payments/manual-upi'),
    pl: await import('@/lib/queries/patient-ledger'),
  })

  async function purge() {
    const { getDb, paymentRequests, patientPayments, refunds, invoices, documentCounters, eq, inArray, sql } = await m()
    await getDb().transaction(async (tx) => {
      await tx.execute(sql`select set_config('hims.allow_document_purge', 'on', true)`)
      await tx.delete(paymentRequests).where(inArray(paymentRequests.patientId, [PID, PID2]))
      await tx.delete(refunds).where(inArray(refunds.patientId, [PID, PID2]))
      await tx.delete(patientPayments).where(inArray(patientPayments.patientId, [PID, PID2]))
      await tx.delete(invoices).where(inArray(invoices.patientId, [PID, PID2]))
      await tx.delete(documentCounters).where(eq(documentCounters.financialYear, FY2))
    })
  }

  beforeAll(async () => {
    vi.stubEnv('HOSPITAL_UPI_VPA', 'sunrise.hospital@icici')
    vi.stubEnv('HOSPITAL_UPI_PAYEE', 'Sunrise Hospital')
    const { getDb, patients } = await m()
    await getDb().insert(patients).values([
      { id: PID, name: `Test T11F ${RUN}`, dob: '1990-01-01' },
      { id: PID2, name: `Test T11F B ${RUN}`, dob: '1990-01-01' },
    ])
  })
  afterEach(async () => { await purge() })
  afterAll(async () => {
    const { getDb, patients, auditLog, inArray } = await m()
    await purge()
    await getDb().delete(auditLog).where(inArray(auditLog.patientId, [PID, PID2]))
    await getDb().delete(patients).where(inArray(patients.id, [PID, PID2]))
    vi.unstubAllEnvs()
  })

  async function receipts() {
    const { getDb, patientPayments, inArray } = await m()
    return getDb().select().from(patientPayments).where(inArray(patientPayments.patientId, [PID, PID2]))
  }
  async function request(id: number) {
    const { getDb, paymentRequests, eq } = await m()
    return (await getDb().select().from(paymentRequests).where(eq(paymentRequests.id, id)))[0]
  }
  async function create(patientId: string, amountPaise: number, extra: Record<string, unknown> = {}, at = NOW2) {
    const { upi } = await m()
    const r = await upi.createUpiRequest({ patientId, amountPaise, ...extra }, desk, at)
    if (!r.ok) throw new Error(r.error)
    return r
  }
  async function finalisedInvoice(totalPaise: number) {
    const { getDb, invoices } = await m()
    const [row] = await getDb().insert(invoices).values({
      invoiceNumber: `TEST-T11F-INV-${RUN}-${Math.floor(Math.random() * 1e9)}`, status: 'finalised', patientId: PID, totalPaise,
      snapshot: {} as never, invoiceDate: '2097-06-01', financialYear: FY2, createdByName: 'TEST-T11F', finalisedAt: NOW2,
    }).returning({ id: invoices.id })
    return row.id
  }

  it('a UTR confirmed through a QR request cannot be recorded again as a manual UPI payment (any spacing or case)', async () => {
    const { upi, pl } = await m()
    const r = await create(PID, 50000)
    const ref = utr(1)
    expect((await upi.confirmUpiRequest({ requestId: r.requestId, utr: ref }, desk, NOW2)).ok).toBe(true)
    for (const reference of [ref, `${ref.slice(0, 4)} ${ref.slice(4, 8)}-${ref.slice(8)}`]) {
      expect(await pl.recordPayment({ patientId: PID, kind: 'receipt', mode: 'upi', reference, amountPaise: 50000 }, desk, NOW2)).toEqual({ ok: false, error: 'duplicate_utr' })
      expect(await pl.recordPayment({ patientId: PID2, kind: 'receipt', mode: 'upi', reference, amountPaise: 50000 }, desk, NOW2)).toEqual({ ok: false, error: 'duplicate_utr' })
    }
    expect(await receipts()).toHaveLength(1)
  })

  it('two manual UPI payments with one UTR: the second is refused; non-UPI modes are not checked', async () => {
    const { pl } = await m()
    const ref = utr(2)
    expect((await pl.recordPayment({ patientId: PID, kind: 'receipt', mode: 'upi', reference: ref, amountPaise: 1000 }, desk, NOW2)).ok).toBe(true)
    expect(await pl.recordPayment({ patientId: PID2, kind: 'receipt', mode: 'upi', reference: ref.toLowerCase(), amountPaise: 1000 }, desk, NOW2)).toEqual({ ok: false, error: 'duplicate_utr' })
    expect((await pl.recordPayment({ patientId: PID, kind: 'receipt', mode: 'neft', reference: ref, amountPaise: 1000 }, desk, NOW2)).ok).toBe(true)
    expect(await receipts()).toHaveLength(2)
  })

  it('two patients, two requests, one UTR, confirmed at once: one receipt, one duplicate_utr, no RCT number skipped', async () => {
    const { upi, pl } = await m()
    const a = await create(PID, 40000)
    const b = await create(PID2, 40000)
    const ref = utr(3)
    const results = await Promise.all([
      upi.confirmUpiRequest({ requestId: a.requestId, utr: ref }, desk, NOW2),
      upi.confirmUpiRequest({ requestId: b.requestId, utr: ref }, desk, NOW2),
    ])
    expect(results.filter((x) => x.ok)).toHaveLength(1)
    expect(results.filter((x) => !x.ok)).toEqual([{ ok: false, error: 'duplicate_utr' }])
    const rows = await receipts()
    expect(rows).toHaveLength(1)
    expect(rows[0].receiptNumber).toBe('RCT/97-98/000001')
    const next = await pl.recordPayment({ patientId: PID, kind: 'receipt', mode: 'cash', amountPaise: 100 }, desk, NOW2)
    expect(next).toMatchObject({ ok: true, receiptNumber: 'RCT/97-98/000002' })
  })

  it('a manual UPI payment and a QR confirmation of one UTR for two patients at once: exactly one receipt', async () => {
    const { upi, pl } = await m()
    const b = await create(PID2, 40000)
    const ref = utr(4)
    const results = await Promise.all([
      pl.recordPayment({ patientId: PID, kind: 'receipt', mode: 'upi', reference: ref, amountPaise: 40000 }, desk, NOW2),
      upi.confirmUpiRequest({ requestId: b.requestId, utr: ref }, desk, NOW2),
    ])
    expect(results.filter((x) => x.ok)).toHaveLength(1)
    expect(results.filter((x) => !x.ok)).toEqual([{ ok: false, error: 'duplicate_utr' }])
    expect(await receipts()).toHaveLength(1)
  })

  it('a request older than 24 hours is expired and writes nothing', async () => {
    const { upi } = await m()
    const r = await create(PID, 1000)
    const later = new Date(NOW2.getTime() + 24 * 3600_000 + 1000)
    expect(await upi.confirmUpiRequest({ requestId: r.requestId, utr: utr(5) }, desk, later)).toEqual({ ok: false, error: 'request_expired' })
    expect(await receipts()).toEqual([])
    expect(await request(r.requestId)).toMatchObject({ status: 'pending', utr: null })
    const justInTime = new Date(NOW2.getTime() + 23 * 3600_000)
    expect((await upi.confirmUpiRequest({ requestId: r.requestId, utr: utr(5) }, desk, justInTime)).ok).toBe(true)
  })

  it('a cancelled request is expired; cancelling is pending-only and writes nothing to the ledger', async () => {
    const { upi } = await m()
    const r = await create(PID, 1000)
    expect(await upi.cancelUpiRequest(r.requestId, desk)).toEqual({ ok: true })
    expect(await upi.cancelUpiRequest(r.requestId, desk)).toEqual({ ok: false, error: 'not_pending' })
    expect(await upi.cancelUpiRequest(2147483000, desk)).toEqual({ ok: false, error: 'request_not_found' })
    expect(await upi.confirmUpiRequest({ requestId: r.requestId, utr: utr(6) }, desk, NOW2)).toEqual({ ok: false, error: 'request_expired' })
    expect(await receipts()).toEqual([])
    expect(await request(r.requestId)).toMatchObject({ status: 'cancelled', utr: null, paymentId: null })
  })

  it('a request against an invoice that is already fully paid is expired and writes nothing', async () => {
    const { upi, pl } = await m()
    const invoiceId = await finalisedInvoice(5000)
    const r = await create(PID, 5000, { kind: 'receipt', invoiceId })
    expect((await pl.recordPayment({ patientId: PID, kind: 'receipt', invoiceId, mode: 'cash', amountPaise: 5000 }, desk, NOW2)).ok).toBe(true)
    expect(await upi.confirmUpiRequest({ requestId: r.requestId, utr: utr(7) }, desk, NOW2)).toEqual({ ok: false, error: 'request_expired' })
    expect(await receipts()).toHaveLength(1)
    expect(await request(r.requestId)).toMatchObject({ status: 'pending', utr: null })
  })

  it('the default note names the request, never the patient id', async () => {
    const r = await create(PID, 1000)
    expect(r.note).toBe(`Hospital payment #${r.requestId}`)
    expect(r.uri).toContain(`&tn=Hospital%20payment%20%23${r.requestId}`)
    expect(r.uri).not.toContain(PID)
    expect((await request(r.requestId)).note).toBe(`Hospital payment #${r.requestId}`)
  })
})
