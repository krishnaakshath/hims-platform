import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { POLICY_WRITE_ROLES } from '@/lib/role-policy'
import { uploadPolicyCard } from '@/lib/queries/rcm-policies'
import { parseId, rcmError, rcmErrorResponse, rcmServerError, readUpload } from '@/lib/rcm/route-responses'

// SP7: upload the front or back image of a policy card (multipart `side` + `file`; PDF/JPEG/PNG ≤ 4 MB).
// The stored blob URL is never returned.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!POLICY_WRITE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const upload = await readUpload(request)
  if (!upload.ok) return upload.response
  const side = upload.fields.side
  if (side !== 'front' && side !== 'back') return rcmError(400, 'Choose the front or back of the card')
  const id = parseId((await params).id)
  if (id === null) return rcmError(400, 'Invalid policy id')

  try {
    const bytes = new Uint8Array(await upload.file.arrayBuffer())
    const r = await uploadPolicyCard(id, side, { bytes, contentType: upload.file.type }, session)
    if (!r.ok) return rcmErrorResponse(r)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return rcmServerError('upload policy card', err, 'Could not store the card image')
  }
}
