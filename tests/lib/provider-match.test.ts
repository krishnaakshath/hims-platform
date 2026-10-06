import { describe, it, expect } from 'vitest'
import { matchProviderByName, providerSurnameKey } from '@/lib/provider-match'

const KUNAM = { id: 1, name: 'Dr. Rajiv Kunam' }
const LEESON = { id: 2, name: 'Dr. Bill Leeson' }
const LEE = { id: 3, name: 'Dr. Ann Lee' }
const OTHER_LEE = { id: 4, name: 'Dr. Paul Lee' }
const MULLER = { id: 5, name: 'Dr. Hanna Müller' }
const ALAN_LEE = { id: 6, name: 'Dr. Alan Lee' }

describe('providerSurnameKey', () => {
  it.each([
    ['Dr. Rajiv Kunam', 'kunam'],
    ['Dr Rajiv Kunam', 'kunam'],
    ['Prof. Ann Lee', 'lee'],
    ['Mrs. Ann Lee', 'lee'],
    ['  Ann   Lee  ', 'lee'],
    ['Dr. Hanna Müller', 'muller'],
    ['Dr. Rajiv Kunam, MD', 'kunam'],
    ["Dr. Sean O'Brien", 'obrien'],
  ])('%j -> %j', (name, key) => {
    expect(providerSurnameKey(name)).toBe(key)
  })

  it.each([
    ['Dr. Elton Np', 'np'],
    ['Kunam MD', 'md'],
    ['Dr. R. Kunam MD', 'kunam'],
    ['Ann Lee Jr.', 'lee'],
  ])('strips a trailing suffix only when two name tokens remain: %j -> %j', (name, key) => {
    expect(providerSurnameKey(name)).toBe(key)
  })

  it.each(['', '   ', 'Dr.', 'Dr. R.', 'R. J.', 'Mr Ms Mrs Prof'])('returns null for a name with no usable surname (%j)', (name) => {
    expect(providerSurnameKey(name)).toBeNull()
  })
})

describe('matchProviderByName', () => {
  it('matches an initials-only first name to the full provider name', () => {
    expect(matchProviderByName('Dr. R. Kunam', [KUNAM, LEESON])).toBe(KUNAM)
  })

  it('never matches by substring: "Dr. Ann Lee" does not match "Dr. Bill Leeson"', () => {
    expect(matchProviderByName('Dr. Ann Lee', [LEESON])).toBeNull()
  })

  it('picks the exact surname even when a longer superstring surname sorts first', () => {
    expect(matchProviderByName('Dr. Ann Lee', [LEESON, LEE])).toBe(LEE)
  })

  it('does not match a session surname that merely contains a provider surname', () => {
    expect(matchProviderByName('Dr. Bill Leeson', [LEE])).toBeNull()
  })

  it('returns null (a denial, never pick-first) when two providers share the surname and nothing tells them apart', () => {
    // No given name on the session side: surname-only, so both Lees match.
    expect(matchProviderByName('Dr. Lee', [LEE, OTHER_LEE])).toBeNull()
    // Same given initial on both candidates: still two matches.
    expect(matchProviderByName('Dr. A. Lee', [LEE, ALAN_LEE])).toBeNull()
  })

  // Fix wave M4: two FULL given names must be equal; an initial on either
  // side still matches by first letter.
  it('requires full given names to be equal when both sides have one', () => {
    expect(matchProviderByName('Dr. Ann Lee', [ALAN_LEE])).toBeNull()
    expect(matchProviderByName('Dr. Alan Lee', [LEE])).toBeNull()
    expect(matchProviderByName('Dr. Ann Lee', [ALAN_LEE, LEE])).toBe(LEE)
    expect(matchProviderByName('Dr. Alan Lee', [LEE, ALAN_LEE])).toBe(ALAN_LEE)
  })

  it('still matches an initial against a full given name by first letter', () => {
    expect(matchProviderByName('Dr. A. Lee', [ALAN_LEE])).toBe(ALAN_LEE)
    expect(matchProviderByName('Dr. Ann Lee', [{ id: 12, name: 'Dr. A Lee' }])).toEqual({ id: 12, name: 'Dr. A Lee' })
  })

  it('compares full given names case- and accent-insensitively', () => {
    expect(matchProviderByName('DR. ÉLENA BOSCH', [{ id: 9, name: 'Dr. Elena Bosch' }])).toEqual({ id: 9, name: 'Dr. Elena Bosch' })
  })

  // Fix round 1: when both names carry a given-name token before the
  // surname, their first letters must agree.
  it('rejects a surname match whose given-name initial disagrees', () => {
    expect(matchProviderByName('Dr. Ann Lee', [OTHER_LEE])).toBeNull()
    expect(matchProviderByName('Dr. Paul Lee', [LEE])).toBeNull()
    expect(matchProviderByName('Dr. P. Lee', [LEE])).toBeNull()
  })

  it('uses the given-name initial to pick the one agreeing provider', () => {
    expect(matchProviderByName('Dr. Ann Lee', [LEE, OTHER_LEE])).toBe(LEE)
    expect(matchProviderByName('Dr. P. Lee', [LEE, OTHER_LEE])).toBe(OTHER_LEE)
    expect(matchProviderByName('Dr. R. Kunam', [KUNAM])).toBe(KUNAM)
    expect(matchProviderByName('dr. élena bosch', [{ id: 9, name: 'Dr. Elena Bosch' }])).toEqual({ id: 9, name: 'Dr. Elena Bosch' })
  })

  it('falls back to surname-only (still unique) when either side has no given name', () => {
    expect(matchProviderByName('Dr. Kunam', [KUNAM, LEE])).toBe(KUNAM)
    expect(matchProviderByName('Dr. Paul Lee', [{ id: 8, name: 'Dr. Lee' }])).toEqual({ id: 8, name: 'Dr. Lee' })
  })

  it('does not strip a credential-looking surname when it would leave fewer than two tokens', () => {
    expect(matchProviderByName('Dr. Elton Np', [{ id: 10, name: 'Dr. Elton John' }])).toBeNull()
    expect(matchProviderByName('Dr. Elton Np', [{ id: 11, name: 'Dr. Elton Np' }])).toEqual({ id: 11, name: 'Dr. Elton Np' })
    expect(matchProviderByName('Dr. E. Np', [{ id: 11, name: 'Dr. Eve Np' }])).toEqual({ id: 11, name: 'Dr. Eve Np' })
  })

  it('returns null when no provider matches', () => {
    expect(matchProviderByName('Dr. Nobody Matchington', [KUNAM, LEE])).toBeNull()
  })

  it.each(['', '   ', 'Dr.', 'Dr. R.'])('returns null for an empty or surname-less name (%j)', (name) => {
    expect(matchProviderByName(name, [KUNAM, LEE])).toBeNull()
  })

  it('is case-insensitive and accent-insensitive', () => {
    expect(matchProviderByName('dr. hanna MULLER', [MULLER, KUNAM])).toBe(MULLER)
    expect(matchProviderByName('KUNAM', [KUNAM])).toBe(KUNAM)
  })

  it('returns null for an empty roster', () => {
    expect(matchProviderByName('Dr. R. Kunam', [])).toBeNull()
  })
})
