import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { COVERAGE_READ_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { streamPrivateBlob } from '@/lib/blob-store'
import { getVerificationDocumentBlob } from '@/lib/queries/coverage'
import { parseId, rcmError, rcmServerError } from '@/lib/rcm/route-responses'

// WS12 T3: stream a manual verification's confirmation document inline (audited after a
// successful read). The blob URL never leaves the server.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!COVERAGE_READ_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const id = parseId((await params).id)
  if (id === null) return rcmError(400, 'Invalid verification id')

  try {
    const doc = await getVerificationDocumentBlob(id)
    if (!doc) return rcmError(404, 'Verification document not found')
    const response = await streamPrivateBlob(doc.url, { filename: `verification-${id}.${doc.extension}`, disposition: 'inline' })
    if (!response) return rcmError(404, 'Stored file is missing')
    await logAudit(session, 'insurance: viewed verification document', doc.patientId, `verification=${id} policy=${doc.policyId}`)
    return response
  } catch (err) {
    return rcmServerError('view verification document', err, 'Could not open the document')
  }
}
