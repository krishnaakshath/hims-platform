// SP5: the collector marks a home visit collected by the sample IDs of the tubes drawn
// (COLLECTOR_ROUTE_ROLES). Every ID is check-digit validated here, before any DB call; the query
// re-validates and does the rest in one transaction (collect, release the rest, lab encounter,
// audit). A collector may act only on a visit assigned to them: `not_assigned` is the plain 403.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { COLLECTOR_ROUTE_ROLES } from '@/lib/role-policy'
import { collectHomeVisitSchema } from '@/lib/labs/validation'
import { displaySampleId, parseSampleId } from '@/lib/labs/sample-id'
import { collectHomeVisit } from '@/lib/queries/home-collections'
import { errorResponse, invalidBody, labServerError, parseId, readJsonBody } from '@/lib/labs/route-responses'
import { INVALID_VISIT_ID, VISIT_NOT_FOUND, forbidden } from '@/lib/home-collection/route-responses'

/** The input as the collector typed it is shown back only after it failed the check digit. */
const invalidSampleId = (input: string) => errorResponse(400, `Sample ID ${input} is not valid. Re-scan or re-type it.`)

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!COLLECTOR_ROUTE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = collectHomeVisitSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'Enter the sample ID of at least one collected tube')
  const visitId = parseId((await params).id)
  if (visitId === null) return errorResponse(400, INVALID_VISIT_ID)

  // Check digit and duplicates before the query (and so before any DB read).
  const seen = new Set<string>()
  for (const input of parsed.data.sampleIds) {
    const sid = parseSampleId(input)
    if (!sid || seen.has(sid.canonical)) return invalidSampleId(input.slice(0, 32))
    seen.add(sid.canonical)
  }

  let result: Awaited<ReturnType<typeof collectHomeVisit>>
  try {
    result = await collectHomeVisit(visitId, parsed.data.sampleIds, session)
  } catch (err) {
    return labServerError('home collection collect', err, 'Could not save the collection')
  }
  if (!result.ok) {
    if (result.error === 'not_assigned') return forbidden()
    if (result.error === 'not_found') return errorResponse(404, VISIT_NOT_FOUND)
    if (result.error === 'invalid_sample_id') return invalidSampleId((result.sampleId ?? '').slice(0, 32))
    if (result.error === 'sample_not_on_visit') {
      return errorResponse(409, `Sample ${displaySampleId(result.sampleId ?? '')} does not belong to this visit. Check the tube label.`)
    }
    return errorResponse(409, 'This visit has already been collected or cancelled.')
  }
  return NextResponse.json(result)
}
