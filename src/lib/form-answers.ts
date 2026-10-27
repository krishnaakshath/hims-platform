// Shared formatting for how a patient's raw stored answer (formSubmissions
// .answers, a Record<string, string>) should read on staff-facing screens --
// used by the Client Forms submission detail view. Keeps the "how do we
// display a choice-type answer" rule in one place rather than duplicated
// across pages.

import type { QuestionType } from '@/lib/forms/question-model'

export interface AnswerQuestion {
  id: string
  label: string
  type: QuestionType
  options?: string[]
}

const UNANSWERED = '—' // em dash, matches the existing "—" placeholder used elsewhere in the app

export function formatAnswerDisplay(question: AnswerQuestion, rawValue: string | undefined): string {
  if (question.type === 'checkbox') {
    if (rawValue === undefined) return UNANSWERED
    return rawValue === 'true' ? 'Yes' : 'No'
  }

  // A section is a heading, never answered.
  if (question.type === 'section') return UNANSWERED

  if (rawValue === undefined || rawValue === '') return UNANSWERED

  // A file answer is a `doc:<id>` reference -- never surface the raw id or any
  // storage path; the document itself is reached from the patient's chart.
  if (question.type === 'file') return 'Document uploaded'

  // A signature answer is the patient's typed full name.
  if (question.type === 'signature') return `Signed as ${rawValue}`

  if (question.type === 'select') {
    // The intake form stores the selected option's own text as the answer,
    // so the raw value already *is* the selected option -- just surface it
    // plainly rather than a bare unlabeled string. If the template's option
    // list has since changed and no longer contains this value, still show
    // what the patient actually picked rather than hiding it.
    return rawValue
  }

  return rawValue
}
