export interface FormQuestion {
  id: string
  label: string
  type: 'text' | 'textarea' | 'date' | 'select' | 'checkbox'
  compareToChart?: { type: 'medication_active'; medicationClass: string } | null
}

export interface DiscrepancyResult {
  questionId: string
  questionLabel: string
  patientAnswer: string
  chartFinding: string
}

/**
 * Dual verification: what the patient says on their own intake form vs.
 * what their actual chart shows. This is unrelated to the (now-removed)
 * Tebra-vs-IntakeQ demographic comparison the medical record page used to
 * show -- this checks self-report vs. chart for clinical content instead,
 * which nothing else in the app does. A "Yes" (select
 * questions) or any non-empty free-text answer (text questions) counts as
 * the patient claiming they're on that medication class; an empty/"No"
 * answer counts as claiming they're not.
 */
export function checkFormChartDiscrepancies(
  questions: FormQuestion[],
  answers: Record<string, string>,
  activeMedicationClasses: Set<string>
): DiscrepancyResult[] {
  const results: DiscrepancyResult[] = []

  for (const q of questions) {
    if (q.compareToChart?.type !== 'medication_active') continue
    const answer = (answers[q.id] ?? '').trim()
    const patientClaimsActive = q.type === 'select' ? answer.toLowerCase() === 'yes' : answer.length > 0
    const chartShowsActive = activeMedicationClasses.has(q.compareToChart.medicationClass)

    if (patientClaimsActive === chartShowsActive) continue // agree -- no discrepancy

    results.push({
      questionId: q.id,
      questionLabel: q.label,
      patientAnswer: answer || '(no answer)',
      chartFinding: chartShowsActive
        ? `Chart shows an active ${q.compareToChart.medicationClass} medication`
        : `No active ${q.compareToChart.medicationClass} medication on chart`,
    })
  }

  return results
}
