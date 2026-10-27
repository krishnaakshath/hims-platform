'use client'
import type { FormQuestion } from '@/lib/forms/question-model'

type Condition = { questionId: string; equals: string }

const CHECKBOX_ANSWERS = [{ value: 'true', label: 'Ticked' }, { value: 'false', label: 'Not ticked' }]

/** Builder numbering: sections are headings, not questions, so they take no number. */
export function questionNumbers(questions: FormQuestion[]): Map<string, number> {
  const numbers = new Map<string, number>()
  let n = 0
  for (const q of questions) if (q.type !== 'section') numbers.set(q.id, ++n)
  return numbers
}

/** Answers a trigger can be matched against: its English options, or Ticked / Not ticked. */
function answersFor(trigger: FormQuestion): { value: string; label: string }[] {
  if (trigger.type === 'checkbox') return CHECKBOX_ANSWERS
  return (trigger.options ?? []).map((o) => o.trim()).filter(Boolean).map((o) => ({ value: o, label: o }))
}

/**
 * Questions that may control the one at `index`: EARLIER select (with at least
 * one option) or checkbox questions. Never a section, never a later question.
 */
export function conditionTriggers(questions: FormQuestion[], index: number): FormQuestion[] {
  return questions.slice(0, index).filter((q) => q.type === 'checkbox' || (q.type === 'select' && answersFor(q).length > 0))
}

/** "Show only if…" for one question. Emits the visibleIf to store, or null to remove it. */
export function QuestionConditionEditor({ questions, index, value, onChange }: {
  questions: FormQuestion[]
  index: number
  value?: Condition | null
  onChange: (next: Condition | null) => void
}) {
  const triggers = conditionTriggers(questions, index)
  const numbers = questionNumbers(questions)

  if (!value) {
    if (triggers.length === 0) return null
    return (
      <button
        type="button"
        onClick={() => onChange({ questionId: triggers[0].id, equals: answersFor(triggers[0])[0].value })}
        className="text-xs font-medium text-primary hover:underline"
      >
        Show only if…
      </button>
    )
  }

  const trigger = triggers.find((t) => t.id === value.questionId)
  const answers = trigger ? answersFor(trigger) : []
  const select = 'rounded-md border border-border px-2 py-1 text-xs text-foreground focus:border-primary/40 focus:outline-none'

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <span>Show only if</span>
      <select
        aria-label="Show only if question"
        value={value.questionId}
        onChange={(e) => {
          const next = triggers.find((t) => t.id === e.target.value)
          if (next) onChange({ questionId: next.id, equals: answersFor(next)[0].value })
        }}
        className={select}
      >
        {!trigger && <option value={value.questionId}>Choose a question</option>}
        {triggers.map((t) => <option key={t.id} value={t.id}>{`Q${numbers.get(t.id)}. ${t.label}`}</option>)}
      </select>
      <span>is</span>
      <select
        aria-label="Show only if answer"
        value={value.equals}
        onChange={(e) => onChange({ questionId: value.questionId, equals: e.target.value })}
        className={select}
      >
        {!answers.some((a) => a.value === value.equals) && <option value={value.equals}>Choose an answer</option>}
        {answers.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
      </select>
      <button type="button" onClick={() => onChange(null)} className="font-medium text-destructive hover:underline">Remove condition</button>
    </div>
  )
}
