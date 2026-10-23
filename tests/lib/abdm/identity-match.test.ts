import { describe, it, expect } from 'vitest'
import { compareAbhaIdentity, normaliseIndianName, IDENTITY_MISMATCH_MESSAGE, type AbhaIdentityProfile } from '@/lib/abdm/identity-match'

// WS12 T5 (spec R9): the ABDM profile is compared with the chart before an ABHA is linked.

const profile = (over: Partial<AbhaIdentityProfile> = {}): AbhaIdentityProfile => ({
  name: 'Fathima Beevi', gender: 'F', yearOfBirth: 1979, monthOfBirth: null, dayOfBirth: null, ...over,
})
const chart = (over: Partial<{ name: string; dob: string | null; gender: string | null }> = {}) => ({
  name: 'Fathima Beevi', dob: '1979-05-02', gender: 'female', ...over,
})
const result = (c: ReturnType<typeof compareAbhaIdentity>, field: 'name' | 'dob' | 'gender') => c.fields.find((f) => f.field === field)!.result

describe('normaliseIndianName', () => {
  it('lower-cases, strips honorifics, punctuation and extra spaces', () => {
    expect(normaliseIndianName('Smt. FATHIMA  Beevi')).toEqual(['fathima', 'beevi'])
    expect(normaliseIndianName('Dr. R. Kumar')).toEqual(['r', 'kumar'])
    expect(normaliseIndianName('Shri Ravi-Kumar, Jr')).toEqual(['ravi', 'kumar', 'jr'])
    expect(normaliseIndianName('Baby of Kumari')).toEqual(['of'])
    expect(normaliseIndianName('  ')).toEqual([])
  })
})

describe('compareAbhaIdentity', () => {
  it('the message is fixed', () => {
    expect(IDENTITY_MISMATCH_MESSAGE).toBe('The ABHA profile does not match this patient. Check the details, or give a reason to link anyway.')
  })

  it('a full match: reordered tokens, honorifics and case do not matter', () => {
    const c = compareAbhaIdentity(chart({ name: 'BEEVI Fathima' }), profile({ name: 'Smt. Fathima Beevi' }))
    expect(c.mismatch).toBe(false); expect(c.mismatchedFields).toEqual([])
    expect(c.fields.map((f) => [f.field, f.result])).toEqual([['name', 'match'], ['dob', 'match'], ['gender', 'match']])
  })

  it('an initial matches a token starting with it when a full token also matches', () => {
    expect(result(compareAbhaIdentity(chart({ name: 'R. Kumar' }), profile({ name: 'Ravi Kumar' })), 'name')).toBe('match')
    expect(result(compareAbhaIdentity(chart({ name: 'Ravi Kumar' }), profile({ name: 'R Kumar' })), 'name')).toBe('match')
    // No full token in common: initials alone never match.
    expect(result(compareAbhaIdentity(chart({ name: 'R. K.' }), profile({ name: 'Ravi Kumar' })), 'name')).toBe('mismatch')
    // An extra unmatched token is a mismatch.
    expect(result(compareAbhaIdentity(chart({ name: 'Ravi Kumar Nair' }), profile({ name: 'Ravi Kumar' })), 'name')).toBe('mismatch')
    expect(result(compareAbhaIdentity(chart({ name: 'S. Kumar' }), profile({ name: 'Ravi Kumar' })), 'name')).toBe('mismatch')
  })

  it('a different person is a name mismatch', () => {
    const c = compareAbhaIdentity(chart(), profile({ name: 'Sandbox Mock Patient', gender: null, yearOfBirth: null }))
    expect(c.mismatch).toBe(true); expect(c.mismatchedFields).toEqual(['name'])
    expect(c.fields[0]).toEqual({ field: 'name', result: 'mismatch', chart: 'Fathima Beevi', abdm: 'Sandbox Mock Patient' })
  })

  it('gender F against a male chart is a mismatch; O matches other or transgender', () => {
    expect(result(compareAbhaIdentity(chart({ gender: 'male' }), profile({ gender: 'F' })), 'gender')).toBe('mismatch')
    expect(result(compareAbhaIdentity(chart({ gender: 'transgender' }), profile({ gender: 'O' })), 'gender')).toBe('match')
    expect(result(compareAbhaIdentity(chart({ gender: 'other' }), profile({ gender: 'O' })), 'gender')).toBe('match')
    expect(result(compareAbhaIdentity(chart({ gender: 'male' }), profile({ gender: 'M' })), 'gender')).toBe('match')
  })

  it('a field ABDM did not give, or a chart unknown/null, is unavailable', () => {
    const c = compareAbhaIdentity(chart({ gender: 'unknown' }), profile({ yearOfBirth: null, gender: 'F' }))
    expect(result(c, 'dob')).toBe('unavailable'); expect(result(c, 'gender')).toBe('unavailable')
    expect(c.mismatch).toBe(false)
    expect(result(compareAbhaIdentity(chart({ gender: null }), profile()), 'gender')).toBe('unavailable')
    expect(result(compareAbhaIdentity(chart({ dob: null }), profile()), 'dob')).toBe('unavailable')
    expect(result(compareAbhaIdentity(chart(), profile({ gender: null })), 'gender')).toBe('unavailable')
  })

  it('year 1980 against a 1979-05-02 chart is a dob mismatch; month and day are compared when given', () => {
    expect(result(compareAbhaIdentity(chart(), profile({ yearOfBirth: 1980 })), 'dob')).toBe('mismatch')
    expect(result(compareAbhaIdentity(chart(), profile({ yearOfBirth: 1979, monthOfBirth: 5, dayOfBirth: 2 })), 'dob')).toBe('match')
    expect(result(compareAbhaIdentity(chart(), profile({ yearOfBirth: 1979, monthOfBirth: 6 })), 'dob')).toBe('mismatch')
    expect(result(compareAbhaIdentity(chart(), profile({ yearOfBirth: 1979, monthOfBirth: 5, dayOfBirth: 3 })), 'dob')).toBe('mismatch')
    const c = compareAbhaIdentity(chart(), profile({ yearOfBirth: 1980 }))
    expect(c.fields[1]).toMatchObject({ chart: '1979-05-02', abdm: '1980' })
  })

  it('no stored profile counts as a name mismatch; the other fields are unavailable', () => {
    const c = compareAbhaIdentity(chart(), null)
    expect(c.fields.map((f) => [f.field, f.result])).toEqual([['name', 'mismatch'], ['dob', 'unavailable'], ['gender', 'unavailable']])
    expect(c.mismatchedFields).toEqual(['name']); expect(c.mismatch).toBe(true)
  })

  it('lists every mismatched field in order', () => {
    const c = compareAbhaIdentity(chart({ gender: 'male' }), profile({ name: 'Asha Rao', yearOfBirth: 1990 }))
    expect(c.mismatchedFields).toEqual(['name', 'dob', 'gender'])
  })
})
