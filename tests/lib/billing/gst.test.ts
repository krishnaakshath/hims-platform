import { describe, expect, it } from 'vitest'
import { INDIAN_STATES } from '@/lib/india/reference'
import { GST_STATE_CODES, documentTitle, isValidGstin, lineTax, placeOfSupply, stateCodeOfGstin } from '@/lib/billing/gst'

describe('GST', () => {
  it('accepts a valid GSTIN and rejects a wrong check digit or state', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true); expect(isValidGstin('29AAGCB7383J1Z4')).toBe(true)
    expect(isValidGstin('27AAPFU0939F1ZW')).toBe(false); expect(isValidGstin('99AAPFU0939F1ZV')).toBe(false)
    expect(stateCodeOfGstin('29AAGCB7383J1Z4')).toBe('IN-KA')
  })
  it('rejects malformed GSTINs', () => {
    for (const g of ['', '27aapfu0939f1zv', '27AAPFU0939F1Z', '27AAPFU0939F1ZVV', '27AAPFU0939F0ZV', '27AAPFU0939F1XV']) expect(isValidGstin(g)).toBe(false)
    expect(stateCodeOfGstin('99AAPFU0939F1ZV')).toBeNull()
    expect(stateCodeOfGstin('x')).toBeNull()
  })
  it('maps every SP1 state to a GST code, uniquely', () => {
    for (const s of INDIAN_STATES) expect(GST_STATE_CODES[s.code]).toMatch(/^\d{2}$/)
    expect(new Set(Object.values(GST_STATE_CODES)).size).toBe(INDIAN_STATES.length)
    expect(GST_STATE_CODES['IN-KA']).toBe('29'); expect(GST_STATE_CODES['IN-CH']).toBe('04'); expect(GST_STATE_CODES['IN-WB']).toBe('19')
  })
  it('health services are supplied where performed', () => {
    expect(placeOfSupply({ mode: 'location_of_service', hospitalStateCode: 'IN-KA', recipientStateCode: 'IN-TN' })).toEqual({ stateCode: 'IN-KA', supplyType: 'intra' })
  })
  it('recipient_state mode goes inter-state for another state and falls back to the hospital', () => {
    expect(placeOfSupply({ mode: 'recipient_state', hospitalStateCode: 'IN-KA', recipientStateCode: 'IN-TN' })).toEqual({ stateCode: 'IN-TN', supplyType: 'inter' })
    expect(placeOfSupply({ mode: 'recipient_state', hospitalStateCode: 'IN-KA', recipientStateCode: null })).toEqual({ stateCode: 'IN-KA', supplyType: 'intra' })
    expect(placeOfSupply({ mode: 'recipient_state', hospitalStateCode: 'IN-KA', recipientStateCode: 'XX' })).toEqual({ stateCode: 'IN-KA', supplyType: 'intra' })
    expect(placeOfSupply({ mode: 'recipient_state', hospitalStateCode: 'IN-KA', recipientStateCode: 'IN-KA' })).toEqual({ stateCode: 'IN-KA', supplyType: 'intra' })
  })
  it('rounds each half per line, half-up', () => {
    // 105 paise at 5%: half-rate 250 bp → 2.625 → 3 each
    expect(lineTax(105, 500, 'intra')).toMatchObject({ cgstRateBp: 250, sgstRateBp: 250, igstRateBp: 0, cgstPaise: 3, sgstPaise: 3, igstPaise: 0, taxPaise: 6, totalPaise: 111 })
    expect(lineTax(105, 500, 'inter')).toMatchObject({ cgstRateBp: 0, sgstRateBp: 0, igstRateBp: 500, igstPaise: 5, taxPaise: 5, totalPaise: 110 })
    expect(lineTax(3_000_000_000, 1800, 'intra')).toMatchObject({ cgstPaise: 270_000_000, sgstPaise: 270_000_000, totalPaise: 3_540_000_000 })
  })
  it('rounds exact halves up', () => {
    // 10 paise at 5% intra: 10 × 250 / 10000 = 0.25 → 0 ; 50 paise: 1.25 → 1 ; 30 paise at 5% inter: 1.5 → 2
    expect(lineTax(10, 500, 'intra')).toMatchObject({ cgstPaise: 0, sgstPaise: 0 })
    expect(lineTax(50, 500, 'intra')).toMatchObject({ cgstPaise: 1, sgstPaise: 1 })
    expect(lineTax(30, 500, 'inter').igstPaise).toBe(2)
    expect(lineTax(10, 500, 'inter').igstPaise).toBe(1) // 0.5 → 1
  })
  it('zero rate is no tax', () => { expect(lineTax(12345, 0, 'intra')).toMatchObject({ taxPaise: 0, totalPaise: 12345 }) })
  it('refuses a rate outside the GST slabs', () => { expect(() => lineTax(100, 700, 'intra')).toThrow(RangeError) })
  it('refuses a negative or fractional taxable', () => {
    expect(() => lineTax(-1, 500, 'intra')).toThrow(RangeError); expect(() => lineTax(1.5, 500, 'intra')).toThrow(RangeError)
  })
  it('per-line rounding differs from per-invoice rounding, and per-line is the rule', () => {
    const lines = [lineTax(105, 500, 'intra'), lineTax(105, 500, 'intra')]
    expect(lines.reduce((s, l) => s + l.taxPaise, 0)).toBe(12)   // per-invoice would give round(210 × 5%) = 11
    expect(lineTax(210, 500, 'intra').taxPaise).toBe(10)         // 5.25 → 5 each; a single merged line is not the same as two
  })
  it('titles the document', () => {
    expect(documentTitle([0, 500], '29AAGCB7383J1Z4')).toBe('Tax Invoice'); expect(documentTitle([0], '29AAGCB7383J1Z4')).toBe('Bill of Supply'); expect(documentTitle([0], null)).toBe('Bill')
    expect(documentTitle([500], null)).toBe('Bill'); expect(documentTitle([], '29AAGCB7383J1Z4')).toBe('Bill of Supply')
  })
})
