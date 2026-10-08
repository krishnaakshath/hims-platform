import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { LAB_SETUP_ROLES } from '@/lib/role-policy'
import { servicePinPatchSchema } from '@/lib/labs/validation'
import { setServiceAreaPinActive } from '@/lib/queries/lab-setup'
import { errorResponse, invalidBody, labServerError, parseId, readJsonBody } from '@/lib/labs/route-responses'

// SP5 Settings → Lab setup: activate or deactivate one service-area PIN (never deleted).
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_SETUP_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = servicePinPatchSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'Invalid PIN change')
  const id = parseId((await params).id)
  if (id === null) return errorResponse(400, 'Invalid PIN id')

  try {
    const pin = await setServiceAreaPinActive(id, parsed.data.isActive, session)
    if (!pin) return errorResponse(404, 'PIN code not found')
    return NextResponse.json({ pin })
  } catch (err) {
    return labServerError('service area change', err, 'Could not update the PIN code')
  }
}
