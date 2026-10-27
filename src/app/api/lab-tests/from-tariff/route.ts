import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { LAB_SETUP_ROLES } from '@/lib/role-policy'
import { labTestsFromTariffSchema } from '@/lib/labs/validation'
import { createLabTestsFromServices, listTariffServicesWithoutTest, type CreateFromServicesError } from '@/lib/queries/lab-catalogue'
import { invalidBody, labServerError, readJsonBody } from '@/lib/labs/route-responses'

// WS4 T13 (spec 3.6 item 27): Settings -> Lab setup -> "Add from tariff". GET lists the active lab,
// imaging and procedure services with no lab test; POST creates one test per picked service.

const REFUSAL: Record<CreateFromServicesError, { status: number; message: string }> = {
  service_not_found: { status: 404, message: 'A picked service no longer exists. Refresh the list and try again.' },
  service_inactive: { status: 422, message: 'A picked service is inactive. Reactivate it in the tariff master first.' },
  already_has_test: { status: 409, message: 'A picked service already has a lab test. Refresh the list and try again.' },
  category_not_orderable: { status: 422, message: 'Only lab, imaging and procedure services can become lab tests.' },
}

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_SETUP_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    return NextResponse.json({ candidates: await listTariffServicesWithoutTest() })
  } catch (err) {
    return labServerError('lab tests from tariff list', err, 'Could not load the tariff services')
  }
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_SETUP_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = labTestsFromTariffSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'Pick between 1 and 50 tariff services')

  try {
    // The admin picked each id explicitly, so a procedure (e.g. ECG) may become a test here.
    const result = await createLabTestsFromServices(parsed.data.serviceIds, session, { allowProcedure: true })
    if (!result.ok) {
      const r = REFUSAL[result.error]
      return NextResponse.json({ error: r.message, code: result.error, serviceId: result.serviceId }, { status: r.status })
    }
    return NextResponse.json({ created: result.created }, { status: 201 })
  } catch (err) {
    return labServerError('lab tests from tariff', err, 'Could not create the lab tests')
  }
}
