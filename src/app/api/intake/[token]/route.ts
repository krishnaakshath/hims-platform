import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { formSubmissions } from '@/db/schema'
import { and, eq, ne } from 'drizzle-orm'
import { getIntakePortalData, getSubmissionPatientIdByToken } from '@/lib/queries/intake-portal'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'
import { recordFormChartDiscrepancies } from '@/lib/queries/discrepancies'
import { recordFormSubmissionScore } from '@/lib/queries/form-submission-scoring'
import { countUnsignedConsentsByToken } from '@/lib/queries/form-submission-consents'

// Deliberately NOT requireSession()-gated -- a referred patient has no staff
// account. Authorization here is possession of the unguessable token itself,
// checked inside getIntakePortalData/getSubmissionPatientIdByToken (expired
// or completed submissions refuse access regardless of who holds the link).
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const data = await getIntakePortalData(token)
  // Log only when the token actually resolves to a patient -- a not_found
  // or already-expired token has no patientId to attribute the row to, and
  // logging an audit-log-free-text scan of dead tokens isn't useful signal.
  const patientId = await getSubmissionPatientIdByToken(token)
  if (patientId) await logPatientPortalAction('viewed intake form via patient portal', patientId)
  return NextResponse.json(data)
}

const submitSchema = z.object({
  answers: z.record(z.string(), z.string()),
  complete: z.boolean(),
}).strict()

export async function PUT(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const patientId = await getSubmissionPatientIdByToken(token)
  if (!patientId) return NextResponse.json({ error: 'This link is no longer valid.' }, { status: 404 })

  const parsed = submitSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid submission', details: parsed.error.flatten() }, { status: 400 })

  // Completion gate: every attached consent must be signed before the packet
  // can be marked completed. Partial saves (complete: false) are unaffected --
  // a patient can answer half the questions and come back before signing
  // anything (spec §6). Re-run on every completion attempt; the conditional
  // UPDATE below remains the separate write-time race guard.
  if (parsed.data.complete && (await countUnsignedConsentsByToken(token)) > 0) {
    return NextResponse.json({ error: 'This form has unsigned consent documents' }, { status: 400 })
  }

  const status = parsed.data.complete ? 'completed' : 'partial'
  const completedDate = parsed.data.complete ? new Date() : null
  // Re-check status !== 'completed' in the same statement as the write --
  // the earlier getSubmissionPatientIdByToken check and this update are two
  // separate round-trips, so a second, near-simultaneous PUT could otherwise
  // slip through between them and overwrite an already-completed submission.
  const updated = await getDb()
    .update(formSubmissions)
    .set({ answers: parsed.data.answers, status, completedDate })
    .where(and(eq(formSubmissions.accessToken, token), ne(formSubmissions.status, 'completed')))
    .returning({ id: formSubmissions.id })
  if (updated.length === 0) return NextResponse.json({ error: 'This link is no longer valid.' }, { status: 404 })

  await invalidateCache(patientDetailCacheKey(patientId))
  await logPatientPortalAction(parsed.data.complete ? 'completed intake form via patient portal' : 'saved partial progress via patient portal', patientId)

  if (parsed.data.complete) {
    await recordFormSubmissionScore(updated[0].id)
    const discrepancyCount = await recordFormChartDiscrepancies(updated[0].id)
    if (discrepancyCount > 0) await logPatientPortalAction(`form answers flagged ${discrepancyCount} discrepancy(ies) against chart data`, patientId)
  }

  return NextResponse.json({ ok: true })
}
