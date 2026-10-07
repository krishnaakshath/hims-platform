import { describe, it, expect } from 'vitest'
import { validateServiceImport, validateRateImport, MAX_IMPORT_ROWS, MAX_IMPORT_BYTES, SERVICE_CSV_HEADERS, RATE_CSV_HEADERS, type ImportLookups } from '@/lib/tariff/import'

const lookups = (): ImportLookups => ({
  departmentsByCode: new Map([['GEN_MED', 1], ['SURG', 2]]),
  payersByCode: new Map([['STAR', 7]]),
  roomCategoriesByCode: new Map([['ICU', 3]]),
  servicesByCode: new Map([['OPD', { id: 10, category: 'consultation' as const }], ['DRS', { id: 11, category: 'consumable' as const }]]),
  existingRates: [],
})
const SH = SERVICE_CSV_HEADERS.join(',')
const RH = RATE_CSV_HEADERS.join(',')

describe('validateServiceImport', () => {
  it('accepts a valid service file and marks existing codes as updates', () => {
    const r = validateServiceImport(`${SH}\nopd,OPD consult,gen_med,consultation,999312,0,yes\nNEWSVC,New,SURG,procedure,999316,18%,0\n`, lookups())
    expect(r.issues).toEqual([])
    expect(r.rows).toEqual([
      { code: 'OPD', name: 'OPD consult', departmentId: 1, category: 'consultation', hsnSac: '999312', gstRateBp: 0, isActive: true, existingId: 10 },
      { code: 'NEWSVC', name: 'New', departmentId: 2, category: 'procedure', hsnSac: '999316', gstRateBp: 1800, isActive: false, existingId: null },
    ])
  })
  it('one bad row blocks commit with its line number', () => {
    const r = validateServiceImport(`${SH}\nOPD,OPD consult,GEN_MED,consultation,999312,0,yes\nBAD,X,NOPE,consultation,999312,0,yes\n`, lookups())
    expect(r.issues).toEqual([{ line: 3, column: 'department_code', message: 'Unknown department code NOPE' }])
  })
  it('rejects a wrong header with a single line-1 issue', () => {
    const r = validateServiceImport('code,name\nA,B\n', lookups())
    expect(r.issues).toHaveLength(1); expect(r.issues[0].line).toBe(1); expect(r.rows).toEqual([])
    expect(validateServiceImport(` CODE , Name,department_code,category,hsn_sac,gst_rate_percent,ACTIVE\n`, lookups()).issues).toEqual([])
  })
  it('flags duplicate codes, bad gst, bad active, bad hsn and wrong column counts', () => {
    const r = validateServiceImport(`${SH}\nA1,n,SURG,procedure,999316,18,yes\nA1,n,SURG,procedure,999316,18,yes\nA2,n,SURG,procedure,999316,10,yes\nA3,n,SURG,procedure,999316,18,maybe\nA4,n,SURG,procedure,3004,18,yes\nA5,n\nA6,n,SURG,nonsense,999316,18,yes\n`, lookups())
    expect(r.issues.map((i) => [i.line, i.column])).toEqual([
      [3, 'code'], [4, 'gst_rate_percent'], [5, 'active'], [6, 'hsn_sac'], [7, undefined], [8, 'category'],
    ])
    expect(r.rows).toHaveLength(1)
  })
  it('rejects files over MAX_IMPORT_ROWS and oversize text', () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `S${i + 10},n,SURG,procedure,999316,18,yes`).join('\n')
    const r = validateServiceImport(`${SH}\n${rows}\n`, lookups())
    expect(r.issues).toHaveLength(1); expect(r.rows).toEqual([])
    const big = validateServiceImport('x'.repeat(MAX_IMPORT_BYTES + 1), lookups())
    expect(big.issues).toHaveLength(1)
    expect(big.issues[0].message.length).toBeLessThan(200)
  })
  it('reports a CSV syntax error as one issue at its line without echoing the text', () => {
    const r = validateServiceImport(`${SH}\nA,"unterminated SECRETTEXT\n`, lookups())
    expect(r.issues).toHaveLength(1); expect(r.issues[0].line).toBe(2)
    expect(r.issues[0].message).not.toContain('SECRETTEXT')
  })
  it('truncates echoed unknown codes', () => {
    const r = validateServiceImport(`${SH}\nA,n,${'Z'.repeat(500)},procedure,999316,18,yes\n`, lookups())
    expect(r.issues[0].message.length).toBeLessThan(120)
  })
})

