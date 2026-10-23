// WS7 T3: the patient's printable copy of a form they submitted -- the answers
// in the language they filled it in (form_submissions.language, recorded by the
// intake PUT; English when not recorded, and wherever a string is untranslated) and each attached
// consent exactly as signed (the stored attestation text, typed name, IST
// time). Identified by UHID, never the chart id. Another patient's submission,
// or one not yet submitted, is a 404 with no audit row; a shown copy is audited.
import { notFound } from 'next/navigation'
import { requirePortalDocumentSession } from '@/lib/patient-portal-documents'
import { parseId } from '@/lib/http'
import { getPortalFormCopy } from '@/lib/queries/patient-portal-records'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { localiseQuestion, visibleQuestions, type FormLang, type FormQuestion } from '@/lib/forms/question-model'
import { formatAnswerDisplay } from '@/lib/form-answers'
import { formatIstDateTime } from '@/lib/india-time'
import { BackLink } from '@/components/BackLink'
import { PrintButton } from '@/components/PrintButton'

function answerText(q: FormQuestion, lang: FormLang, raw: string | undefined): string {
  // A select answer is stored as the English option: show the same option in the reader's language.
  if (q.type === 'select' && raw !== undefined) {
    const i = (q.options ?? []).indexOf(raw)
    if (i >= 0) return localiseQuestion(q, lang).options?.[i] ?? raw
  }
  // A signature reads as the typed name itself on a signed copy.
  if (q.type === 'signature' && raw) return raw
  return formatAnswerDisplay(q, raw)
}

export default async function PortalFormCopyPage({ params }: { params: Promise<{ submissionId: string }> }) {
  const session = await requirePortalDocumentSession()
  const submissionId = parseId((await params).submissionId)
  if (submissionId === null) notFound()
  const copy = await getPortalFormCopy(session.patientId, submissionId)
  if (!copy) notFound()
  const lang = copy.language
  await logPatientPortalAction('viewed signed form copy', session.patientId, `submission=${copy.submissionId}`)

  const shown = visibleQuestions(copy.questions, copy.answers)

  return (
    <main className="min-h-screen bg-neutral-100 py-8 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-[180mm] items-center justify-between px-2 print:hidden">
        <BackLink href="/patient-portal/forms" label="Back to forms" />
        <PrintButton />
      </div>
      <article lang={lang} className="mx-auto max-w-[180mm] space-y-6 bg-white p-8 text-sm text-neutral-900 shadow-sm print:shadow-none">
        <header className="space-y-1 border-b border-neutral-300 pb-4">
          <h1 className="text-lg font-semibold">{copy.templateName}</h1>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-neutral-700">
            <dt>Patient</dt><dd>{copy.patientName}</dd>
            <dt>UHID</dt><dd>{copy.uhid ?? '—'}</dd>
            <dt>Submitted</dt><dd>{formatIstDateTime(copy.completedDate, { label: true })}</dd>
          </dl>
        </header>

        {shown.length > 0 && (
          <section className="space-y-3">
            {shown.map((q) => q.type === 'section' ? (
              <h2 key={q.id} className="border-b border-neutral-200 pb-1 pt-2 text-base font-semibold">{localiseQuestion(q, lang).label}</h2>
            ) : (
              <div key={q.id} className="grid gap-1 sm:grid-cols-[1fr_1fr] sm:gap-4">
                <p className="font-medium">{localiseQuestion(q, lang).label}</p>
                <p className="whitespace-pre-wrap">{answerText(q, lang, copy.answers[q.id])}</p>
              </div>
            ))}
          </section>
        )}

        {copy.consents.map((c) => (
          <section key={c.formSubmissionConsentId} className="space-y-2 border-t border-neutral-300 pt-4">
            <h2 className="text-base font-semibold">{c.name}</h2>
            {/* Plain text, rendered as a text node: the wording exactly as attested. */}
            <div className="whitespace-pre-wrap">{c.renderedText}</div>
            <p className="font-medium">
              {c.signedAt ? `Signed by ${c.signerTypedName} on ${formatIstDateTime(c.signedAt, { label: true })}` : 'Not signed'}
            </p>
          </section>
        ))}
      </article>
    </main>
  )
}
