import { describe, it, expect } from 'vitest'
import {
  formQuestionSchema,
  formQuestionsSchema,
  formTemplateBodySchema,
  visibleQuestions,
  validateAnswers,
  localiseQuestion,
  type FormQuestion,
} from '@/lib/forms/question-model'

const q = (over: Partial<FormQuestion> & Pick<FormQuestion, 'id' | 'type'>): FormQuestion => ({
  label: over.id, hipaaSensitive: false, required: false, ...over,
})

describe('formQuestionSchema / formQuestionsSchema', () => {
  it('parses an old five-type template with no new fields unchanged', () => {
    const old = [
      { id: 'a', label: 'Name', type: 'text', hipaaSensitive: false, required: true, autofillField: 'name' },
      { id: 'b', label: 'Notes', type: 'textarea', hipaaSensitive: true, required: false },
      { id: 'c', label: 'DOB', type: 'date', hipaaSensitive: false, required: true, autofillField: 'dob' },
      { id: 'd', label: 'Severity', type: 'select', options: ['Mild', 'Severe'], optionScores: [0, 3], hipaaSensitive: false, required: false },
      { id: 'e', label: 'On antidepressants?', type: 'checkbox', hipaaSensitive: true, required: false, compareToChart: { type: 'medication_active', medicationClass: 'ssri' } },
    ]
    const parsed = formQuestionsSchema.safeParse(old)
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual(old)
  })

  it('rejects an unknown type and unknown keys (strict)', () => {
    expect(formQuestionSchema.safeParse({ id: 'a', label: 'A', type: 'colour', hipaaSensitive: false, required: false }).success).toBe(false)
    expect(formQuestionSchema.safeParse({ id: 'a', label: 'A', type: 'text', hipaaSensitive: false, required: false, extra: 1 }).success).toBe(false)
  })

  it('accepts the new types', () => {
    for (const type of ['number', 'phone', 'file', 'signature'] as const) {
      expect(formQuestionSchema.safeParse({ id: 'a', label: 'A', type, hipaaSensitive: false, required: true }).success).toBe(true)
    }
    expect(formQuestionSchema.safeParse({ id: 'a', label: 'Weight (kg)', type: 'number', min: 1, max: 250, hipaaSensitive: false, required: true }).success).toBe(true)
  })

  it('a section carries no required flag (absent or false), and never required: true', () => {
    const ok = formQuestionSchema.safeParse({ id: 's', label: 'History', type: 'section', hipaaSensitive: false })
    expect(ok.success).toBe(true)
    expect(ok.data?.required).toBe(false)
    expect(formQuestionSchema.safeParse({ id: 's', label: 'History', type: 'section', hipaaSensitive: false, required: false }).success).toBe(true)
    expect(formQuestionSchema.safeParse({ id: 's', label: 'History', type: 'section', hipaaSensitive: false, required: true }).success).toBe(false)
  })

  it('a non-section question must state required', () => {
    expect(formQuestionSchema.safeParse({ id: 'a', label: 'A', type: 'text', hipaaSensitive: false }).success).toBe(false)
  })

  it('min/max only on number questions and min must not exceed max', () => {
    expect(formQuestionSchema.safeParse({ id: 'a', label: 'A', type: 'text', min: 1, hipaaSensitive: false, required: false }).success).toBe(false)
    expect(formQuestionSchema.safeParse({ id: 'a', label: 'A', type: 'number', min: 10, max: 5, hipaaSensitive: false, required: false }).success).toBe(false)
  })

  it('visibleIf pointing at a later question is invalid; an earlier one is valid', () => {
    const later = [
      q({ id: 'a', type: 'text', visibleIf: { questionId: 'b', equals: 'Yes' } }),
      q({ id: 'b', type: 'select', options: ['Yes', 'No'] }),
    ]
    expect(formQuestionsSchema.safeParse(later).success).toBe(false)
    const self = [q({ id: 'a', type: 'text', visibleIf: { questionId: 'a', equals: 'x' } })]
    expect(formQuestionsSchema.safeParse(self).success).toBe(false)
    const earlier = [later[1], { ...later[0] }]
    expect(formQuestionsSchema.safeParse(earlier).success).toBe(true)
  })

  it('rejects duplicate question ids', () => {
    expect(formQuestionsSchema.safeParse([q({ id: 'a', type: 'text' }), q({ id: 'a', type: 'date' })]).success).toBe(false)
  })

  it('i18n option lists must match the English option count', () => {
    const base = { id: 'a', label: 'Smoker?', type: 'select', options: ['Yes', 'No'], hipaaSensitive: false, required: false }
    expect(formQuestionSchema.safeParse({ ...base, i18n: { hi: { label: 'धूम्रपान?', options: ['हाँ', 'नहीं'] } } }).success).toBe(true)
    expect(formQuestionSchema.safeParse({ ...base, i18n: { kn: { options: ['ಹೌದು'] } } }).success).toBe(false)
    expect(formQuestionSchema.safeParse({ ...base, i18n: { ta: { label: 'x' } } }).success).toBe(false)
  })

  it('formTemplateBodySchema is strict and validates nested questions', () => {
    const body = { name: 'Intake', category: 'Trial Intake', diagnosisTag: 'general', questions: [q({ id: 'sig', type: 'signature', required: true })] }
    expect(formTemplateBodySchema.safeParse(body).success).toBe(true)
    expect(formTemplateBodySchema.safeParse({ ...body, bogus: true }).success).toBe(false)
    expect(formTemplateBodySchema.safeParse({ ...body, languages: ['en', 'kn'] }).success).toBe(true)
    expect(formTemplateBodySchema.safeParse({ ...body, languages: ['fr'] }).success).toBe(false)
  })
})

