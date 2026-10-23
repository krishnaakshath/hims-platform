import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { patientExists } from '@/lib/queries/patient-exists'
import { listActiveProviders } from '@/lib/queries/providers'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
// SP5: the doctor's order is a requisition of one or more tests, priced from the tariff master.
import { brand } from '@/lib/brand'
import { HOME_COLLECTION_BOOKING_ROLES, LAB_ORDER_ROLES, WORKSPACE_READ_ROLES } from '@/lib/role-policy'
import { createLabRequisitionSchema } from '@/lib/labs/validation'
import { createLabRequisition, labOrderBillTo, listEncounterLabOrders, openOpdEncounterFor } from '@/lib/queries/lab-requisitions'
import { getEncounterById } from '@/lib/queries/encounters' // WS2 T10
import { logAudit } from '@/lib/audit' // WS2 T10
import { DEFAULT_TIMEZONE, todayIsoIn } from '@/lib/india-time' // WS2 T10
import { z } from 'zod' // WS2 T10
import { notifyPatientSafely, type NotifyOutcome } from '@/lib/queries/notifications'
import { errorResponse, invalidBody, labServerError, readJsonBody } from '@/lib/labs/route-responses'

const NOT_FOUND_MESSAGE = {
  patient_not_found: 'Patient not found',
  test_not_found: 'Lab test not found',
  encounter_not_found: 'Visit not found',
} as const
// end SP5

export async function POST(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_ORDER_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params
  // SP5: JSON → schema (multi-test body, or the legacy { labTestId }); never a 500 on bad JSON.
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = createLabRequisitionSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'Invalid lab order payload')
  // end SP5

  if (!(await patientExists(anonId))) return NextResponse.json({ error: 'Patient not found' }, { status: 404 })

  // Resolves who ordered this test with the shared acting-provider resolver
  // (resolveDoctorQueueProvider: the users -> staff -> provider FK link
  // first, then an exact-surname match that returns null on ambiguity).
  //
  // A 'pi' session with no resolvable provider fails CLOSED (403) rather
  // than being silently attributed to another clinician (discharge route
  // precedent). Falling back to the first active provider is scoped to
  // 'admin' only, since admin isn't itself a clinical provider but is one of
  // this route's two allowed roles and needs order creation to stay
  // functional -- a demo-appropriate simplification, not identity resolution.
  const activeProviders = await listActiveProviders()
  if (activeProviders.length === 0) {
    return NextResponse.json({ error: 'No active providers available to attribute this order to' }, { status: 409 })
  }
  const providerMatch = await resolveDoctorQueueProvider(session)

  let orderedByProviderId: number
  if (providerMatch) {
    orderedByProviderId = providerMatch.id
  } else if (session.role === 'admin') {
    orderedByProviderId = activeProviders[0].id
  } else {
    return NextResponse.json({ error: 'Could not resolve your provider identity for this session' }, { status: 403 })
  }

  // SP5: one transaction (requisition + orders + audits), then the notice after commit.
  let result: Awaited<ReturnType<typeof createLabRequisition>>
  try {
    // WS2 T10: an order placed outside a visit page belongs to the patient's open OPD visit with
    // the ordering doctor today, if there is one (the order is then billed to that visit).
    const originatingEncounterId = parsed.data.originatingEncounterId
      ?? await openOpdEncounterFor(anonId, orderedByProviderId, todayIsoIn(DEFAULT_TIMEZONE))
    result = await createLabRequisition({ ...parsed.data, originatingEncounterId, patientId: anonId, orderedByProviderId }, session)
  } catch (err) {
    return labServerError('lab requisition create', err, 'Could not order the tests')
  }
  if (!result.ok) {
    if (result.error === 'test_unmapped') return errorResponse(422, 'This test has no price. Map it to a tariff service first.', 'test_unmapped')
    if (result.error === 'test_unpriced') return errorResponse(422, 'This test has no price. Map it to a tariff service first.', 'test_unpriced')
    if (result.error === 'test_inactive') return errorResponse(422, 'This test is not active.', 'test_inactive')
    if (result.error === 'encounter_mismatch') return errorResponse(409, 'That visit belongs to a different patient.')
    return errorResponse(404, NOT_FOUND_MESSAGE[result.error])
  }

  const requisitionId = result.requisition.id
  let notification: NotifyOutcome | 'error' | null = null
  // Imaging-only orders stay orderable but get no home-collection notice (Task 8 ruling).
  if (result.patientIsLocal && result.includesLabTest) {
    notification = await notifyPatientSafely(session, {
      patientId: anonId,
      templateKey: 'lab_tests_ordered',
      vars: { hospitalName: brand.name },
      related: { type: 'lab_requisition', id: requisitionId },
      dedupeKey: `lab_tests_ordered:requisition=${requisitionId}`,
    })
  }
  // WS2 T10: the order lines (one outcome per order) and whether this user can book the home visit now.
  const homeCollectionEligible = result.patientIsLocal && result.includesLabTest && HOME_COLLECTION_BOOKING_ROLES.includes(session.role)
  return NextResponse.json({ requisitionId, lines: result.lines, charges: result.charges, patientIsLocal: result.patientIsLocal, homeCollectionEligible, notification }, { status: 201 })
  // end SP5
}

// WS2 T10: a visit's orders (the workspace Orders panel) and who a new order would be billed to.
const encounterOrdersQuerySchema = z.object({ encounterId: z.coerce.number().int().positive().max(2147483647) }).strict()

export async function GET(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!WORKSPACE_READ_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params
  const parsed = encounterOrdersQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!parsed.success) return errorResponse(400, 'Invalid visit id')
  const { encounterId } = parsed.data
  try {
    const encounter = await getEncounterById(encounterId)
    if (!encounter || encounter.patientId !== anonId) return errorResponse(404, 'Visit not found')
    const [orders, billTo] = await Promise.all([listEncounterLabOrders(encounterId), labOrderBillTo(anonId, encounterId)])
    await logAudit(session, 'viewed visit lab orders', anonId, `encounter=${encounterId}`)
    return NextResponse.json({ orders, billTo })
  } catch (err) {
    return labServerError('visit lab orders', err, 'Could not load the orders')
  }
}
