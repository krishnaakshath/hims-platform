import { describe, it, expect } from 'vitest'
import { selectRange, rangeText, flagAnalyteValue, worstFlag, ageInDays, type AnalyteDef, type AnalyteRange } from '@/lib/labs/analytes'
import { analyteDefinitionsSchema } from '@/lib/labs/validation'

// WS4 T8 (spec 3.3 items 17, 19, 20): pure range choice and automatic flagging.
const R = (r: Partial<AnalyteRange>): AnalyteRange => ({
  sex: 'any', ageMinDays: 0, ageMaxDays: null, normalLow: null, normalHigh: null, criticalLow: null, criticalHigh: null, displayText: null, ...r,
})
const ADULT = 18 * 365
const HB_FEMALE = R({ sex: 'female', ageMinDays: ADULT, normalLow: 12.0, normalHigh: 15.5, criticalLow: 7, criticalHigh: 20 })
const HB_MALE = R({ sex: 'male', ageMinDays: ADULT, normalLow: 13.5, normalHigh: 17.5, criticalLow: 7, criticalHigh: 20 })
const HB_ANY = R({ sex: 'any', ageMinDays: 0, normalLow: 11.0, normalHigh: 17.0, criticalLow: 7, criticalHigh: 20 })
const HB: AnalyteDef = {
  id: 1, code: 'HGB', name: 'Haemoglobin', unit: 'g/dL', valueType: 'numeric', decimals: 1, options: null, abnormalOptions: null, criticalOptions: null,
  ranges: [HB_ANY, HB_FEMALE, HB_MALE],
}
const NS1: AnalyteDef = {
  id: 2, code: 'NS1', name: 'Dengue NS1 antigen', unit: null, valueType: 'option', decimals: null,
  options: ['Negative', 'Positive'], abnormalOptions: ['Positive'], criticalOptions: null, ranges: [],
}

describe('selectRange', () => {
  it('a 30-year-old woman gets the female range over the any-sex range', () => {
    expect(selectRange(HB.ranges, 'female', 30 * 365)).toBe(HB_FEMALE)
    expect(selectRange(HB.ranges, 'male', 30 * 365)).toBe(HB_MALE)
  })

  it('a neonate band (0-28 days) beats an all-ages any band for a 10-day-old', () => {
    const neonate = R({ ageMinDays: 0, ageMaxDays: 28, normalLow: 14, normalHigh: 24 })
    const allAges = R({ ageMinDays: 0, ageMaxDays: null, normalLow: 11, normalHigh: 17 })
    expect(selectRange([allAges, neonate], 'male', 10)).toBe(neonate)
    // The band is [min, max): day 28 is no longer a neonate.
    expect(selectRange([allAges, neonate], 'male', 28)).toBe(allAges)
  })

  it('a patient whose sex is not male/female gets only any-sex ranges', () => {
    expect(selectRange([HB_FEMALE, HB_MALE], null, 30 * 365)).toBeNull()
    expect(selectRange(HB.ranges, null, 30 * 365)).toBe(HB_ANY)
  })

  it('no range covers the age: null', () => {
    expect(selectRange([HB_FEMALE], 'female', 5 * 365)).toBeNull()
    expect(selectRange([], 'female', 100)).toBeNull()
  })
})

describe('flagAnalyteValue', () => {
  const female = selectRange(HB.ranges, 'female', 30 * 365)
  it('critical at or beyond the stored limit (spec: <= critical-low or >= critical-high)', () => {
    expect(flagAnalyteValue(HB, '6.5', female)).toEqual({ flag: 'critical', interpretation: 'LL' })
    expect(flagAnalyteValue(HB, '6.99', female)).toEqual({ flag: 'critical', interpretation: 'LL' })
    expect(flagAnalyteValue(HB, '7.0', female)).toEqual({ flag: 'critical', interpretation: 'LL' })
    expect(flagAnalyteValue(HB, '7.01', female)).toEqual({ flag: 'abnormal', interpretation: 'L' })
    expect(flagAnalyteValue(HB, '13.0', female)).toEqual({ flag: 'normal', interpretation: 'N' })
    expect(flagAnalyteValue(HB, '15.5', female)).toEqual({ flag: 'normal', interpretation: 'N' })
    expect(flagAnalyteValue(HB, '16', female)).toEqual({ flag: 'abnormal', interpretation: 'H' })
    expect(flagAnalyteValue(HB, '19.99', female)).toEqual({ flag: 'abnormal', interpretation: 'H' })
    expect(flagAnalyteValue(HB, '20', female)).toEqual({ flag: 'critical', interpretation: 'HH' })
    expect(flagAnalyteValue(HB, '21', female)).toEqual({ flag: 'critical', interpretation: 'HH' })
  })

  it('comparator, unparseable, text and range-less values get no automatic flag', () => {
    expect(flagAnalyteValue(HB, '<0.1', female)).toBeNull()
    expect(flagAnalyteValue(HB, '>1000', female)).toBeNull()
    expect(flagAnalyteValue(HB, 'haemolysed', female)).toBeNull()
    expect(flagAnalyteValue(HB, '', female)).toBeNull()
    expect(flagAnalyteValue(HB, '13', null)).toBeNull()
    expect(flagAnalyteValue({ ...HB, valueType: 'text' }, '13', female)).toBeNull()
  })

  it('option values flag from the abnormal and critical option lists', () => {
    expect(flagAnalyteValue(NS1, 'Positive', null)).toEqual({ flag: 'abnormal', interpretation: 'A' })
    expect(flagAnalyteValue(NS1, 'Negative', null)).toEqual({ flag: 'normal', interpretation: 'N' })
    expect(flagAnalyteValue({ ...NS1, criticalOptions: ['Positive'] }, 'Positive', null)).toEqual({ flag: 'critical', interpretation: 'AA' })
    expect(flagAnalyteValue(NS1, 'Equivocal', null)).toBeNull()
  })

  it('a range with only a high bound flags only high values', () => {
    const chol = R({ normalHigh: 200 })
    const def: AnalyteDef = { ...HB, ranges: [chol] }
    expect(flagAnalyteValue(def, '150', chol)).toEqual({ flag: 'normal', interpretation: 'N' })
    expect(flagAnalyteValue(def, '240', chol)).toEqual({ flag: 'abnormal', interpretation: 'H' })
  })
})

