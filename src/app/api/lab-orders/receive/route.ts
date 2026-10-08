// SP5: receive a sample at the lab bench by its scanned or typed sample ID. The check digit is
// validated BEFORE any query, so a mistyped or swapped ID can never touch another patient's tube.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { LAB_RECEIVE_ROLES } from '@/lib/role-policy'
import { receiveSampleSchema } from '@/lib/labs/validation'
import { parseSampleId } from '@/lib/labs/sample-id'
import { receiveLabSample } from '@/lib/queries/lab-lifecycle'
import { errorResponse, invalidBody, labServerError, labTransitionError, readJsonBody } from '@/lib/labs/route-responses'

const INVALID_SAMPLE_ID = 'That sample ID is not valid. Re-scan or re-type it.'

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_RECEIVE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = receiveSampleSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, INVALID_SAMPLE_ID)
  const sample = parseSampleId(parsed.data.sampleId)
  if (!sample) return errorResponse(400, INVALID_SAMPLE_ID)

  let result: Awaited<ReturnType<typeof receiveLabSample>>
  try {
    result = await receiveLabSample(sample.canonical, session)
  } catch (err) {
    return labServerError('lab receive', err, 'Could not receive the sample')
  }
  if (!result.ok) {
    if (result.error === 'invalid_sample_id') return errorResponse(400, INVALID_SAMPLE_ID)
    if (result.error === 'not_found') return errorResponse(404, 'No lab order has that sample ID.')
    if (result.error === 'already_received') return errorResponse(409, 'This sample has already been received.')
    return labTransitionError(result.error)
  }
  return NextResponse.json({ orderId: result.order.id, sampleId: sample.canonical })
}
