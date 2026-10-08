import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { RCM_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { streamPrivateBlob } from '@/lib/blob-store'
import { getPreauthDocumentBlob } from '@/lib/queries/preauths'
import { parseId, rcmError } from '@/lib/rcm/route-responses'

// SP7: stream a stored pre-auth document inline (audited after a successful read).
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!RCM_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const id = parseId((await params).id)
  if (id === null) return rcmError(400, 'Invalid document id')
  const doc = await getPreauthDocumentBlob(id)
  if (!doc) return rcmError(404, 'Document not found')
  const response = await streamPrivateBlob(doc.url, { filename: `preauth-${doc.preauthId}-document-${id}`, disposition: 'inline' })
  if (!response) return rcmError(404, 'Stored file is missing')
  await logAudit(session, 'rcm: viewed pre-authorisation document', doc.patientId, `preauth=${doc.preauthId} document=${id}`)
  return response
}
