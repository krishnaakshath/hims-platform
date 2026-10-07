import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { Role } from '@/lib/auth'
import { ALL_ROLES, TARIFF_MANAGE_ROLES } from '@/lib/role-policy'
import { MAX_IMPORT_BYTES, RATE_CSV_HEADERS, SERVICE_CSV_HEADERS, type ImportLookups } from '@/lib/tariff/import'

let sessionRole: Role | null = 'billing'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return {
    ...actual,
    requireSession: vi.fn(async () =>
      sessionRole === null ? NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) : { role: sessionRole, name: 'Probe', userId: null }),
  }
})
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/tariff', async () => {
  const actual = await vi.importActual<typeof import('@/lib/queries/tariff')>('@/lib/queries/tariff')
  return { ...actual, getImportLookups: vi.fn(), commitServiceImport: vi.fn(), commitRateImport: vi.fn() }
})

import { getImportLookups, commitServiceImport, commitRateImport } from '@/lib/queries/tariff'
import { logAudit } from '@/lib/audit'
import { POST as postTariffImport } from '@/app/api/tariff/import/route'

const URL_ = 'http://localhost/api/tariff/import'
const JSON_CT = { 'content-type': 'application/json' }
// Streamed bodies need `duplex: 'half'`, which the DOM RequestInit typing does not declare.
type NextInit = ConstructorParameters<typeof NextRequest>[1]
const post = (body: unknown, headers: Record<string, string> = JSON_CT) =>
  new NextRequest(URL_, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })

const lookups = (): ImportLookups => ({
  departmentsByCode: new Map([['GEN', 3]]),
  payersByCode: new Map([['STAR', 5]]),
  roomCategoriesByCode: new Map([['ICU', 4]]),
  servicesByCode: new Map([['CONS-GEN', { id: 7, category: 'consultation' }]]),
  existingRates: [],
})

const RATE_HEADER = RATE_CSV_HEADERS.join(',')
const SERVICE_HEADER = SERVICE_CSV_HEADERS.join(',')
const goodRates = `﻿${RATE_HEADER}\r\nCONS-GEN,base,,,,,500,2026-10-07,\r\nCONS-GEN,payer,,STAR,ICU, ICU  Ward ,"1,250.00",2026-10-07,2027-03-31\r\n\r\n`
const goodServices = `${SERVICE_HEADER}\nXRAY-CHEST,X-ray chest,GEN,investigation_imaging,999316,18,yes\nCONS-GEN,"Consultation, general",GEN,consultation,999312,0,no\n`
const badRates = `${RATE_HEADER}\nCONS-GEN,base,,,,,500,2026-10-07,\nNOPE,base,,,,,abc,2026-10-07,\n`

const conflict = { error: 'Import conflicts with existing data; nothing was applied' }
const pgErr = (code: string, constraint?: string) => Object.assign(new Error('pg detail with row data'), { cause: { code, constraint } })

beforeEach(() => {
  sessionRole = 'billing'
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.mocked(getImportLookups).mockResolvedValue(lookups())
  vi.mocked(commitRateImport).mockImplementation(async (rows) => rows.length)
  vi.mocked(commitServiceImport).mockImplementation(async (rows) => rows.length)
})

const nothingWritten = () => {
  expect(commitRateImport).not.toHaveBeenCalled()
  expect(commitServiceImport).not.toHaveBeenCalled()
  expect(logAudit).not.toHaveBeenCalled()
}

