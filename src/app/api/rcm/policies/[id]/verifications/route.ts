import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { COVERAGE_VERIFY_ROLES } from '@/lib/role-policy'
import { manualVerificationMessage, manualVerificationSchema } from '@/lib/insurance/validation'
import { recordManualVerification } from '@/lib/queries/coverage'
import { parseId, rcmError, rcmErrorResponse, rcmServerError, readUpload } from '@/lib/rcm/route-responses'

// WS12 T3 (R1, R2): record a manual verification of a policy (multipart text fields plus an
// optional `file`: PDF/JPEG/PNG ≤ 4 MB). The patient comes from the policy. With a file and no
// file store the answer is 503 storage_not_configured and nothing is written. The insurer
// reference and the stored blob URL are never returned.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!COVERAGE_VERIFY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const upload = await readUpload(request, { fileOptional: true })
  if (!upload.ok) return upload.response
  const id = parseId((await params).id)
  if (id === null) return rcmError(400, 'Invalid policy id')
  const parsed = manualVerificationSchema.safeParse(upload.fields)
  if (!parsed.success) return rcmError(400, manualVerificationMessage(parsed.error))

  try {
    const file = upload.file ? { bytes: new Uint8Array(await upload.file.arrayBuffer()), contentType: upload.file.type } : null
    const r = await recordManualVerification(id, parsed.data, file, session)
    if (!r.ok) return rcmErrorResponse(r)
    return NextResponse.json({ verificationId: r.value.verificationId }, { status: 201 })
  } catch (err) {
    return rcmServerError('record manual verification', err, 'Could not save the verification')
  }
}
