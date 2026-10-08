import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { RCM_ROLES } from '@/lib/role-policy'
import { attachLabReportSchema } from '@/lib/rcm/validation'
import { attachLabReport } from '@/lib/queries/claim-documents'
import { invalid, parseId, rcmError, rcmErrorResponse, rcmServerError, readJsonBody } from '@/lib/rcm/route-responses'

// SP7: attach one of the patient's current lab reports to a claim.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!RCM_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = attachLabReportSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid request')
  const id = parseId((await params).id)
  if (id === null) return rcmError(400, 'Invalid claim id')

  try {
    const r = await attachLabReport(id, parsed.data.labReportId, session)
    if (!r.ok) return rcmErrorResponse(r)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return rcmServerError('attach lab report', err, 'Could not save the claim')
  }
}
