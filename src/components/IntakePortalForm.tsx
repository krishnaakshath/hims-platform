'use client'
import { useState } from 'react'
import { IntakeQuestionField, type IntakeQuestion as Question } from '@/components/IntakeQuestionField'
import { SignatureCapture } from '@/components/SignatureCapture'
import type { SubmissionConsent } from '@/lib/queries/form-submission-consents'

function isAnswered(question: Question, value: string | undefined): boolean {
  if (question.type === 'checkbox') return value !== undefined
  return !!value?.trim()
}

// A page is either the questions block or one consent document. Questions
// come first (when there are any), then one page per consent in the order the
// server returned them (formSubmissionConsents.sortOrder), then submit.
type Page = { kind: 'questions' } | { kind: 'consent'; index: number }

export function IntakePortalForm({ token, questions, existingAnswers, autofill, consents: initialConsents = [] }: {
  token: string
  questions: Question[]
  existingAnswers: Record<string, string>
  autofill: Record<string, string>
  consents?: SubmissionConsent[]
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({ ...autofill, ...existingAnswers })
  const [consents, setConsents] = useState<SubmissionConsent[]>(initialConsents)
  const [pageIndex, setPageIndex] = useState(0)
  const [signingId, setSigningId] = useState<number | null>(null)
  const [signErrors, setSignErrors] = useState<Record<number, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function update(id: string, value: string) {
    setAnswers((prev) => ({ ...prev, [id]: value }))
  }

  async function submit(complete: boolean) {
    setSubmitting(true)
    setError(null)
    const res = await fetch(`/api/intake/${token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers, complete }),
    })
    setSubmitting(false)
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      setError(typeof body?.error === 'string' ? body.error : 'Something went wrong saving your answers. Please try again.')
      return
    }
    if (complete) setSubmitted(true)
  }

  async function signConsent(formSubmissionConsentId: number, typedName: string) {
    setSigningId(formSubmissionConsentId)
    setSignErrors((prev) => { const next = { ...prev }; delete next[formSubmissionConsentId]; return next })
    try {
      const res = await fetch(`/api/intake/${token}/consents/${formSubmissionConsentId}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ typedName }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setSignErrors((prev) => ({ ...prev, [formSubmissionConsentId]: typeof body?.error === 'string' ? body.error : 'Something went wrong recording your signature. Please try again.' }))
        return
      }
      setConsents((prev) => prev.map((c) => c.formSubmissionConsentId === formSubmissionConsentId ? { ...c, signedAt: new Date(), signerTypedName: typedName } : c))
    } catch {
      setSignErrors((prev) => ({ ...prev, [formSubmissionConsentId]: 'Something went wrong recording your signature. Please try again.' }))
    } finally {
      setSigningId(null)
    }
  }

  if (submitted) {
    return (
      <div className="text-center">
        <p className="text-sm font-medium text-foreground">Thank you — your form has been submitted.</p>
        <p className="mt-1 text-sm text-muted-foreground">You may close this page.</p>
      </div>
    )
  }

  const pages: Page[] = [
    ...(questions.length > 0 ? [{ kind: 'questions' } as const] : []),
    ...consents.map((_, index) => ({ kind: 'consent', index }) as const),
  ]
  // A template with neither questions nor consents still gets one (empty)
  // questions page so the submit controls render.
  if (pages.length === 0) pages.push({ kind: 'questions' })
  const currentIndex = Math.min(pageIndex, pages.length - 1)
  const page = pages[currentIndex]
  const isLastPage = currentIndex === pages.length - 1

  const answeredCount = questions.filter((q) => isAnswered(q, answers[q.id])).length
  const signedCount = consents.filter((c) => c.signedAt).length
  const unsignedCount = consents.length - signedCount
  // Questions and consents both count toward progress. A consent-only packet
  // has questions.length === 0, so the total must never be questions alone;
  // and when the total is 0 there is nothing to measure, so no bar renders.
  const progressTotal = questions.length + consents.length
  const progressDone = answeredCount + signedCount
  const progressPercent = progressTotal === 0 ? 0 : Math.round((progressDone / progressTotal) * 100)
  const requiredMissing = questions.some((q) => q.required && !isAnswered(q, answers[q.id]))

  const progressLabel = [
    questions.length > 0 ? `${answeredCount} of ${questions.length} question${questions.length === 1 ? '' : 's'} answered` : null,
    consents.length > 0 ? `${signedCount} of ${consents.length} consent${consents.length === 1 ? '' : 's'} signed` : null,
  ].filter(Boolean).join(' · ')

  const submitBlockedReason = unsignedCount > 0
    ? `Please sign ${unsignedCount === 1 ? 'the remaining consent document' : `all ${unsignedCount} remaining consent documents`} before submitting.`
    : requiredMissing
      ? 'Please answer every required question before submitting.'
      : null

  return (
    <div>
      {progressTotal > 0 && (
        <div className="mb-6">
          <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-muted-foreground">
            <span>{progressLabel}</span>
            <span className="tabular-nums text-primary">{progressPercent}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Form completion progress" aria-valuenow={progressPercent} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-primary transition-all duration-300" style={{ width: `${progressPercent}%` }} />
          </div>
        </div>
      )}

      {pages.length > 1 && (
        <p className="mb-3 text-xs font-medium text-muted-foreground">Page {currentIndex + 1} of {pages.length}</p>
      )}

      {page.kind === 'questions' ? (
        <div className="space-y-4">
          {questions.map((q) => (
            <IntakeQuestionField key={q.id} question={q} value={answers[q.id]} onChange={(v) => update(q.id, v)} />
          ))}
        </div>
      ) : (
        <ConsentPage
          consent={consents[page.index]}
          signing={signingId === consents[page.index].formSubmissionConsentId}
          error={signErrors[consents[page.index].formSubmissionConsentId] ?? null}
          onSign={(typedName) => signConsent(consents[page.index].formSubmissionConsentId, typedName)}
        />
      )}

      {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-2 pt-2">
        <button onClick={() => submit(false)} disabled={submitting} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-50">Save and finish later</button>
        <div className="flex gap-2">
          {currentIndex > 0 && (
            <button onClick={() => setPageIndex(currentIndex - 1)} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary">Back</button>
          )}
          {isLastPage ? (
            <button onClick={() => submit(true)} disabled={submitting || submitBlockedReason !== null} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50">Submit</button>
          ) : (
            <button onClick={() => setPageIndex(currentIndex + 1)} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90">Next</button>
          )}
        </div>
      </div>
      {isLastPage && submitBlockedReason && (
        <p role="alert" className="mt-2 text-right text-xs text-muted-foreground" data-testid="submit-blocked-reason">{submitBlockedReason}</p>
      )}
    </div>
  )
}

function ConsentPage({ consent, signing, error, onSign }: {
  consent: SubmissionConsent
  signing: boolean
  error: string | null
  onSign: (typedName: string) => void
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-foreground">{consent.name}</h2>
      {/* Plain text by design (bodyText is never rich text), rendered as a
          React text node -- never as HTML -- so the draft banner and every
          character the signer attests to appear literally. */}
      <div tabIndex={0} role="region" aria-label={consent.name} className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-4 text-sm text-foreground">{consent.renderedText}</div>
      {consent.signedAt ? (
        <p className="text-sm font-medium text-foreground" suppressHydrationWarning>
          Signed by {consent.signerTypedName} on {new Date(consent.signedAt).toLocaleDateString()}
        </p>
      ) : (
        <SignatureCapture
          attestationLabel="I have read this document and agree to it. I understand that typing my name below is my legal signature."
          submitLabel="Sign"
          submitting={signing}
          error={error}
          onSign={onSign}
        />
      )}
    </div>
  )
}
