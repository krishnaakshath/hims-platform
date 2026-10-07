import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateCodeSystemImport, CODE_CSV_HEADERS, WEB_IMPORT_LIMITS, MAX_REPORTED_ISSUES } from '@/lib/coding/import'

const META = { kind: 'icd10', version: 'TEST-1', name: 'Test', licenceNote: 'licence ref' } as const
const H = CODE_CSV_HEADERS.join(',')

describe('validateCodeSystemImport', () => {
  it('parses an Excel-style file (BOM, CRLF, quoted comma)', () => {
    const r = validateCodeSystemImport(`﻿${H}\r\nE11,"Diabetes, type 2",,no,yes,,,,,,\r\nE11.9,Without complications,E11,,,,,,,,\r\n\r\n`, META, WEB_IMPORT_LIMITS)
    expect(r.issues).toEqual([])
    expect(r.rows[0]).toMatchObject({ code: 'E11', display: 'Diabetes, type 2', selectable: false })
    expect(r.rows[1].parentCode).toBe('E11')
    expect(r.rows[1]).toMatchObject({ selectable: true, active: true, excludes: [] })
  })
  it('one bad row blocks the import with its line', () => {
    const r = validateCodeSystemImport(`${H}\nE11,Ok,,,,,,,,,\nBAD,Nope,,,,,,,,,\n`, META, WEB_IMPORT_LIMITS)
    expect(r.issues).toEqual([expect.objectContaining({ line: 3, column: 'code' })])
  })
  it('rejects formula-like displays, duplicates, bad parents and loops', () => {
    const r = validateCodeSystemImport(`${H}\nE11,=HYPERLINK(1),,,,,,,,,\nE11,dup,,,,,,,,,\nE12,x,E99,,,,,,,,\nE13,a,E14,,,,,,,,\nE14,b,E13,,,,,,,,\n`, META, WEB_IMPORT_LIMITS)
    expect(r.issues.map((i) => i.message)).toEqual(expect.arrayContaining(['Display may not start with = + - or @', 'Duplicate code', 'Parent chain loops']))
    expect(r.issues.some((i) => i.line === 4 && i.column === 'parent_code')).toBe(true)
  })
  it.each(['+1', '-1', '@x'])('rejects display starting %s', (d) => {
    expect(validateCodeSystemImport(`${H}\nE11,${d},,,,,,,,,\n`, META, WEB_IMPORT_LIMITS).issues[0].message).toBe('Display may not start with = + - or @')
  })
  it('requires a licence note unless the version is SAMPLE-', () => {
    expect(validateCodeSystemImport(`${H}\nE11,x,,,,,,,,,\n`, { ...META, licenceNote: null }, WEB_IMPORT_LIMITS).issues[0].message).toMatch(/licence/i)
  })
  it('a SAMPLE- version needs every display to start SAMPLE', () => {
    const r = validateCodeSystemImport(`${H}\nE11,SAMPLE ok,,,,,,,,,\nE12,Real looking,,,,,,,,,\n`, { ...META, version: 'SAMPLE-X', licenceNote: null }, WEB_IMPORT_LIMITS)
    expect(r.issues.map((i) => i.message)).toContain('Sample code sets must label every display SAMPLE')
    expect(r.isSample).toBe(true)
  })
  it('validates meta version and name', () => {
    expect(validateCodeSystemImport(`${H}\nE11,x,,,,,,,,,\n`, { ...META, version: '-x' }, WEB_IMPORT_LIMITS).issues.length).toBeGreaterThan(0)
    expect(validateCodeSystemImport(`${H}\nE11,x,,,,,,,,,\n`, { ...META, name: '' }, WEB_IMPORT_LIMITS).issues.length).toBeGreaterThan(0)
  })
  it('caps size and rows', () => {
    expect(validateCodeSystemImport('x'.repeat(11), META, { maxBytes: 10, maxRows: 5 }).issues[0].message).toMatch(/larger than 10 bytes/)
    const rows = ['E11', 'E12', 'E13'].map((c) => `${c},x,,,,,,,,,`).join('\n')
    expect(validateCodeSystemImport(`${H}\n${rows}\n`, META, { maxBytes: 10_000, maxRows: 2 }).issues).toEqual([expect.objectContaining({ message: 'File has more than 2 rows' })])
  })
  it('rejects bad header, empty file and syntax errors', () => {
    expect(validateCodeSystemImport('a,b\n', META, WEB_IMPORT_LIMITS).issues[0].line).toBe(1)
    expect(validateCodeSystemImport(`${H}\n`, META, WEB_IMPORT_LIMITS).issues[0].message).toBe('File has no codes')
    expect(validateCodeSystemImport(`${H}\nE11,"oops,,,,,,,,,\n`, META, WEB_IMPORT_LIMITS).issues[0].line).toBe(2)
  })
  it('parses flags, dates, sex, ages and excludes', () => {
    const r = validateCodeSystemImport(`${H}\nE11,x,,yes,no,2026-01-01,2026-12-31,F,0,17,e10; E12.1\n`, META, WEB_IMPORT_LIMITS)
    expect(r.issues).toEqual([])
    expect(r.rows[0]).toMatchObject({ selectable: true, active: false, effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', sexRestriction: 'female', ageMinYears: 0, ageMaxYears: 17, excludes: ['E10', 'E12.1'] })
  })
  it.each([
    ['E11,x,,maybe,,,,,,,', 'selectable'], ['E11,x,,,,2026-02-30,,,,,', 'effective_from'], ['E11,x,,,,2026-02-01,2026-01-01,,,,', 'effective_to'],
    ['E11,x,,,,,,q,,,', 'sex'], ['E11,x,,,,,,,200,,', 'age_min_years'], ['E11,x,,,,,,,10,5,', 'age_max_years'], ['E11,x,,,,,,,,,bad code!', 'excludes'],
    ['E11,x\u0001y,,,,,,,,,', 'display'], ['E11,,,,,,,,,,', 'display'], ['E11,x,E11,,,,,,,,', 'parent_code'],
  ])('flags %s on %s', (row, column) => {
    const r = validateCodeSystemImport(`${H}\n${row}\n`, META, WEB_IMPORT_LIMITS)
    expect(r.issues.some((i) => i.column === column && i.line === 2)).toBe(true)
  })
  it('caps excludes at 50', () => {
    const ex = Array.from({ length: 51 }, (_, i) => `A${i}`).join(';')
    expect(validateCodeSystemImport(`${H}\nE11,x,,,,,,,,,${ex}\n`, META, WEB_IMPORT_LIMITS).issues[0].column).toBe('excludes')
  })
  it('limits cell echo and reported issues', () => {
    const long = 'Z'.repeat(100)
    const r = validateCodeSystemImport(`${H}\n${long},x,,,,,,,,,\n`, META, WEB_IMPORT_LIMITS)
    expect(r.issues[0].message).not.toContain(long)
    const many = Array.from({ length: 300 }, (_, i) => `BAD${i},x,,,,,,,,,`).join('\n')
    const m = validateCodeSystemImport(`${H}\n${many}\n`, META, WEB_IMPORT_LIMITS)
    expect(m.issues).toHaveLength(MAX_REPORTED_ISSUES + 1)
    expect(m.issues.at(-1)).toEqual({ line: 1, message: 'More problems were found; fix these first' })
  })
  it.each([['SAMPLE-icd10.csv', 'icd10', 'SAMPLE-ICD10-0'], ['SAMPLE-icd10pcs.csv', 'icd10pcs', 'SAMPLE-PCS-0'], ['SAMPLE-hbp.csv', 'hbp', 'SAMPLE-HBP-0']] as const)(
    'fixture %s validates as a sample', (f, kind, version) => {
      const r = validateCodeSystemImport(readFileSync(join('scripts/code-systems/samples', f), 'utf8'), { kind, version, name: 'Sample', licenceNote: null }, WEB_IMPORT_LIMITS)
      expect(r.issues).toEqual([])
      expect(r.isSample).toBe(true)
      expect(r.rows.every((row) => row.display.startsWith('SAMPLE fictional') && /not a real code/i.test(row.display))).toBe(true)
    })
  it('sample icd10 fixture carries the specified shape', () => {
    const r = validateCodeSystemImport(readFileSync('scripts/code-systems/samples/SAMPLE-icd10.csv', 'utf8'), { kind: 'icd10', version: 'SAMPLE-ICD10-0', name: 's', licenceNote: null }, WEB_IMPORT_LIMITS)
    const by = Object.fromEntries(r.rows.map((x) => [x.code, x]))
    expect(r.rows.map((x) => x.code)).toEqual(['U8Z', 'U8Z.0', 'U8Z.1', 'U8Z.2', 'U8Z.3', 'U8Z.4', 'U9Z', 'U9Z.0'])
    expect(by['U8Z'].selectable).toBe(false); expect(by['U9Z'].selectable).toBe(false)
    expect(by['U8Z.0'].excludes).toEqual(['U8Z.1']); expect(by['U8Z.2'].sexRestriction).toBe('female')
    expect([by['U8Z.3'].ageMinYears, by['U8Z.3'].ageMaxYears]).toEqual([0, 17])
    expect(by['U8Z.4']).toMatchObject({ active: false, effectiveTo: '2025-12-31' }); expect(by['U9Z.0'].effectiveFrom).toBe('2026-01-01')
  })
})
