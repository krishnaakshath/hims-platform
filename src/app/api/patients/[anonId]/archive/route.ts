import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { readJsonBody } from '@/lib/http'
import { RETRY_MESSAGE, isRetryableConflict } from '@/lib/db-errors'
import { ARCHIVE_REASON_MAX, ARCHIVE_REASON_MIN, archivePatient } from '@/lib/queries/patient-archive'

// WS8 T13 (spec D17): admin-only archive. The chart and every record stay; it leaves every list,
// search, picker, broadcast audience, queue and portal sign-in. The audit row (written with the
// change, in one transaction) carries only `reason_length=<n>`, never the reason text.
const bodySchema = z.object({
  reason: z.string().trim().min(ARCHIVE_REASON_MIN).max(ARCHIVE_REASON_MAX),
  confirmUhid: z.string().trim().min(1).max(64),
}).strict()

const ERRORS = {
  not_found: { status: 404, message: 'Patient not found' },
  uhid_mismatch: { status: 400, message: 'The UHID you typed does not match this patient.' },
  already_archived: { status: 409, message: 'This patient is already archived.' },
  active_admission: { status: 409, message: 'This patient is currently admitted. Discharge them before archiving.' },
} as const

export async function POST(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = bodySchema.safeParse(json.body)
  if (!parsed.success) {
    return NextResponse.json({ error: `Type the patient's UHID and a reason of ${ARCHIVE_REASON_MIN} to ${ARCHIVE_REASON_MAX} characters.`, code: 'invalid' }, { status: 400 })
  }

  const { anonId } = await params
  try {
    const result = await archivePatient(anonId, parsed.data, session)
    if (!result.ok) {
      const e = ERRORS[result.error]
      return NextResponse.json({ error: e.message, code: result.error }, { status: e.status })
    }
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    throw err
  }
  return NextResponse.json({ ok: true })
}
