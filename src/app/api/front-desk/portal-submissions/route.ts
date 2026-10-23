// WS7 T9 (spec D15): the pending portal self-service submissions (policies and ABHA numbers
// patients added from the portal) for the reviewers -- PORTAL_SUBMISSION_REVIEW_ROLES. No file
// path or blob URL is returned; the card is a document id the documents routes serve.
import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { PORTAL_SUBMISSION_REVIEW_ROLES } from '@/lib/role-policy'
import { listPendingPortalSubmissions } from '@/lib/queries/portal-submissions'

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!PORTAL_SUBMISSION_REVIEW_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const submissions = await listPendingPortalSubmissions(session.role)
  await logAudit(session, 'viewed portal submissions', null, `count=${submissions.length}`)
  return NextResponse.json({ submissions })
}
