import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { and, eq, ne } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { formSubmissions } from '@/db/schema'
import { requirePatientSession } from '@/lib/patient-session'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { getFormSubmission } from '@/lib/queries/form-submissions'
import { createSignature } from '@/lib/queries/signatures'
import { hasAttachedConsents } from '@/lib/queries/form-submission-consents'

const signSchema = z.object({ typedName: z.string().trim().min(1).max(200) }).strict()

const CONSENT_ATTESTATION = 'I attest that the information in this form is accurate and I consent to the terms described above.'

export async function POST(request: NextRequest, { params }: { params: Promise<{ anonId: string; id: string }> }) {
  const session = await requirePatientSession()
  if (session instanceof NextResponse) return session

  const { anonId, id } = await params
  // Same convention as POST /api/messages/[patientId]: a patient session
  // that doesn't match the URL's patientId is a distinct 403, not a silent
  // 401 or a no-op -- it never confirms or denies that a submission with
  // this id exists for a *different* patient.
  if (session.patientId !== anonId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = signSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid signature payload', details: parsed.error.flatten() }, { status: 400 })

  const submissionId = Number(id)
  const submission = await getFormSubmission(submissionId)
  if (!submission || submission.patientId !== anonId) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (submission.category !== 'Consent Forms') return NextResponse.json({ error: 'This form does not require a signature' }, { status: 400 })
  if (submission.status === 'completed') return NextResponse.json({ error: 'This form has already been completed' }, { status: 409 })
  // Precedence rule: if a submission has one or more formSubmissionConsents
  // rows, the inline path (POST /api/intake/[token]/consents/.../sign plus
  // the completion gate) governs, and this legacy route refuses rather than
  // completing the submission behind the inline gate's back -- otherwise a
  // 'Consent Forms'-category template with attached consent documents would
  // offer two ways to complete the same submission, one of which skips the
  // consents entirely. The category = 'Consent Forms' gate above stays as
  // it is: it is still the live gate for every submission already in flight,
  // and no retirement date is set for it.
  if (await hasAttachedConsents(submissionId)) {
    return NextResponse.json({ error: "This form's consents are signed within the form itself" }, { status: 409 })
  }
  // The actual security boundary against signing a form the patient never
  // opened (the client-side gate in forms/page.tsx that only offers this
  // action for status 'partial' is UX, not enforcement -- a direct POST here
  // must be rejected independently). A 'sent' submission has never been
  // opened and has no real answers yet; signing it would attest to content
  // the signer demonstrably never saw, and -- because completing it kills
  // the access token via isSubmissionTokenValid -- would permanently strip
  // the patient's ability to ever answer the form's actual questions.
  if (!submission.answers || Object.keys(submission.answers).length === 0) {
    return NextResponse.json({ error: 'This form must be started before it can be signed' }, { status: 400 })
  }

  // Insert the signature FIRST, then a conditional UPDATE guarded by
  // status != 'completed' -- sequential, non-transactional two-write posture
  // (the driver does support transactions, see src/db/client.ts, but this
  // legacy route is deliberately left as-is). If two sign calls race, at most one UPDATE succeeds (the
  // WHERE guard); the loser gets a 409 below. A signature row is never
  // deleted or rolled back once inserted -- same append-only posture as the
  // rest of this table -- so the astronomically rare raced duplicate
  // attestation is left in place rather than silently discarded.
  await createSignature({
    signableType: 'form_submission',
    signableId: submissionId,
    signerTypedName: parsed.data.typedName,
    signerRole: 'patient',
    attestationText: CONSENT_ATTESTATION,
  })

  const updated = await getDb().update(formSubmissions)
    .set({ status: 'completed', completedDate: new Date() })
    .where(and(eq(formSubmissions.id, submissionId), ne(formSubmissions.status, 'completed')))
    .returning({ id: formSubmissions.id })
  if (updated.length === 0) return NextResponse.json({ error: 'This form has already been completed' }, { status: 409 })

  await logPatientPortalAction('signed consent form', anonId)
  return NextResponse.json({ ok: true })
}