describe('POST /api/tariff/import: gate', () => {
  it('403s crc and frontdesk', async () => {
    for (const role of ['crc', 'frontdesk'] as const) {
      sessionRole = role
      const res = await postTariffImport(post({ kind: 'rates', csv: goodRates, commit: true }))
      expect(res.status, role).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    nothingWritten()
    expect(getImportLookups).not.toHaveBeenCalled()
  })

  it('403s every non-manage role before reading the body, whatever its type or size', async () => {
    let pulled = 0
    for (const role of ALL_ROLES.filter((r) => !TARIFF_MANAGE_ROLES.includes(r))) {
      sessionRole = role
      const stream = new ReadableStream({ pull() { pulled++ } }, { highWaterMark: 0 }) // pulls only when read
      const res = await postTariffImport(new NextRequest(URL_, {
        method: 'POST', headers: { 'content-type': 'text/csv', 'content-length': '999999999' }, body: stream, duplex: 'half',
      } as NextInit))
      expect(res.status, role).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(pulled).toBe(0)
    expect(getImportLookups).not.toHaveBeenCalled()
  })

  it('401s without a session', async () => {
    sessionRole = null
    expect((await postTariffImport(post({ kind: 'rates', csv: goodRates, commit: true }))).status).toBe(401)
    nothingWritten()
  })
})

describe('POST /api/tariff/import: transport limits', () => {
  it.each([
    ['text/plain', { 'content-type': 'text/plain' }],
    ['multipart', { 'content-type': 'multipart/form-data; boundary=x' }],
    ['text/csv', { 'content-type': 'text/csv' }],
    ['a missing content type', {}],
  ])('415s %s', async (_label, headers) => {
    const res = await postTariffImport(new NextRequest(URL_, { method: 'POST', headers, body: JSON.stringify({ kind: 'rates', csv: goodRates, commit: false }) }))
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'Send the import as application/json' })
    expect(getImportLookups).not.toHaveBeenCalled()
  })

  it('accepts application/json with a charset parameter', async () => {
    const res = await postTariffImport(post({ kind: 'rates', csv: goodRates, commit: false }, { 'content-type': 'Application/JSON; charset=utf-8' }))
    expect(res.status).toBe(200)
  })

  it('413s a declared content-length over the cap without reading the body', async () => {
    let pulled = 0
    const stream = new ReadableStream({ pull() { pulled++ } }, { highWaterMark: 0 }) // pulls only when read
    const res = await postTariffImport(new NextRequest(URL_, {
      method: 'POST', headers: { ...JSON_CT, 'content-length': String(3 * MAX_IMPORT_BYTES) }, body: stream, duplex: 'half',
    } as NextInit))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'CSV is larger than 1 MB' })
    expect(pulled).toBe(0)
  })

  it('400s a malformed content-length', async () => {
    const res = await postTariffImport(post({ kind: 'rates', csv: goodRates, commit: false }, { ...JSON_CT, 'content-length': '12abc' }))
    expect(res.status).toBe(400)
  })

  it('stops reading a streamed body (no content-length) once it passes the cap', async () => {
    const chunk = new Uint8Array(256 * 1024).fill(0x20)
    let pulled = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { pulled++; if (pulled > 400) c.close(); else c.enqueue(chunk) },
      cancel() { cancelled = true },
    })
    const res = await postTariffImport(new NextRequest(URL_, { method: 'POST', headers: JSON_CT, body: stream, duplex: 'half' } as NextInit))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'CSV is larger than 1 MB' })
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThan(20) // ~2 MB cap / 256 KiB chunks, never the whole 100 MB
    expect(getImportLookups).not.toHaveBeenCalled()
  })

  it('rejects a CSV over 1 MB', async () => {
    const big = `${RATE_HEADER}\n${'x'.repeat(MAX_IMPORT_BYTES)}`
    const res = await postTariffImport(post({ kind: 'rates', csv: big, commit: false }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'CSV is larger than 1 MB' })
    expect(getImportLookups).not.toHaveBeenCalled()
  })

  it('measures the CSV in UTF-8 bytes, not characters', async () => {
    const big = '₹'.repeat(Math.ceil(MAX_IMPORT_BYTES / 3) + 1) // ~333k chars, >1 MB of UTF-8
    expect(big.length).toBeLessThan(MAX_IMPORT_BYTES)
    const res = await postTariffImport(post({ kind: 'rates', csv: big, commit: false }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'CSV is larger than 1 MB' })
  })

  it('accepts a CSV of exactly 1 MB', async () => {
    const head = `${RATE_HEADER}\nCONS-GEN,base,,,,,500,2026-10-07,\n`
    const csv = head + '\n'.repeat(MAX_IMPORT_BYTES - head.length) // trailing blank lines (Excel)
    expect(new TextEncoder().encode(csv).length).toBe(MAX_IMPORT_BYTES)
    const res = await postTariffImport(post({ kind: 'rates', csv, commit: false }))
    expect(res.status).toBe(200)
  })
})

