// SP5: staff result entry/amendment (labs + admin; pi verifies instead) through the lifecycle
// query, which audits on its own transaction. WS4 T9: a test with analytes takes one value per
// analyte; its refusals are 422 with a stable code. Every result write drops today's lab KPIs.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { LAB_RESULT_ENTRY_ROLES } from '@/lib/role-policy'
import { labResultSchema } from '@/lib/labs/validation'
import { recordLabResult } from '@/lib/queries/lab-lifecycle'
import { analyteEntryError, errorResponse, invalidBody, labServerError, labTransitionError, parseId, readJsonBody } from '@/lib/labs/route-responses'
import { invalidateLabKpis } from '@/lib/queries/hospital-kpis' // WS4 T9

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
  if (!result.ok) {
    const e = result.error
    // patient_mismatch needs an expected patient, which only the LIS webhook passes.
    if (e === 'not_found' || e === 'invalid_status' || e === 'patient_mismatch') return labTransitionError(e === 'patient_mismatch' ? 'invalid_status' : e)
    return analyteEntryError(e, 'analyteId' in result ? result.analyteId : undefined)
  }
  await invalidateLabKpis()
  return NextResponse.json({ ok: true })
}
