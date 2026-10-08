import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { RCM_SETTINGS_ROLES } from '@/lib/role-policy'
import { rcmSettingsSchema } from '@/lib/rcm/validation'
import { updateHospitalIdentifiers } from '@/lib/queries/rcm-payers'
import { invalid, rcmErrorResponse, rcmServerError, readJsonBody } from '@/lib/rcm/route-responses'

// SP7: the hospital ROHINI and HFR identifiers printed on every claim (admin only).
export async function PUT(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!RCM_SETTINGS_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = rcmSettingsSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid hospital identifiers')

  try {
    const r = await updateHospitalIdentifiers(parsed.data, session)
    if (!r.ok) return rcmErrorResponse(r)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return rcmServerError('hospital identifiers', err, 'Could not save the identifiers')
  }
}
