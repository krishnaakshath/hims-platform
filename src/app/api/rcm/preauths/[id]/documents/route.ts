import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { RCM_ROLES } from '@/lib/role-policy'
import { uploadPreauthDocument } from '@/lib/queries/preauths'
import { invalid, parseId, rcmError, rcmErrorResponse, rcmServerError, readUpload } from '@/lib/rcm/route-responses'

const metaSchema = z.object({
  kind: z.enum(['preauth_approval', 'query_response', 'other']),
  title: z.string().trim().min(1).max(120),
  queryResponseId: z.string().regex(/^\d{1,10}$/, 'Invalid query response').optional(),
}).strict()

// SP7: upload an approval letter, query reply or other pre-auth document (multipart; PDF/JPEG/PNG ≤ 4 MB).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!RCM_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const upload = await readUpload(request)
  if (!upload.ok) return upload.response
  const meta = metaSchema.safeParse(upload.fields)
  if (!meta.success) return invalid(meta.error, 'Invalid document details')
  const id = parseId((await params).id)
  if (id === null) return rcmError(400, 'Invalid pre-authorisation id')
  const queryResponseId = meta.data.queryResponseId === undefined ? undefined : parseId(meta.data.queryResponseId)
  if (queryResponseId === null) return rcmError(400, 'Invalid query response')

  try {
    const bytes = new Uint8Array(await upload.file.arrayBuffer())
    const r = await uploadPreauthDocument(id, { kind: meta.data.kind, title: meta.data.title, queryResponseId }, { bytes, contentType: upload.file.type }, session)
    if (!r.ok) return rcmErrorResponse(r)
    return NextResponse.json(r.value, { status: 201 })
  } catch (err) {
    return rcmServerError('pre-auth document', err, 'Could not store the document')
  }
}