describe('POST /api/tariff/import: body', () => {
  it.each([
    ['not JSON', '{not json'],
    ['an unknown key', { kind: 'rates', csv: goodRates, commit: false, patientId: 'RD-1' }],
    ['a string commit flag', { kind: 'rates', csv: goodRates, commit: 'true' }],
    ['an unknown kind', { kind: 'patients', csv: goodRates, commit: false }],
    ['a missing csv', { kind: 'rates', commit: false }],
    ['an array', [1, 2]],
  ])('400s %s with a fixed message', async (_label, body) => {
    const res = await postTariffImport(post(body))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid import' })
    expect(getImportLookups).not.toHaveBeenCalled()
  })

  it('400s a body that is not valid UTF-8', async () => {
    const bytes = new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]) // {"\xff\xfe"}
    const res = await postTariffImport(new NextRequest(URL_, { method: 'POST', headers: JSON_CT, body: bytes }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid import' })
  })
})

describe('POST /api/tariff/import: validate and commit', () => {
  it('dry run returns issues and never commits', async () => {
    const res = await postTariffImport(post({ kind: 'rates', csv: badRates, commit: false }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ kind: 'rates', committed: false })
    expect(body.applied).toBeUndefined()
    expect(body.issues).toEqual([
      { line: 3, column: 'service_code', message: 'Unknown service code NOPE' },
      { line: 3, column: 'amount_inr', message: 'Amount must be a rupee value such as 1250 or 1,250.50' },
    ])
    nothingWritten()
  })

  it('a clean dry run reports the valid row count and still writes nothing', async () => {
    const res = await postTariffImport(post({ kind: 'rates', csv: goodRates, commit: false }))
    expect(await res.json()).toEqual({ kind: 'rates', rowCount: 2, issues: [], committed: false })
    nothingWritten()
  })

  it('never echoes more than 40 characters of a cell', async () => {
    const payload = `EVIL${'A'.repeat(200)}`
    const res = await postTariffImport(post({ kind: 'rates', csv: `${RATE_HEADER}\n${payload},base,,,,,500,2026-10-07,\n`, commit: false }))
    const text = await res.clone().text()
    expect(text).not.toContain(payload.slice(0, 41))
    expect((await res.json()).issues[0].message).toBe(`Unknown service code ${payload.slice(0, 40)}…`)
  })

  it('a header or syntax problem is a line-numbered issue, not an error', async () => {
    const res = await postTariffImport(post({ kind: 'services', csv: 'code,name\nA,B\n', commit: false }))
    expect(res.status).toBe(200)
    expect((await res.json()).issues).toEqual([{ line: 1, message: `Header must be exactly: ${SERVICE_CSV_HEADERS.join(',')}` }])
  })

  it('commit with issues returns 422 and does not call commitRateImport', async () => {
    const res = await postTariffImport(post({ kind: 'rates', csv: badRates, commit: true }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body).toMatchObject({ kind: 'rates', committed: false })
    expect(body.issues.length).toBeGreaterThan(0)
    nothingWritten()
  })

  it('commit without issues applies and audits the count', async () => {
    const res = await postTariffImport(post({ kind: 'rates', csv: goodRates, commit: true }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ kind: 'rates', rowCount: 2, issues: [], committed: true, applied: 2 })
    expect(commitRateImport).toHaveBeenCalledTimes(1)
    const [rows, byName, audit] = vi.mocked(commitRateImport).mock.calls[0]
    expect(rows).toEqual([
      { serviceId: 7, scope: 'base', amountPaise: 50_000, validFrom: '2026-10-07' },
      { serviceId: 7, scope: 'payer', payerId: 5, roomCategoryId: 4, ward: 'ICU  Ward', amountPaise: 125_000, validFrom: '2026-10-07', validTo: '2027-03-31' },
    ])
    expect(byName).toBe('Probe')
    expect(audit).toEqual({ session: expect.objectContaining({ role: 'billing', name: 'Probe' }), action: 'tariff: imported 2 rates' })
    // The audit row is written by the query layer inside the import transaction, never afterwards.
    expect(logAudit).not.toHaveBeenCalled()
    expect(commitServiceImport).not.toHaveBeenCalled()
  })

  it('commits services (insert and update) in one call and audits the count', async () => {
    sessionRole = 'admin'
    const res = await postTariffImport(post({ kind: 'services', csv: goodServices, commit: true }))
    expect(await res.json()).toEqual({ kind: 'services', rowCount: 2, issues: [], committed: true, applied: 2 })
    const [rows, audit] = vi.mocked(commitServiceImport).mock.calls[0]
    expect(rows.map((r) => [r.code, r.existingId, r.isActive])).toEqual([['XRAY-CHEST', null, true], ['CONS-GEN', 7, false]])
    expect(audit).toEqual({ session: expect.objectContaining({ role: 'admin' }), action: 'tariff: imported 2 services' })
    expect(commitRateImport).not.toHaveBeenCalled()
  })

  it('stores a formula-looking cell verbatim as data (exports must escape it)', async () => {
    const csv = `${SERVICE_HEADER}\nFORMULA-1,"=HYPERLINK(""http://x"",""y"")",GEN,procedure,999311,18,yes\n`
    const res = await postTariffImport(post({ kind: 'services', csv, commit: true }))
    expect(res.status).toBe(200)
    expect(vi.mocked(commitServiceImport).mock.calls[0][0][0].name).toBe('=HYPERLINK("http://x","y")')
  })

  it('a commit with no data rows is a 400 and writes nothing', async () => {
    const res = await postTariffImport(post({ kind: 'rates', csv: `${RATE_HEADER}\n`, commit: true }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'The file has no rows to import' })
    nothingWritten()
  })

  it('maps a commit-time exclusion violation to 409', async () => {
    vi.mocked(commitRateImport).mockRejectedValue(pgErr('23P01', 'tariff_rates_no_overlap'))
    const res = await postTariffImport(post({ kind: 'rates', csv: goodRates, commit: true }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(conflict)
  })

  it.each([
    ['unique', '23505', 'service_catalog_code_unique'],
    ['foreign key', '23503', 'service_catalog_department_id_departments_id_fk'],
  ])('maps a commit-time %s violation to 409', async (_label, code, constraint) => {
    vi.mocked(commitServiceImport).mockRejectedValue(pgErr(code, constraint))
    const res = await postTariffImport(post({ kind: 'services', csv: goodServices, commit: true }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(conflict)
  })

  it('any other commit failure is a generic 500 that logs no row data', async () => {
    vi.mocked(commitRateImport).mockRejectedValue(pgErr('57P01'))
    const res = await postTariffImport(post({ kind: 'rates', csv: goodRates, commit: true }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Could not import the file; nothing was applied' })
    const logged = vi.mocked(console.error).mock.calls.flat().join(' ')
    expect(logged).not.toContain('pg detail')
    expect(logged).not.toContain('CONS-GEN')
  })

  it('a lookup failure is a generic 500', async () => {
    vi.mocked(getImportLookups).mockRejectedValue(pgErr('57P01'))
    const res = await postTariffImport(post({ kind: 'rates', csv: goodRates, commit: false }))
    expect(res.status).toBe(500)
    nothingWritten()
  })
})
