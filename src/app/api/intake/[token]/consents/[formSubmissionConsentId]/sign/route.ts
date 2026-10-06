import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createSignature } from '@/lib/queries/signatures'
import { getSubmissionConsentForToken } from '@/lib/queries/form-submission-consents'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'

// Deliberately NOT requireSession()- or requirePatientSession()-gated -- a
// referred patient has no staff account (and need not have a portal
// account). Authorization here is possession of the unguessable intake token
// itself, checked inside getSubmissionConsentForToken (expired or completed
// submissions refuse access regardless of who holds the link, and a consent
// row belonging to a different submission than the token's is refused too).
// Same posture as src/app/api/intake/[token]/route.ts.

// The body is the typed name and NOTHING else. The attested wording is
// composed server-side from the consent document (renderConsentText), so the
// client cannot decide what it attests to; signer role and time are fixed
// here too. .strict() rejects attestationText, consentDocumentId,
// signerRole, signedAt, or anything else (Review Focus #3).
const signSchema = z.object({ typedName: z.string().trim().min(1).max(200) }).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string; formSubmissionConsentId: string }> }) {
  const { token, formSubmissionConsentId } = await params

  // One check, three failure modes: bad token, expired/completed submission,
  // consent row owned by another submission.
  const consent = await getSubmissionConsentForToken(token, Number(formSubmissionConsentId))
  if (!consent) return NextResponse.json({ error: 'This link is no longer valid.' }, { status: 404 })

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid signature payload' }, { status: 400 })
  }
  const parsed = signSchema.safeParse(raw)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid signature payload', details: parsed.error.flatten() }, { status: 400 })

  if (consent.alreadySigned) return NextResponse.json({ error: 'This consent has already been signed' }, { status: 409 })

  await createSignature({
    signableType: 'form_submission_consent',
    signableId: Number(formSubmissionConsentId),
    signerTypedName: parsed.data.typedName,
    signerRole: 'patient',
    attestationText: consent.renderedText,
  })
  await logPatientPortalAction('signed consent document via intake form', consent.patientId)

  return NextResponse.json({ ok: true })
}
