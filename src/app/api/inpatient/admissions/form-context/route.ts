// WS3 T3: GET /api/inpatient/admissions/form-context?patientId= -- the admission dialog's data for
// one patient (free beds, payer choices, open OPD visit, deposit hint). ADMISSION_ROLES only.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { pgErrorCode } from '@/lib/db-errors'
import { loadAdmissionFormContext } from '@/lib/queries/admission-form-context'
import { ADMISSION_ROLES } from '@/lib/role-policy'

// A chart id or a UHID, as the admission POST accepts.
const querySchema = z.object({ patientId: z.string().trim().min(1).max(40) }).strict()

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ADMISSION_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: 'Choose a patient first', code: 'invalid_query' }, { status: 400 })

  try {
    const context = await loadAdmissionFormContext(parsed.data.patientId)
    if (!context) return NextResponse.json({ error: 'Patient not found', code: 'patient_not_found' }, { status: 404 })
    await logAudit(session, 'viewed admission form', context.patient.id)
    return NextResponse.json(context)
  } catch (err) {
    console.error(`[admission form context] failed (${err instanceof Error ? err.constructor.name : 'unknown'}, code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not load the admission form' }, { status: 500 })
  }
}