describe('validateRateImport', () => {
  it('converts amount_inr "1,250.50" to 125050 paise and gst "18%" to 1800', () => {
    const r = validateRateImport(`${RH}\nopd,base,,,,,"1,250.50",2026-10-01,\nOPD,payer,,star,icu,ICU,900,2026-10-01,2026-12-31\nOPD,department,surg,,,,10,2026-10-01,\n`, lookups())
    expect(r.issues).toEqual([])
    expect(r.rows[0]).toMatchObject({ serviceId: 10, scope: 'base', amountPaise: 125050, validFrom: '2026-10-01' })
    expect(r.rows[0].validTo).toBeUndefined()
    expect(r.rows[1]).toMatchObject({ scope: 'payer', payerId: 7, roomCategoryId: 3, ward: 'ICU', amountPaise: 90000, validTo: '2026-12-31' })
    expect(r.rows[2]).toMatchObject({ scope: 'department', departmentId: 2, amountPaise: 1000 })
  })
  it('flags unknown codes, bad amount, bad dates and scope key errors with columns', () => {
    const r = validateRateImport(`${RH}\nNOPE,base,,,,,10,2026-10-01,\nOPD,base,,,,,abc,2026-10-01,\nOPD,base,,,,,10,2026-02-30,\nOPD,payer,,,,,10,2026-10-01,\nOPD,payer,,GHOST,,,10,2026-10-01,\nOPD,weird,,,,,10,2026-10-01,\nOPD,base,,,NOROOM,,10,2026-10-01,\nOPD,base,SURG,,,,10,2026-10-01,\n`, lookups())
    expect(r.issues.map((i) => [i.line, i.column])).toEqual([
      [2, 'service_code'], [3, 'amount_inr'], [4, 'valid_from'], [5, 'scope'], [6, 'payer_code'], [7, 'scope'], [8, 'room_category_code'], [9, 'scope'],
    ])
    expect(r.rows).toEqual([])
  })
  it('flags a rate that overlaps an existing rate and one that overlaps an earlier row', () => {
    const l = lookups()
    l.existingRates = [{ id: 1, serviceId: 10, scope: 'base', departmentId: null, payerId: null, roomCategoryId: null, ward: null, validFrom: '2026-01-01', validTo: '2026-12-31' }]
    const r = validateRateImport(`${RH}\nOPD,base,,,,,10,2026-06-01,2026-06-30\nDRS,base,,,,,10,2026-06-01,2026-06-30\nDRS,base,,,,,20,2026-06-30,\nDRS,base,,,,,20,2026-07-01,\n`, l)
    expect(r.issues.map((i) => [i.line, i.column])).toEqual([[2, 'valid_from'], [4, 'valid_from']])
    expect(r.rows).toHaveLength(2)
  })
  it('ignores deactivated existing rates and treats ward case-insensitively', () => {
    const l = lookups()
    l.existingRates = [
      { id: 1, serviceId: 10, scope: 'base', departmentId: null, payerId: null, roomCategoryId: null, ward: null, validFrom: '2026-01-01', validTo: null, deactivated: true },
      { id: 2, serviceId: 11, scope: 'base', departmentId: null, payerId: null, roomCategoryId: null, ward: 'icu', validFrom: '2026-01-01', validTo: null },
    ]
    const r = validateRateImport(`${RH}\nOPD,base,,,,,10,2026-06-01,\nDRS,base,,,,Icu ,10,2026-06-01,\n`, l)
    expect(r.issues.map((i) => i.line)).toEqual([3])
    expect(r.rows).toHaveLength(1)
  })
  it('rejects a wrong header', () => {
    const r = validateRateImport(`${SH}\n`, lookups())
    expect(r.issues).toHaveLength(1); expect(r.issues[0].line).toBe(1)
  })
})

describe('validateRateImport performance', () => {
  // Overlap checks are grouped by rate dimensions, so a full 5,000-row file against 25,000 live
  // rates stays well under a request budget instead of 125M pairwise comparisons.
  const big = (existing: ImportLookups['existingRates'], services: Map<string, { id: number; category: 'procedure' }>, lines: string[]) => {
    const csv = `${RH}\n${lines.join('\n')}\n`
    const t0 = performance.now()
    const r = validateRateImport(csv, { ...lookups(), servicesByCode: services, existingRates: existing })
    return { r, ms: performance.now() - t0 }
  }

  it('5,000 rows x 25,000 existing rates spread over many services finishes quickly', () => {
    const services = new Map(Array.from({ length: 5000 }, (_, i) => [`S${i}`, { id: 1000 + i, category: 'procedure' as const }]))
    const existing = Array.from({ length: 25_000 }, (_, i) => ({
      serviceId: 1000 + (i % 5000), scope: 'base' as const, departmentId: null, payerId: null, roomCategoryId: null, ward: null,
      validFrom: `${2000 + Math.floor(i / 5000)}-01-01`, validTo: `${2000 + Math.floor(i / 5000)}-12-31`,
    }))
    const { r, ms } = big(existing, services, Array.from({ length: 5000 }, (_, i) => `S${i},base,,,,,500,2026-01-01,`))
    expect(r.issues).toEqual([])
    expect(r.rows).toHaveLength(5000)
    expect(ms).toBeLessThan(2000)
  })

  it('5,000 rows x 25,000 existing rates on ONE service (distinct wards) finishes quickly and still finds overlaps', () => {
    const services = new Map([['ONE', { id: 77, category: 'procedure' as const }]])
    const existing = Array.from({ length: 25_000 }, (_, i) => ({
      serviceId: 77, scope: 'base' as const, departmentId: null, payerId: null, roomCategoryId: null, ward: `ward ${i}`,
      validFrom: '2026-01-01', validTo: null,
    }))
    // Rows use wards 20,000..24,999 typed in a different case: every one overlaps an existing rate.
    const lines = Array.from({ length: 5000 }, (_, i) => `ONE,base,,,,WARD  ${20_000 + i},500,2026-06-01,`)
    const { r, ms } = big(existing, services, lines)
    expect(r.issues).toHaveLength(5000)
    expect(r.issues[0]).toEqual({ line: 2, column: 'valid_from', message: 'Overlaps an existing rate for the same service and scope' })
    expect(ms).toBeLessThan(2000)
  })
})
