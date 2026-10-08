import { describe, it, expect } from 'vitest'
import { paiseToRupeeString, toCsv } from '@/lib/rcm/csv'

describe('CSV', () => {
  it('quotes, escapes and neutralises formulas', () => {
    expect(toCsv([['a,b', 'say "hi"', null], ['=SUM(A1)', '-5', 3]])).toBe('"a,b","say ""hi""",\r\n\'=SUM(A1),\'-5,3\r\n')
    expect(toCsv([['@cmd', '+1', '\tx', 'line\nbreak']])).toBe('\'@cmd,\'+1,\'\tx,"line\nbreak"\r\n')
  })
  it('formats paise as rupees without floats', () => {
    expect(paiseToRupeeString(1234567)).toBe('12345.67'); expect(paiseToRupeeString(5)).toBe('0.05'); expect(paiseToRupeeString(900719925474099)).toBe('9007199254740.99')
  })
})
