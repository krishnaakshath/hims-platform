import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { LAB_SETUP_ROLES } from '@/lib/role-policy'
import { labTestSetupSchema } from '@/lib/labs/validation'
import { updateLabTestSetup } from '@/lib/queries/lab-setup'
import { errorResponse, invalidBody, labServerError, parseId, readJsonBody } from '@/lib/labs/route-responses'

// SP5 Settings → Lab setup: a lab test's sample type, tube and the SP2 tariff service
// (investigation category only) used to quote it.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_SETUP_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = labTestSetupSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'Invalid lab test setup')
  const id = parseId((await params).id)
  if (id === null) return errorResponse(400, 'Invalid lab test id')

  try {
    const result = await updateLabTestSetup(id, parsed.data, session)
    if (!result.ok) {
      switch (result.error) {
        case 'not_found': return errorResponse(404, 'Lab test not found')
        case 'service_not_found': return errorResponse(400, 'Service not found')
        case 'service_not_investigation': return errorResponse(400, 'Pick a lab or imaging investigation service')
      }
    }
    return NextResponse.json({ test: result.test })
  } catch (err) {
    return labServerError('lab test setup', err, 'Could not update the lab test')
  }
}
