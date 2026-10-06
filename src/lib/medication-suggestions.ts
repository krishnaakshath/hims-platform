import type { MedicationWithInventory } from '@/lib/queries/medications'

/**
 * A static clinical-reference table, NOT a machine-learning model and NOT a
 * substitute for clinical judgment -- it maps an ICD-10 code prefix to the
 * medication class(es) commonly used to treat that diagnosis, matching
 * standard psychiatric prescribing references. Every suggestion this
 * produces is a starting point for the prescriber to evaluate, never an
 * instruction. It only ever surfaces medications already in THIS practice's
 * own catalog (see suggestMedicationsForDiagnoses below) -- it never invents
 * a drug name that isn't already something staff added to medications.
 */
const DIAGNOSIS_TO_MEDICATION_CLASSES: { prefix: string; label: string; classes: string[] }[] = [
  { prefix: 'F32', label: 'Major depressive disorder, single episode', classes: ['SSRI', 'SNRI'] },
  { prefix: 'F33', label: 'Major depressive disorder, recurrent', classes: ['SSRI', 'SNRI'] },
  { prefix: 'F41.1', label: 'Generalized anxiety disorder', classes: ['SSRI', 'SNRI'] },
  { prefix: 'F41.0', label: 'Panic disorder', classes: ['SSRI', 'Benzodiazepine'] },
  { prefix: 'F90', label: 'ADHD', classes: ['Stimulant', 'Non-stimulant ADHD agent'] },
  { prefix: 'F20', label: 'Schizophrenia', classes: ['Atypical antipsychotic'] },
  { prefix: 'F31', label: 'Bipolar disorder', classes: ['Mood stabilizer', 'Atypical antipsychotic'] },
  { prefix: 'F43.1', label: 'PTSD', classes: ['SSRI', 'SNRI'] },
  { prefix: 'G47', label: 'Sleep disorder', classes: ['Sedative-hypnotic'] },
]

export interface MedicationSuggestion {
  medication: MedicationWithInventory
  diagnosisCode: string
  diagnosisLabel: string
}

/**
 * Cross-references the patient's diagnosis codes against the reference table
 * above, then filters to medications that actually exist in this practice's
 * catalog (and have stock -- `catalog` already comes from
 * listMedicationsWithInventory(), an inner join, so an out-of-catalog class
 * simply produces no suggestion rather than a fabricated one). Returns at
 * most one suggestion per matched medication, deduplicated.
 */
export function suggestMedicationsForDiagnoses(diagnosisCodes: string[], catalog: MedicationWithInventory[]): MedicationSuggestion[] {
  const seen = new Set<number>()
  const suggestions: MedicationSuggestion[] = []

  for (const code of diagnosisCodes) {
    const match = DIAGNOSIS_TO_MEDICATION_CLASSES.find((m) => code.toUpperCase().startsWith(m.prefix))
    if (!match) continue

    for (const med of catalog) {
      if (seen.has(med.id)) continue
      if (!match.classes.some((c) => med.medicationClass.toLowerCase() === c.toLowerCase())) continue
      seen.add(med.id)
      suggestions.push({ medication: med, diagnosisCode: code, diagnosisLabel: match.label })
    }
  }

  return suggestions
}
