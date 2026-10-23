// Question model v2 for form templates (spec D9): the one definition the form
// builder, the patient intake renderer and the template routes share. Pure --
// no database, no request objects.
//
// Answers stay keyed by question id and language-neutral: a select answer is
// always the English option string, whatever language the patient read the
// form in. Translations only change what is shown, never what is stored.

import { z } from 'zod'
import { normalizePhone } from '@/lib/india/phone'

export const FORM_LANGS = ['en', 'hi', 'kn'] as const
export type FormLang = (typeof FORM_LANGS)[number]
type TranslatedLang = Exclude<FormLang, 'en'>

export const QUESTION_TYPES = [
  'text', 'textarea', 'date', 'select', 'checkbox',
  'number', 'phone', 'file', 'signature', 'section',
] as const
export type QuestionType = (typeof QUESTION_TYPES)[number]

export interface FormQuestion {
  id: string
  label: string
  type: QuestionType
  options?: string[]
  optionScores?: (number | null)[] // same length/order as options when present
  hipaaSensitive: boolean
  required: boolean // always false for a section
  autofillField?: 'name' | 'dob' | 'email' | 'phone' | null
  // Tags a question as self-reporting something checkable against the chart,
  // e.g. "Currently taking antidepressants?" against medicationEpisodes.
  compareToChart?: { type: 'medication_active'; medicationClass: string } | null
  min?: number // number questions only
  max?: number // number questions only
  visibleIf?: { questionId: string; equals: string } | null // must name an EARLIER question
  i18n?: Partial<Record<TranslatedLang, { label?: string; options?: string[] }>>
}

const translationSchema = z.object({
  label: z.string().optional(),
  options: z.array(z.string()).optional(),
}).strict()

const questionObjectSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  type: z.enum(QUESTION_TYPES),
  options: z.array(z.string()).optional(),
  optionScores: z.array(z.number().nullable()).optional(),
  hipaaSensitive: z.boolean(),
  // Optional at the schema level only so a section may omit it; a non-section
  // must state it (checked below) and the output always carries a boolean.
  required: z.boolean().optional(),
  autofillField: z.enum(['name', 'dob', 'email', 'phone']).nullable().optional(),
  compareToChart: z.object({ type: z.literal('medication_active'), medicationClass: z.string() }).strict().nullable().optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  visibleIf: z.object({ questionId: z.string().min(1), equals: z.string() }).strict().nullable().optional(),
  i18n: z.object({ hi: translationSchema.optional(), kn: translationSchema.optional() }).strict().optional(),
}).strict()

/** One question, strict. Cross-question rules (visibleIf order, unique ids) live in formQuestionsSchema. */
export const formQuestionSchema = questionObjectSchema
  .superRefine((q, ctx) => {
    if (q.type === 'section') {
      if (q.required === true) ctx.addIssue({ code: 'custom', message: 'A section cannot be required', path: ['required'] })
    } else if (q.required === undefined) {
      ctx.addIssue({ code: 'custom', message: 'required must be stated', path: ['required'] })
    }
    if (q.optionScores && q.optionScores.length !== (q.options ?? []).length) {
      ctx.addIssue({ code: 'custom', message: 'optionScores must have the same length as options', path: ['optionScores'] })
    }
    if (q.type !== 'number' && (q.min !== undefined || q.max !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'min/max apply to number questions only', path: ['min'] })
    }
    if (q.min !== undefined && q.max !== undefined && q.min > q.max) {
      ctx.addIssue({ code: 'custom', message: 'min must not exceed max', path: ['min'] })
    }
    for (const lang of ['hi', 'kn'] as const) {
      const opts = q.i18n?.[lang]?.options
      if (opts && opts.length !== (q.options ?? []).length) {
        ctx.addIssue({ code: 'custom', message: 'Translated options must match the English options one for one', path: ['i18n', lang, 'options'] })
      }
    }
  })
  .transform((q): FormQuestion => ({ ...q, required: q.required ?? false }))

/** A template's question list: each question valid, ids unique, visibleIf only on an earlier question. */
export const formQuestionsSchema = z.array(formQuestionSchema).superRefine((qs, ctx) => {
  const seen = new Set<string>()
  qs.forEach((q, i) => {
    if (seen.has(q.id)) ctx.addIssue({ code: 'custom', message: 'Duplicate question id', path: [i, 'id'] })
    if (q.visibleIf && !seen.has(q.visibleIf.questionId)) {
      ctx.addIssue({ code: 'custom', message: 'visibleIf must refer to an earlier question', path: [i, 'visibleIf', 'questionId'] })
    }
    seen.add(q.id)
  })
})

