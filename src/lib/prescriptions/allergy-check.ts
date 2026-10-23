// WS1 T6 (spec ruling 9): a pure matcher between one drug and a patient's active allergies.
// Case-insensitive whole-token match of the allergen against the drug's name, generic name and
// class, plus a small cross-reactivity table. It is a prompt for the prescriber, not a complete
// drug-allergy database: a conflict needs an override reason, an empty result proves nothing.

export interface DrugIdentity { name: string; genericName: string | null; medicationClass: string | null }
export interface AllergyInput { allergen: string; severity: 'mild' | 'moderate' | 'severe' }
export interface AllergyConflict {
  allergen: string
  severity: AllergyInput['severity']
  matchedOn: 'name' | 'generic' | 'class' | 'cross_reactivity'
}

// Allergen word (any alias) -> drugs that cross-react. A target ending in '*' is a prefix.
const CROSS_REACTIVITY: { aliases: string[]; drugs: string[] }[] = [
  { aliases: ['penicillin'], drugs: ['amoxicillin', 'ampicillin', 'cloxacillin', 'piperacillin'] },
  { aliases: ['sulfa', 'sulpha', 'sulfonamide', 'sulphonamide'], drugs: ['sulfamethoxazole', 'sulfasalazine'] },
  { aliases: ['nsaid'], drugs: ['ibuprofen', 'diclofenac', 'naproxen', 'aspirin', 'ketorolac'] },
  { aliases: ['cephalosporin'], drugs: ['cef*', 'ceph*'] },
]

/** Lower-case alphanumeric tokens; a trailing plural "s" is dropped from longer words so
 *  "Penicillins" / "NSAIDs" match "penicillin" / "nsaid" (applied to both sides alike). */
function tokens(text: string | null): string[] {
  if (!text) return []
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((t) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t))
}

/** True when `needle` occurs as consecutive whole tokens of `hay`. */
function containsSequence(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

const matchesDrugToken = (target: string, token: string) =>
  target.endsWith('*') ? token.startsWith(target.slice(0, -1)) : token === target

export function allergyConflicts(drug: DrugIdentity, allergies: AllergyInput[]): AllergyConflict[] {
  const name = tokens(drug.name)
  const generic = tokens(drug.genericName)
  const cls = tokens(drug.medicationClass)
  const drugWords = [...name, ...generic]

  const out: AllergyConflict[] = []
  for (const a of allergies) {
    const allergen = tokens(a.allergen)
    if (allergen.length === 0) continue
    let matchedOn: AllergyConflict['matchedOn'] | null = null
    if (containsSequence(name, allergen)) matchedOn = 'name'
    else if (containsSequence(generic, allergen)) matchedOn = 'generic'
    else if (containsSequence(cls, allergen)) matchedOn = 'class'
    else if (CROSS_REACTIVITY.some((row) =>
      row.aliases.some((alias) => allergen.includes(alias)) &&
      row.drugs.some((target) => drugWords.some((t) => matchesDrugToken(target, t))))) matchedOn = 'cross_reactivity'
    if (matchedOn) out.push({ allergen: a.allergen, severity: a.severity, matchedOn })
  }
  return out
}
