import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePatientSession } from '@/lib/patient-session'
import { getLatestPolicyDocument, recordPolicyAcceptance } from '@/lib/queries/policy-documents'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { getPatientPortalIdentity } from '@/lib/queries/patient-portal'

const consentSchema = z.object({ acceptedNpp: z.literal(true), acceptedTos: z.literal(true) }).strict()

export async function GET() {
  const session = await requirePatientSession()
  if (session instanceof NextResponse) return session

  const [npp, tos] = await Promise.all([getLatestPolicyDocument('npp'), getLatestPolicyDocument('tos')])
  return NextResponse.json({ npp, tos })
}

export async function POST(request: NextRequest) {
  const session = await requirePatientSession()
  if (session instanceof NextResponse) return session

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  // .literal(true) on both fields means an unchecked box (false, or missing)
  // fails validation here -- the same "can't silently skip a required
  // checkbox" guarantee the .strict() schemas elsewhere in this app give for
  // unknown fields, applied to this specific gate.
  const parsed = consentSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Both the Notice of Privacy Practices and Terms of Service must be accepted' }, { status: 400 })

  const identity = await getPatientPortalIdentity(session.patientId)
  if (!identity) return NextResponse.json({ error: 'Patient not found' }, { status: 404 })

  await recordPolicyAcceptance(session.patientId, identity.name)
  await logPatientPortalAction('accepted Notice of Privacy Practices and Terms of Service', session.patientId)

  return NextResponse.json({ ok: true })
}
