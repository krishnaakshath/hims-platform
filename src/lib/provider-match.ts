// Strict name -> provider matching, the fallback used when a session has no
// real users -> staff_members -> providers link (see resolveDoctorQueueProvider
// in doctor-queue-provider.ts, which tries that link first). Pure and
// dependency-free so it can be unit tested without a DB.
//
// The previous approach -- `provider.name.toLowerCase().includes(lastWord)`
// resolved with `.find()` -- let "Dr. Ann Lee" resolve to "Dr. Bill Leeson"
// whenever Leeson sorted first, which then passed ownership checks on
// Leeson's appointments, admissions and video visits. This module matches
// only on EXACT surname equality (plus an agreeing given name when both sides
// have one: equal full names, or the same first letter when either side is an
// initial) and treats ambiguity as no match.
//
// Provider names (providers.name) must not contain credentials -- those live
// in providers.credentials. That is why only a short, unambiguous suffix list
// is stripped below and plausible surnames such as "Do" or "Pa" are not.

const TITLES = new Set(['dr', 'mr', 'ms', 'mrs', 'mx', 'prof'])
// Trailing credentials/suffixes that would otherwise be read as the surname
// ("Rajiv Kunam, MD").
const SUFFIXES = new Set(['md', 'phd', 'dnp', 'np', 'rn', 'jr', 'sr', 'ii', 'iii'])

interface ParsedName { surname: string; given: string | null }

/** Folds accents, lowercases, strips punctuation and titles, strips trailing
 *  suffix tokens only while at least two name tokens remain (so "Dr. Elton
 *  Np" keeps "np" as the surname), then takes the last token as the surname
 *  (it must be more than an initial) and the first preceding token, if any,
 *  as the given name (a single letter when it was written as an initial). */
function parseName(name: string): ParsedName | null {
  const tokens = name
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter((t) => t.length > 0 && !TITLES.has(t))
  while (tokens.length > 2 && SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop()
  const surname = tokens[tokens.length - 1]
  if (!surname || surname.length < 2) return null
  return { surname, given: tokens.length > 1 ? tokens[0] : null }
}

/** The comparable surname for a display name, or null when it has none. */
export function providerSurnameKey(name: string): string | null {
  return parseName(name)?.surname ?? null
}

/** Two full given names must be equal ("Ann" never matches "Alan"); when
 *  either side is only an initial, the first letters must agree. */
function givenNamesAgree(a: string, b: string): boolean {
  if (a.length > 1 && b.length > 1) return a === b
  return a[0] === b[0]
}

/** Returns the single provider whose surname EQUALS the session name's
 *  surname and, when both names have a given-name token before the surname,
 *  whose given name agrees too (see givenNamesAgree). Returns null when none or more than
 *  one provider qualifies (ambiguity is a denial, never pick-first) or the
 *  name has no usable surname. */
export function matchProviderByName<T extends { name: string }>(sessionName: string, providers: readonly T[]): T | null {
  const session = parseName(sessionName)
  if (!session) return null
  const matches = providers.filter((p) => {
    const candidate = parseName(p.name)
    if (!candidate || candidate.surname !== session.surname) return false
    if (session.given && candidate.given && !givenNamesAgree(session.given, candidate.given)) return false
    return true
  })
  return matches.length === 1 ? matches[0] : null
}
