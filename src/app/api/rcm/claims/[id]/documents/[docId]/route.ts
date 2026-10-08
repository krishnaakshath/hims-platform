import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { RCM_ROLES } from '@/lib/role-policy'
import { removeClaimDocument } from '@/lib/queries/claim-documents'
import { parseId, rcmError, rcmErrorResponse, rcmServerError } from '@/lib/rcm/route-responses'

// SP7: remove a claim document (it is superseded, never deleted).
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!RCM_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const p = await params
  const id = parseId(p.id)
  const docId = parseId(p.docId)
  if (id === null || docId === null) return rcmError(400, 'Invalid id')
  try {
    const r = await removeClaimDocument(id, docId, session)
    if (!r.ok) return rcmErrorResponse(r)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return rcmServerError('remove claim document', err, 'Could not remove the document')
  }
}