const scoringRuleSchema = z.object({
  questionIds: z.array(z.string()),
  bands: z.array(z.object({ min: z.number(), max: z.number(), label: z.string() })),
})

/** POST /api/form-templates body. The PUT body is this with every field optional plus isActive. */
export const formTemplateBodySchema = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  diagnosisTag: z.string().min(1),
  questions: formQuestionsSchema,
  scoringRule: scoringRuleSchema.nullable().optional(),
  folderId: z.number().int().positive().nullable().optional(),
  // English is always offered: it is the source every translation falls back to.
  languages: z.array(z.enum(FORM_LANGS))
    .refine((ls) => ls.includes('en') && new Set(ls).size === ls.length, { message: 'languages must include en, once each' })
    .optional(),
}).strict()

export const formTemplateUpdateSchema = formTemplateBodySchema.partial()
  .extend({ isActive: z.boolean().optional() })
  .strict()

/** Questions the patient currently sees, in order. A question whose trigger is hidden is hidden too. */
export function visibleQuestions(qs: FormQuestion[], answers: Record<string, string>): FormQuestion[] {
  const shown = new Set<string>()
  const out: FormQuestion[] = []
  for (const q of qs) {
    const cond = q.visibleIf
    if (cond && !(shown.has(cond.questionId) && answers[cond.questionId] === cond.equals)) continue
    shown.add(q.id)
    out.push(q)
  }
  return out
}

const NUMBER_RE = /^-?\d+(\.\d+)?$/
const FILE_RE = /^doc:[1-9]\d*$/

/**
 * Validates a submission against the questions the patient could see. Answers to
 * hidden questions, sections and unknown ids are dropped from `cleaned`; phone
 * answers are normalised (+91...), signature names trimmed. Error messages are
 * fixed strings -- never the answer itself.
 */
export function validateAnswers(
  qs: FormQuestion[],
  answers: Record<string, string>,
): { ok: true; cleaned: Record<string, string> } | { ok: false; errors: Record<string, string> } {
  const cleaned: Record<string, string> = {}
  const errors: Record<string, string> = {}
  for (const q of visibleQuestions(qs, answers)) {
    if (q.type === 'section') continue
    const raw = answers[q.id]
    const value = typeof raw === 'string' ? raw.trim() : ''
    const empty = value === '' || (q.type === 'checkbox' && value !== 'true')
    if (empty) {
      if (q.required) { errors[q.id] = 'This question is required'; continue }
      if (value !== '') cleaned[q.id] = value // an unticked checkbox keeps its 'false'
      continue
    }
    switch (q.type) {
      case 'number': {
        const n = Number(value)
        if (!NUMBER_RE.test(value) || !Number.isFinite(n)) { errors[q.id] = 'Enter a number'; continue }
        if ((q.min !== undefined && n < q.min) || (q.max !== undefined && n > q.max)) {
          errors[q.id] = `Enter a number${q.min !== undefined ? ` from ${q.min}` : ''}${q.max !== undefined ? ` up to ${q.max}` : ''}`
          continue
        }
        cleaned[q.id] = value
        break
      }
      case 'phone': {
        const phone = normalizePhone(value)
        if (!phone) { errors[q.id] = 'Enter a valid mobile number'; continue }
        cleaned[q.id] = phone
        break
      }
      case 'file':
        if (!FILE_RE.test(value)) { errors[q.id] = 'Upload the requested document'; continue }
        cleaned[q.id] = value
        break
      case 'select':
        if (q.options && q.options.length > 0 && !q.options.includes(value)) { errors[q.id] = 'Choose one of the listed options'; continue }
        cleaned[q.id] = value
        break
      default: // text, textarea, date, checkbox ('true'), signature (the typed name)
        cleaned[q.id] = value
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, cleaned }
}

const pick = (translated: string | undefined, english: string) =>
  translated !== undefined && translated.trim() !== '' ? translated : english

/** Display strings in `lang`, each falling back to English on its own when missing or blank. */
export function localiseQuestion(q: FormQuestion, lang: FormLang): { label: string; options?: string[] } {
  const t = lang === 'en' ? undefined : q.i18n?.[lang]
  const label = pick(t?.label, q.label)
  if (!q.options) return { label }
  return { label, options: q.options.map((opt, i) => pick(t?.options?.[i], opt)) }
}
