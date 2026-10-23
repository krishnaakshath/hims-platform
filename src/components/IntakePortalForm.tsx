'use client'
import { sendJson } from '@/lib/client-fetch'
import { formatIstDate } from '@/lib/india-time'
import { useState } from 'react'
import Link from 'next/link'
import { QuestionField, type IntakeQuestion as Question } from '@/components/intake/QuestionField'
import { LanguageSwitch } from '@/components/intake/LanguageSwitch'
import { SignatureCapture } from '@/components/SignatureCapture'
import type { SubmissionConsent } from '@/lib/queries/form-submission-consents'
import { validateAnswers, visibleQuestions, type FormLang } from '@/lib/forms/question-model'

// validateAnswers' fixed message for a blank required question: shown as the
// submit-blocked reason, not under each field (the asterisk already says it).
const REQUIRED_MESSAGE = 'This question is required'

function isAnswered(question: Question, value: string | undefined): boolean {
  if (question.type === 'checkbox') return value !== undefined
  return !!value?.trim()
}

// A page is either the questions block or one consent document. Questions
// come first (when there are any), then one page per consent in the order the
// server returned them (formSubmissionConsents.sortOrder), then submit.
type Page = { kind: 'questions' } | { kind: 'consent'; index: number }

export function IntakePortalForm({ token, questions, existingAnswers, autofill, consents: initialConsents = [], languages = ['en'], signedCopyHref = null }: {
  token: string
  questions: Question[]
  existingAnswers: Record<string, string>
  autofill: Record<string, string>
  consents?: SubmissionConsent[]
  /** The template's offered languages ('en' first). */
  languages?: FormLang[]
  /** Set by the server only when a portal session for this submission's patient exists. */
  signedCopyHref?: string | null
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({ ...autofill, ...existingAnswers })
  const [lang, setLang] = useState<FormLang>('en')
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [consents, setConsents] = useState<SubmissionConsent[]>(initialConsents)
  const [pageIndex, setPageIndex] = useState(0)
  const [signingId, setSigningId] = useState<number | null>(null)
  const [signErrors, setSignErrors] = useState<Record<number, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function update(id: string, value: string) {
    setAnswers((prev) => ({ ...prev, [id]: value }))
    setServerErrors((prev) => { if (!(id in prev)) return prev; const next = { ...prev }; delete next[id]; return next })
  }

  // Only what the patient can currently see is sent: an answer to a question
  // since hidden by its condition is dropped here (and again by the server).
  const shown = visibleQuestions(questions, answers)
  const answerable = shown.filter((q) => q.type !== 'section')

  async function submit(complete: boolean) {
    setSubmitting(true)
    setError(null)
    const sent: Record<string, string> = {}
    for (const q of answerable) if (answers[q.id] !== undefined) sent[q.id] = answers[q.id]
    const res = await sendJson(`/api/intake/${token}`, 'PUT', { answers: sent, complete })
    setSubmitting(false)
    if (!res.ok) {
      const fieldErrors = (res.body as { errors?: unknown } | undefined)?.errors
      if (fieldErrors && typeof fieldErrors === 'object') setServerErrors(fieldErrors as Record<string, string>)
      setError(res.error)
      return
    }
    if (complete) setSubmitted(true)
  }

  async function signConsent(formSubmissionConsentId: number, typedName: string) {
    setSigningId(formSubmissionConsentId)
    setSignErrors((prev) => { const next = { ...prev }; delete next[formSubmissionConsentId]; return next })
    try {
      const res = await sendJson(`/api/intake/${token}/consents/${formSubmissionConsentId}/sign`, 'POST', { typedName })
      if (!res.ok) {
        setSignErrors((prev) => ({ ...prev, [formSubmissionConsentId]: res.error }))
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
        {signedCopyHref ? (
          <PortalLinks signedCopyHref={lang === 'en' ? signedCopyHref : `${signedCopyHref}?lang=${lang}`} />
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">You may close this page.</p>
        )}
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

  const check = validateAnswers(questions, answers)
  const fieldErrors: Record<string, string> = check.ok ? {} : check.errors
  const requiredMissing = Object.values(fieldErrors).some((e) => e === REQUIRED_MESSAGE)
  const answerInvalid = Object.values(fieldErrors).some((e) => e !== REQUIRED_MESSAGE)

  const answeredCount = answerable.filter((q) => isAnswered(q, answers[q.id])).length
  const signedCount = consents.filter((c) => c.signedAt).length
  const unsignedCount = consents.length - signedCount
  // Questions and consents both count toward progress. A consent-only packet
  // has questions.length === 0, so the total must never be questions alone;
  // and when the total is 0 there is nothing to measure, so no bar renders.
  const progressTotal = answerable.length + consents.length
  const progressDone = answeredCount + signedCount
  const progressPercent = progressTotal === 0 ? 0 : Math.round((progressDone / progressTotal) * 100)

  const progressLabel = [
    answerable.length > 0 ? `${answeredCount} of ${answerable.length} question${answerable.length === 1 ? '' : 's'} answered` : null,
    consents.length > 0 ? `${signedCount} of ${consents.length} consent${consents.length === 1 ? '' : 's'} signed` : null,
  ].filter(Boolean).join(' · ')

  const submitBlockedReason = unsignedCount > 0
    ? `Please sign ${unsignedCount === 1 ? 'the remaining consent document' : `all ${unsignedCount} remaining consent documents`} before submitting.`
    : requiredMissing
      ? 'Please answer every required question before submitting.'
      : answerInvalid
        ? 'Please correct the answers marked below before submitting.'
        : null

  return (
    <div>
      <LanguageSwitch languages={languages} value={lang} onChange={setLang} />
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
          {shown.map((q) => (
            <QuestionField
              key={q.id}
              question={q}
              lang={lang}
              value={answers[q.id]}
              onChange={(v) => update(q.id, v)}
              error={serverErrors[q.id] ?? (fieldErrors[q.id] !== REQUIRED_MESSAGE ? fieldErrors[q.id] : null)}
              uploadUrl={`/api/intake/${token}/files`}
            />
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

// Shown only when the server found a patient-portal session for this
// submission's own patient (never from anything in the URL).
export function PortalLinks({ signedCopyHref }: { signedCopyHref: string }) {
  return (
    <div className="mt-4 flex flex-wrap justify-center gap-2">
      <Link href="/patient-portal" className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary">Back to your portal</Link>
      <Link href={signedCopyHref} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90">View signed copy</Link>
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
          Signed by {consent.signerTypedName} on {formatIstDate(consent.signedAt)}
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
