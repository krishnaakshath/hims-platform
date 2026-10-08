import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { RCM_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { verifySubmission } from '@/lib/queries/claim-submissions'
import { parseId, rcmError, rcmServerError } from '@/lib/rcm/route-responses'

// SP7 (ruling 3): recompute the snapshot hash and both copy hashes of one version.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!RCM_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const id = parseId((await params).id)
  if (id === null) return rcmError(400, 'Invalid submission id')
  try {
    const r = await verifySubmission(id)
    if (!r) return rcmError(404, 'Submission not found')
    await logAudit(session, 'rcm: verified claim copy', r.patientId, `claim=${r.claimId} submission=${id} ok=${r.snapshotOk && r.rcmCopyOk && r.insurerCopyOk}`)
    return NextResponse.json({ snapshotOk: r.snapshotOk, rcmCopyOk: r.rcmCopyOk, insurerCopyOk: r.insurerCopyOk })
  } catch (err) {
    return rcmServerError('verify claim copy', err, 'Could not verify the copies')
  }
}
