// WS1 T6: the pure allergy matcher (spec ruling 9).
import { describe, it, expect } from 'vitest'
import { allergyConflicts, type AllergyInput, type DrugIdentity } from '@/lib/prescriptions/allergy-check'

const drug = (name: string, genericName: string | null = null, medicationClass: string | null = null): DrugIdentity => ({ name, genericName, medicationClass })
const allergy = (allergen: string, severity: AllergyInput['severity'] = 'severe'): AllergyInput => ({ allergen, severity })

describe('allergyConflicts', () => {
  it('Penicillin allergy vs Amoxicillin is a cross-reactivity conflict', () => {
    expect(allergyConflicts(drug('Mox 500', 'Amoxicillin', 'Antibiotic'), [allergy('Penicillin')])).toEqual([
      { allergen: 'Penicillin', severity: 'severe', matchedOn: 'cross_reactivity' },
    ])
  })

  it('Penicillin allergy vs the seeded "Amoxicillin + Clavulanic acid 625 mg" (no generic) is a conflict', () => {
    expect(allergyConflicts(drug('Amoxicillin + Clavulanic acid 625 mg', null, 'Antibiotic'), [allergy('Penicillin')])).toHaveLength(1)
  })

  it.each(['Ampicillin', 'Cloxacillin', 'Piperacillin'])('Penicillin allergy vs %s cross-reacts', (g) => {
    expect(allergyConflicts(drug('Brand', g, null), [allergy('penicillin')])[0]?.matchedOn).toBe('cross_reactivity')
  })

  it('Sulfa allergy vs Co-trimoxazole (generic sulfamethoxazole) is a conflict', () => {
    const r = allergyConflicts(drug('Co-trimoxazole DS', 'Sulfamethoxazole + Trimethoprim', 'Antibiotic'), [allergy('Sulfa', 'moderate')])
    expect(r).toEqual([{ allergen: 'Sulfa', severity: 'moderate', matchedOn: 'cross_reactivity' }])
  })

  it('Sulfa allergy vs sulfasalazine cross-reacts', () => {
    expect(allergyConflicts(drug('Saaz', 'Sulfasalazine', null), [allergy('Sulfa drugs')])).toHaveLength(1)
  })

  it('NSAID allergy vs ibuprofen / diclofenac / naproxen / aspirin / ketorolac cross-reacts', () => {
    for (const g of ['Ibuprofen', 'Diclofenac sodium', 'Naproxen', 'Aspirin', 'Ketorolac']) {
      expect(allergyConflicts(drug('Brand', g, null), [allergy('NSAIDs', 'mild')]), g).toEqual([{ allergen: 'NSAIDs', severity: 'mild', matchedOn: 'cross_reactivity' }])
    }
  })

  it('Cephalosporin allergy vs any cef* drug cross-reacts', () => {
    expect(allergyConflicts(drug('Taxim-O', 'Cefixime', null), [allergy('Cephalosporin')])).toHaveLength(1)
    expect(allergyConflicts(drug('Ceftriaxone 1 g', null, null), [allergy('cephalosporins')])).toHaveLength(1)
  })

  it('Peanut allergy vs Paracetamol is no conflict', () => {
    expect(allergyConflicts(drug('Paracetamol 650 mg', 'Paracetamol', 'Analgesic'), [allergy('Peanut')])).toEqual([])
  })

  it('matches the allergen against the name, case-insensitively, as a whole token', () => {
    expect(allergyConflicts(drug('ASPIRIN 75 mg', null, null), [allergy('aspirin')])).toEqual([{ allergen: 'aspirin', severity: 'severe', matchedOn: 'name' }])
  })

  it('matches the generic name and the class, in that order after the name', () => {
    expect(allergyConflicts(drug('Crocin', 'Paracetamol', 'Analgesic'), [allergy('Paracetamol')])[0].matchedOn).toBe('generic')
    expect(allergyConflicts(drug('Brand X', null, 'Macrolide'), [allergy('macrolide')])[0].matchedOn).toBe('class')
  })

  it('a partial word is not a whole-token match', () => {
    expect(allergyConflicts(drug('Metformin 500 mg', 'Metformin', 'Biguanide'), [allergy('Met')])).toEqual([])
    expect(allergyConflicts(drug('Codeine', null, null), [allergy('Code')])).toEqual([])
  })

  it('a multi-word allergen matches as consecutive tokens', () => {
    expect(allergyConflicts(drug('Clavulanic acid', null, null), [allergy('clavulanic acid')])).toHaveLength(1)
  })

  // Fix round 1: an extra word in the allergen must not defeat the match.
  it('"Diclofenac sodium" allergy vs a drug with generic "Diclofenac" is a conflict', () => {
    expect(allergyConflicts(drug('Voveran 50', 'Diclofenac', 'NSAID'), [allergy('Diclofenac sodium')])).toEqual([
      { allergen: 'Diclofenac sodium', severity: 'severe', matchedOn: 'generic' },
    ])
  })

  it('"Penicillin allergy" vs Penicillin V is a conflict', () => {
    expect(allergyConflicts(drug('Penicillin V 250 mg', null, null), [allergy('Penicillin allergy')])).toEqual([
      { allergen: 'Penicillin allergy', severity: 'severe', matchedOn: 'name' },
    ])
  })

  it('"Amoxicillin (rash)" and "Aspirin tablets" match their drugs', () => {
    expect(allergyConflicts(drug('Mox 500', 'Amoxicillin', null), [allergy('Amoxicillin (rash)')])[0]?.matchedOn).toBe('generic')
    expect(allergyConflicts(drug('Ecosprin 75', 'Aspirin', null), [allergy('Aspirin tablets')])[0]?.matchedOn).toBe('generic')
  })

  it('stopwords and short words alone never match (sodium, acid, tablets, allergy)', () => {
    expect(allergyConflicts(drug('Valproate sodium', 'Sodium valproate', null), [allergy('Diclofenac sodium')])).toEqual([])
    expect(allergyConflicts(drug('Folic acid 5 mg', 'Folic acid', null), [allergy('Clavulanic acid')])).toEqual([])
    expect(allergyConflicts(drug('Dolo tablets', 'Paracetamol', null), [allergy('Aspirin tablets')])).toEqual([])
    expect(allergyConflicts(drug('Drug allergy kit', null, null), [allergy('Sulfa allergy')])).toEqual([])
  })

  it.each(['Phenoxymethylpenicillin', 'Benzylpenicillin', 'Flucloxacillin'])('Penicillin allergy vs %s cross-reacts (*cillin)', (g) => {
    expect(allergyConflicts(drug('Brand', g, null), [allergy('Penicillin')])[0]?.matchedOn).toBe('cross_reactivity')
  })

  it('reports one conflict per matching allergy and none for an empty allergen', () => {
    const r = allergyConflicts(drug('Amoxicillin 500', 'Amoxicillin', 'Penicillin'), [allergy('Penicillin'), allergy('Amoxicillin', 'mild'), allergy('  '), allergy('Latex')])
    expect(r).toEqual([
      { allergen: 'Penicillin', severity: 'severe', matchedOn: 'class' },
      { allergen: 'Amoxicillin', severity: 'mild', matchedOn: 'name' },
    ])
  })

  it('no allergies, no conflicts', () => {
    expect(allergyConflicts(drug('Amoxicillin', null, null), [])).toEqual([])
  })
})
