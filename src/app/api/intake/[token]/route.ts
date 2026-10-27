import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { formSubmissions } from '@/db/schema'
import { and, eq, ne } from 'drizzle-orm'
import { documentIdsOfPatient, getActiveIntakeSubmission, getIntakePortalData, getSubmissionPatientIdByToken } from '@/lib/queries/intake-portal'
import { FORM_LANGS, validateAnswers } from '@/lib/forms/question-model'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'
import { recordFormChartDiscrepancies } from '@/lib/queries/discrepancies'
import { recordFormSubmissionScore } from '@/lib/queries/form-submission-scoring'
import { countUnsignedConsentsByToken } from '@/lib/queries/form-submission-consents'

// Deliberately NOT requireSession()-gated -- a referred patient has no staff
// account. Authorization here is possession of the unguessable token itself,
// checked inside getIntakePortalData/getSubmissionPatientIdByToken (expired
// or completed submissions refuse access regardless of who holds the link).
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const data = await getIntakePortalData(token)
  // Log only when the token actually resolves to a patient -- a not_found
  // or already-expired token has no patientId to attribute the row to, and
  // logging an audit-log-free-text scan of dead tokens isn't useful signal.
  const patientId = await getSubmissionPatientIdByToken(token)
  if (patientId) await logPatientPortalAction('viewed intake form via patient portal', patientId)
  return NextResponse.json(data)
}

const submitSchema = z.object({
  answers: z.record(z.string(), z.string()),
  complete: z.boolean(),
  language: z.enum(FORM_LANGS).optional(), // WS7 T3: the language the patient is reading the form in
}).strict()

export async function PUT(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const submission = await getActiveIntakeSubmission(token)
  if (!submission) return NextResponse.json({ error: 'This link is no longer valid.' }, { status: 404 })
  const { patientId } = submission

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = submitSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid submission', details: parsed.error.flatten() }, { status: 400 })

  // Completion gate: every attached consent must be signed before the packet
  // can be marked completed. Partial saves (complete: false) are unaffected --
  // a patient can answer half the questions and come back before signing
  // anything (spec §6). Re-run on every completion attempt; the conditional
  // UPDATE below remains the separate write-time race guard.
  if (parsed.data.complete && (await countUnsignedConsentsByToken(token)) > 0) {
    return NextResponse.json({ error: 'This form has unsigned consent documents' }, { status: 400 })
  }

  // WS7 T3: the answers are judged against the template's questions. Only
  // `cleaned` is stored: answers to questions hidden by their condition, to
  // sections and to unknown ids are dropped, phones normalised. A partial save
  // checks formats but not required answers (the patient may come back later).
  const questions = parsed.data.complete ? submission.questions : submission.questions.map((q) => ({ ...q, required: false }))
  const result = validateAnswers(questions, parsed.data.answers)
  if (!result.ok) return NextResponse.json({ error: 'Please check the answers marked on the form.', errors: result.errors }, { status: 400 })
  const cleaned = result.cleaned
  const { language } = parsed.data
  if (language !== undefined && !submission.languages.includes(language)) {
    return NextResponse.json({ error: 'This form is not offered in that language.' }, { status: 400 })
  }
  // A file answer may only name a document of this patient (its own upload).
  const fileAnswers = submission.questions.filter((q) => q.type === 'file' && cleaned[q.id] !== undefined)
  if (fileAnswers.length > 0) {
    const owned = await documentIdsOfPatient(patientId, fileAnswers.map((q) => Number(cleaned[q.id].slice('doc:'.length))))
    const errors: Record<string, string> = {}
    for (const q of fileAnswers) if (!owned.has(Number(cleaned[q.id].slice('doc:'.length)))) errors[q.id] = 'Upload the requested document'
    if (Object.keys(errors).length > 0) return NextResponse.json({ error: 'Please check the answers marked on the form.', errors }, { status: 400 })
  }

  const status = parsed.data.complete ? 'completed' : 'partial'
  const completedDate = parsed.data.complete ? new Date() : null
  // Re-check status !== 'completed' in the same statement as the write --
  // the earlier getSubmissionPatientIdByToken check and this update are two
  // separate round-trips, so a second, near-simultaneous PUT could otherwise
  // slip through between them and overwrite an already-completed submission.
  const updated = await getDb()
    .update(formSubmissions)
    .set({ answers: cleaned, status, completedDate, ...(language !== undefined ? { language } : {}) })
    .where(and(eq(formSubmissions.accessToken, token), ne(formSubmissions.status, 'completed')))
    .returning({ id: formSubmissions.id })
  if (updated.length === 0) return NextResponse.json({ error: 'This link is no longer valid.' }, { status: 404 })

  await invalidateCache(patientDetailCacheKey(patientId))
  await logPatientPortalAction(parsed.data.complete ? 'completed intake form via patient portal' : 'saved partial progress via patient portal', patientId)

  if (parsed.data.complete) {
    await recordFormSubmissionScore(updated[0].id)
    const discrepancyCount = await recordFormChartDiscrepancies(updated[0].id)
    if (discrepancyCount > 0) await logPatientPortalAction(`form answers flagged ${discrepancyCount} discrepancy(ies) against chart data`, patientId)
  }

  return NextResponse.json({ ok: true })
}
