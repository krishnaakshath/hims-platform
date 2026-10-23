'use client'
import { useId, useState } from 'react'
import { fetchJson } from '@/lib/client-fetch'
import { localiseQuestion, type FormLang, type FormQuestion } from '@/lib/forms/question-model'

// WS7 T3: the single per-question renderer for every question type. The intake
// portal and the builder's read-only preview both render through this, so the
// preview cannot drift from what a patient sees. Display strings come from
// localiseQuestion (English fallback string by string); a select's <option>
// VALUE is always the English option, so the stored answer is language-neutral
// (spec D9) whatever language the patient reads.

/** What the patient's renderer receives of a question: never scores, chart tags or the autofill source. */
export type IntakeQuestion = Omit<FormQuestion, 'optionScores' | 'compareToChart' | 'autofillField'>

const INPUT = 'w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/40 focus:outline-none'
const FILE_ACCEPT = 'application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png'

export function QuestionField({ question: q, lang = 'en', value, onChange, disabled, error, uploadUrl }: {
  question: IntakeQuestion
  lang?: FormLang
  value: string | undefined
  onChange: (value: string) => void
  disabled?: boolean
  /** A fixed validation message for this question (never echoes the answer). */
  error?: string | null
  /** Where a file question posts its upload; without it (preview) the file input stays disabled. */
  uploadUrl?: string
}) {
  const id = useId()
  const { label, options } = localiseQuestion(q, lang)

  if (q.type === 'section') {
    return <h2 className="border-b border-border pb-1 pt-2 text-base font-semibold text-foreground">{label}</h2>
  }

  const errorId = `${id}-error`
  const described = error ? errorId : undefined

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-foreground">
        {label}{q.required && <span aria-hidden="true"> *</span>}
      </label>
      {q.type === 'textarea' ? (
        <textarea id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-describedby={described} className={INPUT} rows={3} />
      ) : q.type === 'select' ? (
        <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-describedby={described} className={INPUT}>
          <option value="">Select…</option>
          {(q.options ?? []).map((english, i) => <option key={english} value={english}>{options?.[i] ?? english}</option>)}
        </select>
      ) : q.type === 'checkbox' ? (
        <span className="flex items-center gap-2 text-sm text-foreground">
          <input id={id} type="checkbox" checked={value === 'true'} onChange={(e) => onChange(e.target.checked ? 'true' : 'false')} disabled={disabled} aria-describedby={described} />
          I agree
        </span>
      ) : q.type === 'file' ? (
        <FileInput id={id} value={value} onChange={onChange} disabled={disabled || !uploadUrl} uploadUrl={uploadUrl} questionId={q.id} describedBy={described} />
      ) : q.type === 'signature' ? (
        <>
          <input id={id} type="text" autoComplete="name" value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-describedby={described} placeholder="Full legal name" className={INPUT} />
          <p className="mt-1 text-xs text-muted-foreground">Typing your full name here is your signature.</p>
        </>
      ) : (
        <input
          id={id}
          type={q.type === 'date' ? 'date' : q.type === 'number' ? 'number' : q.type === 'phone' ? 'tel' : 'text'}
          inputMode={q.type === 'phone' ? 'tel' : q.type === 'number' ? 'decimal' : undefined}
          min={q.type === 'number' ? q.min : undefined}
          max={q.type === 'number' ? q.max : undefined}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-describedby={described}
          className={INPUT}
        />
      )}
      {error && <p id={errorId} className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}

function FileInput({ id, value, onChange, disabled, uploadUrl, questionId, describedBy }: {
  id: string
  value: string | undefined
  onChange: (value: string) => void
  disabled?: boolean
  uploadUrl?: string
  questionId: string
  describedBy?: string
}) {
  const [fileName, setFileName] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  async function upload(file: File | undefined) {
    if (!file || !uploadUrl) return
    setUploading(true)
    setUploadError(null)
    const body = new FormData()
    body.set('questionId', questionId)
    body.set('file', file)
    const res = await fetchJson<{ answer: string; fileName: string }>(uploadUrl, { method: 'POST', body }, { passThrough: [413] })
    setUploading(false)
    if (!res.ok) { setUploadError(res.error); return }
    setFileName(res.data.fileName)
    onChange(res.data.answer)
  }

  const uploaded = !!value && value.startsWith('doc:')
  return (
    <div className="space-y-1">
      <input id={id} type="file" accept={FILE_ACCEPT} disabled={disabled || uploading} aria-describedby={describedBy}
        onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = '' }}
        className="block w-full text-sm text-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-secondary file:px-3 file:py-1.5 file:text-sm" />
      <p className="text-xs text-muted-foreground">PDF, JPEG or PNG, up to 5 MB.</p>
      {uploading && <p className="text-xs text-muted-foreground">Uploading…</p>}
      {uploaded && !uploading && <p className="text-xs font-medium text-foreground">{fileName ? `Uploaded: ${fileName}` : 'A document is already uploaded.'}</p>}
      {uploadError && <p role="alert" className="text-xs text-destructive">{uploadError}</p>}
    </div>
  )
}
