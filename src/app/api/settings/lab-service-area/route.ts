import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { LAB_SETUP_ROLES } from '@/lib/role-policy'
import { servicePinsRequestSchema } from '@/lib/labs/validation'
import { parsePinList } from '@/lib/labs/service-area'
import { addServiceAreaPins } from '@/lib/queries/lab-setup'
import { errorResponse, invalidBody, labServerError, readJsonBody } from '@/lib/labs/route-responses'

// SP5 Settings → Lab setup: add PIN codes to the home-collection service area (Ruling 3).
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_SETUP_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = servicePinsRequestSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'Invalid PIN list')

  const { pins, invalid } = parsePinList(parsed.data.pins)
  if (invalid.length > 0) return NextResponse.json({ error: 'Some PIN codes are not valid', invalid }, { status: 400 })
  if (pins.length === 0) return errorResponse(400, 'Enter at least one 6-digit PIN code')

  try {
    const counts = await addServiceAreaPins(pins, parsed.data.areaLabel || null, session)
    return NextResponse.json(counts)
  } catch (err) {
    return labServerError('service area add', err, 'Could not save the PIN codes')
  }
}
