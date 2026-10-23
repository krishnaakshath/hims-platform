import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { RETRY_MESSAGE, isRetryableConflict, pgErrorCode } from '@/lib/db-errors'
import { invalidIdResponse, parseId, readJsonBody } from '@/lib/http'
import { loadAdmissionDues, recordDuesClearance } from '@/lib/queries/admission-dues'
import { BILLING_AUTHORITY_ROLES, DUES_VIEW_ROLES } from '@/lib/role-policy'

// WS3 T5: an admission's discharge dues (spec 3.2 item 13). GET shows them to the desks that
// move a patient out (DUES_VIEW_ROLES); POST is billing's clearance (BILLING_AUTHORITY_ROLES),
// append-only, with an override reason when dues are outstanding. Fixed messages; the reason is
// stored but never audited or echoed.
const clearanceSchema = z.object({ overrideReason: z.string().trim().min(10).max(500).optional() }).strict()

function logFailure(what: string, err: unknown) {
  console.error(`[dues clearance] ${what} failed (${err instanceof Error ? err.constructor.name : 'unknown'}, code ${pgErrorCode(err) ?? 'unknown'})`)
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!DUES_VIEW_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const admissionId = parseId((await params).id)
  if (admissionId === null) return invalidIdResponse()

  try {
    const loaded = await loadAdmissionDues(admissionId)
    if (!loaded) return NextResponse.json({ error: 'Admission not found', code: 'not_found' }, { status: 404 })
    return NextResponse.json(loaded)
  } catch (err) {
    logFailure('read', err)
    return NextResponse.json({ error: 'Could not load the dues' }, { status: 500 })
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!BILLING_AUTHORITY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const admissionId = parseId((await params).id)
  if (admissionId === null) return invalidIdResponse()

  const json = await readJsonBody(request, { emptyAs: {} })
  if (!json.ok) return json.response
  const parsed = clearanceSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid clearance payload' }, { status: 400 })

  try {
    const result = await recordDuesClearance(admissionId, parsed.data.overrideReason ?? null, session)
    if (!result.ok) {
      switch (result.error) {
        case 'not_found': return NextResponse.json({ error: 'Admission not found', code: 'not_found' }, { status: 404 })
        case 'not_admitted': return NextResponse.json({ error: 'This patient has already been discharged.', code: 'not_admitted' }, { status: 409 })
        case 'reason_required': return NextResponse.json({ error: 'Dues are outstanding. Give a reason to override them.', code: 'reason_required' }, { status: 422 })
      }
    }
    return NextResponse.json({ clearance: result.clearance }, { status: 201 })
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    logFailure('write', err)
    return NextResponse.json({ error: 'Could not record the clearance' }, { status: 500 })
  }
}
