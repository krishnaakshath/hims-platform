import { describe, it, expect } from 'vitest'
import { parseCsv, CsvSyntaxError } from '@/lib/tariff/csv'

describe('parseCsv', () => {
  it('parses an Excel-style CSV', () => {
    const text = '﻿code,name,amount\r\nDRS-S,"Dressing, small","1,250.00"\r\n\r\nDRS-L,"Dressing ""large""",900\r\n'
    expect(parseCsv(text)).toEqual({ header: ['code', 'name', 'amount'], rows: [{ line: 2, cells: ['DRS-S', 'Dressing, small', '1,250.00'] }, { line: 4, cells: ['DRS-L', 'Dressing "large"', '900'] }] })
  })
  it('handles LF endings, no trailing newline and empty cells', () => {
    expect(parseCsv('a,b,c\n1,,3')).toEqual({ header: ['a', 'b', 'c'], rows: [{ line: 2, cells: ['1', '', '3'] }] })
    // A row of only separators is an Excel blank row (final-review ruling 9), not a record of empty cells.
    expect(parseCsv('a,b\n,\n')).toEqual({ header: ['a', 'b'], rows: [] })
  })
  it('keeps a newline inside quotes and reports the record start line', () => {
    const r = parseCsv('a,b\n1,"x\ny"\n2,z\n')
    expect(r.rows).toEqual([{ line: 2, cells: ['1', 'x\ny'] }, { line: 4, cells: ['2', 'z'] }])
  })
  it('throws CsvSyntaxError with the line of an unterminated quote', () => {
    let err: unknown
    try { parseCsv('a,b\n1,2\n3,"oops\n4,5\n') } catch (e) { err = e }
    expect(err).toBeInstanceOf(CsvSyntaxError)
    expect((err as CsvSyntaxError).line).toBe(3)
    expect((err as CsvSyntaxError).message).not.toContain('oops')
  })
  it('rejects text after a closing quote', () => {
    expect(() => parseCsv('a,b\n"x"y,2\n')).toThrow(CsvSyntaxError)
  })
  it('treats rows of only commas and whitespace (Excel blanks) as blank, but keeps a quoted empty row', () => {
    const r = parseCsv('a,b,c\r\n1,2,3\r\n,,\r\n , ,\t\r\n4,5,6\r\n,,\r\n,,\r\n')
    expect(r.rows).toEqual([{ line: 2, cells: ['1', '2', '3'] }, { line: 5, cells: ['4', '5', '6'] }])
    expect(parseCsv('a,b\n"",\n').rows).toEqual([{ line: 2, cells: ['', ''] }])
  })
  it('returns an empty header for empty input', () => {
    expect(parseCsv('')).toEqual({ header: [], rows: [] })
    expect(parseCsv('\r\n\r\n')).toEqual({ header: [], rows: [] })
  })
})
