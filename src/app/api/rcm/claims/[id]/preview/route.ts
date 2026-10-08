import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { RCM_ROLES } from '@/lib/role-policy'
import { renderDraftCopy } from '@/lib/queries/claim-submissions'
import { parseId, rcmError, rcmServerError } from '@/lib/rcm/route-responses'

// SP7: an unsaved draft copy of the next claim version (audited by the query).
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!RCM_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const id = parseId((await params).id)
  if (id === null) return rcmError(400, 'Invalid claim id')
  try {
    const draft = await renderDraftCopy(id, session)
    if (!draft) return rcmError(404, 'Claim not found')
    return new NextResponse(Buffer.from(draft.bytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${draft.claimNumber}-draft.pdf"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (err) {
    return rcmServerError('claim preview', err, 'Could not prepare the preview')
  }
}
