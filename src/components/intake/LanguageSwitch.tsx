'use client'
import type { FormLang } from '@/lib/forms/question-model'

// WS7 T3: the intake form's language choice, limited to the template's offered
// languages. Each name is written in its own script. Hidden when only English
// is offered.
const LANGUAGE_NAME: Record<FormLang, string> = { en: 'English', hi: 'हिन्दी', kn: 'ಕನ್ನಡ' }

export function LanguageSwitch({ languages, value, onChange }: {
  languages: readonly FormLang[]
  value: FormLang
  onChange: (lang: FormLang) => void
}) {
  if (languages.length < 2) return null
  return (
    <div role="group" aria-label="Language" className="mb-4 flex flex-wrap gap-1">
      {languages.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={l === value}
          onClick={() => onChange(l)}
          className={`rounded-md border px-3 py-1 text-sm font-medium transition-colors ${l === value ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-foreground hover:bg-secondary'}`}
        >
          {LANGUAGE_NAME[l]}
        </button>
      ))}
    </div>
  )
}