describe('visibleQuestions', () => {
  const qs = [
    q({ id: 'smoker', type: 'select', options: ['Yes', 'No'] }),
    q({ id: 'packs', type: 'number', required: true, visibleIf: { questionId: 'smoker', equals: 'Yes' } }),
    q({ id: 'quit', type: 'checkbox', visibleIf: { questionId: 'packs', equals: '0' } }),
  ]
  it('shows a conditional question only when its trigger answer matches', () => {
    expect(visibleQuestions(qs, {}).map((x) => x.id)).toEqual(['smoker'])
    expect(visibleQuestions(qs, { smoker: 'Yes' }).map((x) => x.id)).toEqual(['smoker', 'packs'])
  })
  it('hides a question whose trigger is itself hidden', () => {
    expect(visibleQuestions(qs, { smoker: 'No', packs: '0' }).map((x) => x.id)).toEqual(['smoker'])
  })
})

describe('validateAnswers', () => {
  it('a hidden required question does not fail and its answer is dropped from cleaned', () => {
    const qs = [
      q({ id: 'smoker', type: 'select', options: ['Yes', 'No'], required: true }),
      q({ id: 'packs', type: 'number', required: true, visibleIf: { questionId: 'smoker', equals: 'Yes' } }),
    ]
    const r = validateAnswers(qs, { smoker: 'No', packs: '20' })
    expect(r).toEqual({ ok: true, cleaned: { smoker: 'No' } })
  })

  it('a trigger answer with stray whitespace opens its required dependant (review round 1)', () => {
    const qs = [
      q({ id: 'smoker', type: 'select', options: ['Yes', 'No'], required: true }),
      q({ id: 'packs', type: 'number', required: true, visibleIf: { questionId: 'smoker', equals: 'Yes' } }),
    ]
    expect(visibleQuestions(qs, { smoker: 'Yes ' }).map((x) => x.id)).toEqual(['smoker', 'packs'])
    const missing = validateAnswers(qs, { smoker: 'Yes ' })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(Object.keys(missing.errors)).toEqual(['packs'])
    expect(validateAnswers(qs, { smoker: ' Yes', packs: '5' })).toEqual({ ok: true, cleaned: { smoker: 'Yes', packs: '5' } })
  })

  it('a phone trigger is matched on its normalised value (review round 1)', () => {
    const qs = [
      q({ id: 'mob', type: 'phone' }),
      q({ id: 'confirm', type: 'checkbox', required: true, visibleIf: { questionId: 'mob', equals: '+919845012345' } }),
    ]
    expect(visibleQuestions(qs, { mob: '98450 12345' }).map((x) => x.id)).toEqual(['mob', 'confirm'])
    expect(validateAnswers(qs, { mob: '98450 12345' }).ok).toBe(false)
  })

  it('drops section and unknown-key answers', () => {
    const qs = [q({ id: 's', type: 'section' }), q({ id: 'a', type: 'text' })]
    expect(validateAnswers(qs, { s: 'x', a: 'hello', zzz: '1' })).toEqual({ ok: true, cleaned: { a: 'hello' } })
  })

  it('reports a missing required answer', () => {
    const r = validateAnswers([q({ id: 'a', type: 'text', required: true })], { a: '  ' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.errors)).toEqual(['a'])
  })

  it('phone: "98450 12345" passes (normalised), "12345" fails', () => {
    const qs = [q({ id: 'p', type: 'phone' })]
    expect(validateAnswers(qs, { p: '98450 12345' })).toEqual({ ok: true, cleaned: { p: '+919845012345' } })
    expect(validateAnswers(qs, { p: '12345' }).ok).toBe(false)
  })

  it('number: 300 with max 250 fails; in-range passes; non-numeric fails', () => {
    const qs = [q({ id: 'w', type: 'number', min: 1, max: 250 })]
    expect(validateAnswers(qs, { w: '300' }).ok).toBe(false)
    expect(validateAnswers(qs, { w: '0' }).ok).toBe(false)
    expect(validateAnswers(qs, { w: '72.5' })).toEqual({ ok: true, cleaned: { w: '72.5' } })
    expect(validateAnswers(qs, { w: 'abc' }).ok).toBe(false)
  })

  it('file answer must be doc:<id>', () => {
    const qs = [q({ id: 'f', type: 'file', required: true })]
    expect(validateAnswers(qs, { f: 'doc:42' })).toEqual({ ok: true, cleaned: { f: 'doc:42' } })
    expect(validateAnswers(qs, { f: '/uploads/x.pdf' }).ok).toBe(false)
    expect(validateAnswers(qs, { f: 'doc:abc' }).ok).toBe(false)
  })

  it('signature answer is the typed name, non-empty', () => {
    const qs = [q({ id: 'sig', type: 'signature', required: true })]
    expect(validateAnswers(qs, { sig: '  Ananya Rao ' })).toEqual({ ok: true, cleaned: { sig: 'Ananya Rao' } })
    expect(validateAnswers(qs, { sig: '   ' }).ok).toBe(false)
  })

  it('select answer must be one of the English options', () => {
    const qs = [q({ id: 's', type: 'select', options: ['Yes', 'No'] })]
    expect(validateAnswers(qs, { s: 'हाँ' }).ok).toBe(false)
  })

  it('a required checkbox must be ticked', () => {
    const qs = [q({ id: 'c', type: 'checkbox', required: true })]
    expect(validateAnswers(qs, { c: 'false' }).ok).toBe(false)
    expect(validateAnswers(qs, { c: 'true' })).toEqual({ ok: true, cleaned: { c: 'true' } })
  })
})

