import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { RCM_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { streamPrivateBlob } from '@/lib/blob-store'
import { getClaimDocumentBlob } from '@/lib/queries/claim-documents'
import { parseId, rcmError, rcmServerError } from '@/lib/rcm/route-responses'

// SP7: stream a claim document inline (an upload, or the lab report / pre-auth letter / card behind it).
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!RCM_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const id = parseId((await params).id)
  if (id === null) return rcmError(400, 'Invalid document id')
  try {
    const doc = await getClaimDocumentBlob(id)
    if (!doc) return rcmError(404, 'Document not found')
    const response = await streamPrivateBlob(doc.url, { filename: `claim-${doc.claimId}-document-${id}`, disposition: 'inline' })
    if (!response) return rcmError(404, 'Stored file is missing')
    await logAudit(session, 'rcm: viewed claim document', doc.patientId, `claim=${doc.claimId} document=${id}`)
    return response
  } catch (err) {
    return rcmServerError('view claim document', err, 'Could not open the document')
  }
}