describe('worstFlag, rangeText, ageInDays', () => {
  it('worstFlag picks the most severe', () => {
    expect(worstFlag(['normal', 'critical', 'abnormal'])).toBe('critical')
    expect(worstFlag(['normal', 'abnormal'])).toBe('abnormal')
    expect(worstFlag([])).toBe('normal')
  })

  it('rangeText formats both bounds alike, one-sided bounds and display text', () => {
    expect(rangeText(HB_FEMALE, 'g/dL')).toBe('12.0-15.5 g/dL')
    expect(rangeText(R({ normalHigh: 200 }), null)).toBe('<200')
    expect(rangeText(R({ normalLow: 40 }), null)).toBe('≥40')
    expect(rangeText(R({ normalLow: 40 }), 'mg/dL')).toBe('≥40 mg/dL')
    expect(rangeText(R({ displayText: 'Negative' }), null)).toBe('Negative')
    expect(rangeText(R({}), 'g/dL')).toBeNull()
    expect(rangeText(null, 'g/dL')).toBeNull()
  })

  it('ageInDays counts calendar days', () => {
    expect(ageInDays('2026-10-13', '2026-10-23')).toBe(10)
    expect(ageInDays('1996-10-23', '2026-10-23')).toBe(10957)
    expect(ageInDays('2026-10-23', '2026-10-23T10:00:00+05:30')).toBe(0)
    expect(ageInDays('2026-10-24', '2026-10-23')).toBe(0)
  })
})

describe('analyteDefinitionsSchema', () => {
  const hgb = {
    code: 'HGB', name: 'Haemoglobin', unit: 'g/dL', valueType: 'numeric', decimals: 1, loincCode: '718-7',
    options: null, abnormalOptions: null, criticalOptions: null,
    ranges: [{ sex: 'female', ageMinDays: 6570, ageMaxDays: null, normalLow: 12, normalHigh: 15.5, criticalLow: 7, criticalHigh: 20, displayText: null }],
  }
  it('accepts a valid definition', () => {
    expect(analyteDefinitionsSchema.safeParse([hgb]).success).toBe(true)
  })
  it('refuses unordered bounds, a bad age band, duplicate codes, a bad code and unknown keys', () => {
    const bad = (ranges: object) => ({ ...hgb, ranges: [{ ...hgb.ranges[0], ...ranges }] })
    expect(analyteDefinitionsSchema.safeParse([bad({ normalLow: 16 })]).success).toBe(false)
    expect(analyteDefinitionsSchema.safeParse([bad({ criticalLow: 13 })]).success).toBe(false)
    expect(analyteDefinitionsSchema.safeParse([bad({ criticalHigh: 15 })]).success).toBe(false)
    expect(analyteDefinitionsSchema.safeParse([bad({ ageMaxDays: 6570 })]).success).toBe(false)
    expect(analyteDefinitionsSchema.safeParse([hgb, hgb]).success).toBe(false)
    expect(analyteDefinitionsSchema.safeParse([{ ...hgb, code: 'hgb' }]).success).toBe(false)
    expect(analyteDefinitionsSchema.safeParse([{ ...hgb, extra: 1 }]).success).toBe(false)
    expect(analyteDefinitionsSchema.safeParse(Array.from({ length: 41 }, (_, i) => ({ ...hgb, code: `A${i}` }))).success).toBe(false)
  })
  it('an option analyte needs its options, and flagged options must be among them', () => {
    const opt = { ...hgb, code: 'NS1', valueType: 'option', unit: null, decimals: null, ranges: [], options: ['Negative', 'Positive'], abnormalOptions: ['Positive'] }
    expect(analyteDefinitionsSchema.safeParse([opt]).success).toBe(true)
    expect(analyteDefinitionsSchema.safeParse([{ ...opt, options: null }]).success).toBe(false)
    expect(analyteDefinitionsSchema.safeParse([{ ...opt, abnormalOptions: ['Reactive'] }]).success).toBe(false)
  })
})
