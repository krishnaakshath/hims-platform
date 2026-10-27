'use client'
import { useState } from 'react'
import type { FormLang, FormQuestion } from '@/lib/forms/question-model'

type TranslatedLang = Exclude<FormLang, 'en'>
type I18n = NonNullable<FormQuestion['i18n']>

export const TRANSLATED_LANGS: { lang: TranslatedLang; name: string }[] = [
  { lang: 'hi', name: 'Hindi' },
  { lang: 'kn', name: 'Kannada' },
]

/** Labels with English text, and how many of them have a non-blank translation in `lang`. */
export function translationProgress(questions: FormQuestion[], lang: TranslatedLang): { done: number; total: number } {
  const labelled = questions.filter((q) => q.label.trim() !== '')
  return { done: labelled.filter((q) => (q.i18n?.[lang]?.label ?? '').trim() !== '').length, total: labelled.length }
}

/**
 * Human-entered translations, string by string (spec D10: no machine
 * translation). A blank entry shows the English text to the patient, so every
 * input carries the English as its placeholder.
 */
export function TranslationsPanel({ questions, languages, onLanguagesChange, onI18nChange }: {
  questions: FormQuestion[]
  languages: FormLang[]
  onLanguagesChange: (next: FormLang[]) => void
  onI18nChange: (questionId: string, i18n: I18n) => void
}) {
  const [active, setActive] = useState<TranslatedLang>('hi')
  const activeName = TRANSLATED_LANGS.find((l) => l.lang === active)!.name

  function setLabel(q: FormQuestion, label: string) {
    onI18nChange(q.id, { ...q.i18n, [active]: { ...q.i18n?.[active], label } })
  }

  function setOption(q: FormQuestion, index: number, value: string) {
    const english = q.options ?? []
    const current = q.i18n?.[active]?.options ?? []
    const options = english.map((_, i) => (i === index ? value : current[i] ?? ''))
    onI18nChange(q.id, { ...q.i18n, [active]: { ...q.i18n?.[active], options } })
  }

  function toggleOffered(offered: boolean) {
    // English always stays first and always offered; others keep a stable order.
    const next = new Set<FormLang>(languages)
    if (offered) next.add(active)
    else next.delete(active)
    onLanguagesChange((['en', ...TRANSLATED_LANGS.map((l) => l.lang)] as FormLang[]).filter((l) => l === 'en' || next.has(l)))
  }

  const input = 'w-full rounded-md border border-border px-2.5 py-1.5 text-sm text-foreground focus:border-primary/40 focus:outline-none'
  const numbered = questions.filter((q) => q.type !== 'section')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {TRANSLATED_LANGS.map(({ lang, name }) => {
          const { done, total } = translationProgress(questions, lang)
          return (
            <button
              key={lang}
              type="button"
              onClick={() => setActive(lang)}
              aria-pressed={active === lang}
              className={`rounded-md border border-border px-3 py-1.5 text-sm ${active === lang ? 'bg-secondary font-semibold text-foreground' : 'text-muted-foreground hover:bg-secondary'}`}
            >
              {`${name} ${done}/${total} labels`}
            </button>
          )
        })}
      </div>

      <div className="rounded-xl border border-primary/10 bg-card/80 p-4 text-sm shadow-sm">
        <label className="flex items-center gap-2 font-medium text-foreground">
          <input type="checkbox" checked={languages.includes(active)} onChange={(e) => toggleOffered(e.target.checked)} />
          Offer this form in {activeName}
        </label>
        <p className="mt-1 text-xs text-muted-foreground">
          Translations are typed in by staff and should be checked by a fluent reader. Any text left blank is shown to the patient in English. Answers are always saved in English.
        </p>
      </div>

      {questions.length === 0 && <p className="text-sm text-muted-foreground">Add questions first, then translate them here.</p>}

      {questions.map((q) => {
        const t = q.i18n?.[active]
        const isSection = q.type === 'section'
        const n = numbered.indexOf(q) + 1
        return (
          <div key={q.id} className="space-y-2 rounded-xl border border-primary/10 bg-card/80 p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{isSection ? 'Section heading' : `Q${n}`}</p>
            <input
              value={t?.label ?? ''}
              onChange={(e) => setLabel(q, e.target.value)}
              placeholder={q.label}
              aria-label={`${activeName} text for ${isSection ? 'section heading' : `Q${n}`}`}
              className={`${input} ${isSection ? 'font-semibold' : ''}`}
            />
            {q.type === 'select' && (q.options ?? []).length > 0 && (
              <div className="space-y-1.5 pl-4">
                {(q.options ?? []).map((option, oi) => (
                  <input
                    key={oi}
                    value={t?.options?.[oi] ?? ''}
                    onChange={(e) => setOption(q, oi, e.target.value)}
                    placeholder={option}
                    aria-label={`${activeName} text for Q${n} option ${oi + 1}`}
                    className={`${input} text-xs`}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