describe('localiseQuestion', () => {
  const question = q({
    id: 'smoker', type: 'select', label: 'Do you smoke?', options: ['Yes', 'No'],
    i18n: { kn: { options: ['ಹೌದು', 'ಇಲ್ಲ'] }, hi: { label: 'क्या आप धूम्रपान करते हैं?' } },
  })
  it('Kannada label missing falls back to English while the Kannada option list is used', () => {
    expect(localiseQuestion(question, 'kn')).toEqual({ label: 'Do you smoke?', options: ['ಹೌದು', 'ಇಲ್ಲ'] })
  })
  it('Hindi label is used while options fall back to English', () => {
    expect(localiseQuestion(question, 'hi')).toEqual({ label: 'क्या आप धूम्रपान करते हैं?', options: ['Yes', 'No'] })
  })
  it('English returns the base strings; no options key for an option-less question', () => {
    expect(localiseQuestion(question, 'en')).toEqual({ label: 'Do you smoke?', options: ['Yes', 'No'] })
    expect(localiseQuestion(q({ id: 'a', type: 'text', label: 'Name' }), 'hi')).toEqual({ label: 'Name' })
  })
  it('blank translated strings fall back to English string by string', () => {
    const blanky = { ...question, i18n: { kn: { label: '  ', options: ['ಹೌದು', ''] } } }
    expect(localiseQuestion(blanky, 'kn')).toEqual({ label: 'Do you smoke?', options: ['ಹೌದು', 'No'] })
  })
})
