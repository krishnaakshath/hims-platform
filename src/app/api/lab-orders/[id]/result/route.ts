// SP5: staff result entry/amendment (labs + admin; pi verifies instead) through the lifecycle
// query, which audits on its own transaction.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { LAB_RESULT_ENTRY_ROLES } from '@/lib/role-policy'
import { labResultSchema } from '@/lib/labs/validation'
import { recordLabResult } from '@/lib/queries/lab-lifecycle'
import { errorResponse, invalidBody, labServerError, labTransitionError, parseId, readJsonBody } from '@/lib/labs/route-responses'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_RESULT_ENTRY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = labResultSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'Invalid result payload')
  const orderId = parseId((await params).id)
  if (orderId === null) return errorResponse(400, 'Invalid order id')

  let result: Awaited<ReturnType<typeof recordLabResult>>
  try {
    result = await recordLabResult(orderId, parsed.data, { kind: 'staff', session })
  } catch (err) {
    return labServerError('lab result', err, 'Could not save the result')
  }
  // patient_mismatch needs an expected patient, which only the LIS webhook passes.
  if (!result.ok) return labTransitionError(result.error === 'patient_mismatch' ? 'invalid_status' : result.error)
  return NextResponse.json({ ok: true })
}
