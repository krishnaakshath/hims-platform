import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { PREAUTH_LOOKUP_ROLES } from '@/lib/role-policy'
import { isoDateSchema } from '@/lib/follow-ups/validation'
import { listApprovedPreauthsForPatient } from '@/lib/queries/preauth-reference'
import { rcmError, rcmServerError } from '@/lib/rcm/route-responses'

// SP7: a patient's approved pre-auths still valid on `onDate` (the SP4 charge-capture picker).
// Numbers, references, amounts and dates only.
export async function GET(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!PREAUTH_LOOKUP_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const onDate = request.nextUrl.searchParams.get('onDate') ?? ''
  if (!isoDateSchema.safeParse(onDate).success) return rcmError(400, 'Choose a valid date')
  const { anonId } = await params
  if (!/^[A-Za-z0-9-]{1,40}$/.test(anonId)) return rcmError(400, 'Invalid patient id')

  try {
    const rows = await listApprovedPreauthsForPatient(anonId, onDate)
    return NextResponse.json({
      preauths: rows.map((r) => ({ id: r.id, preauthNumber: r.preauthNumber, approvalReference: r.approvalReference, approvedPaise: r.approvedPaise, validUntil: r.validUntil, payerIds: r.payerIds })),
    })
  } catch (err) {
    return rcmServerError('approved pre-auths', err, 'Could not load the pre-authorisations')
  }
}
