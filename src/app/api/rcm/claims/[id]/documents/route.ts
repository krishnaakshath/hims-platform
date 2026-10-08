import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { RCM_ROLES } from '@/lib/role-policy'
import { claimDocumentMetaSchema } from '@/lib/rcm/validation'
import { uploadClaimDocument } from '@/lib/queries/claim-documents'
import { invalid, parseId, rcmError, rcmErrorResponse, rcmServerError, readUpload } from '@/lib/rcm/route-responses'

// SP7: upload a claim document (multipart `kind`, `title`, optional `idProofType`/`maskedConfirmed`, `file`).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!RCM_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const upload = await readUpload(request)
  if (!upload.ok) return upload.response
  const meta = claimDocumentMetaSchema.safeParse(upload.fields)
  if (!meta.success) return invalid(meta.error, 'Invalid document details')
  const id = parseId((await params).id)
  if (id === null) return rcmError(400, 'Invalid claim id')

  try {
    const bytes = new Uint8Array(await upload.file.arrayBuffer())
    const r = await uploadClaimDocument(id, meta.data, { bytes, contentType: upload.file.type }, session)
    if (!r.ok) return rcmErrorResponse(r)
    return NextResponse.json(r.value, { status: 201 })
  } catch (err) {
    return rcmServerError('upload claim document', err, 'Could not store the document')
  }
}
