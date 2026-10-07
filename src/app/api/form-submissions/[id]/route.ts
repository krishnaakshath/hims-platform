import { NextRequest, NextResponse } from 'next/server'
import { parseId, readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { formSubmissions } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { getFormSubmission } from '@/lib/queries/form-submissions'
import { maybeAutoClassify } from '@/lib/auto-classify'
import { recordFormChartDiscrepancies } from '@/lib/queries/discrepancies'
import { getLatestSignatureForSignable } from '@/lib/queries/signatures'
import { recordFormSubmissionScore } from '@/lib/queries/form-submission-scoring'
import { countUnsignedConsentsBySubmissionId } from '@/lib/queries/form-submission-consents'

const updateSubmissionSchema = z.object({
  status: z.enum(['sent', 'partial', 'completed']),
  answers: z.record(z.string(), z.string()).optional(),
}).strict()

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  const numericId = parseId(id)
  if (numericId === null) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const submission = await getFormSubmission(numericId)
  if (!submission) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await logAudit(session, `viewed client form ${id}`, submission.patientId)
  return NextResponse.json(submission)
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = updateSubmissionSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid submission update', details: parsed.error.flatten() }, { status: 400 })

  const numericId = parseId(id)
  if (numericId === null) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const existing = await getFormSubmission(numericId)
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Mirrors the patient-portal sign route's gate: a consent-category
  // submission may only reach 'completed' with a real signature attached.
  // This staff-side route never creates a signature itself (that's a
  // patient-portal-only action), so it can only require one to already
  // exist -- closing off the previously-unenumerated hole where any
  // authenticated staff member could mark a consent form completed with no
  // attestation at all, staff or patient.
  if (parsed.data.status === 'completed' && existing.category === 'Consent Forms') {
    const signature = await getLatestSignatureForSignable('form_submission', numericId)
    if (!signature) return NextResponse.json({ error: 'This consent form must be signed before it can be marked completed' }, { status: 400 })
  }

  // Same gate as PUT /api/intake/[token]: every consent document attached to
  // this packet at send time must be signed before staff can mark it
  // completed -- otherwise this route would bypass the patient-side gate.
  if (parsed.data.status === 'completed' && (await countUnsignedConsentsBySubmissionId(numericId)) > 0) {
    return NextResponse.json({ error: 'This form has unsigned consent documents' }, { status: 400 })
  }

  const completedDate = parsed.data.status === 'completed' ? new Date() : null
  await getDb().update(formSubmissions).set({ ...parsed.data, completedDate }).where(eq(formSubmissions.id, numericId))

  if (parsed.data.status === 'completed') {
    await logAudit(session, 'completed intake form', existing.patientId)
    await maybeAutoClassify(existing.patientId, session)
    await recordFormSubmissionScore(numericId)
    const discrepancyCount = await recordFormChartDiscrepancies(numericId)
    if (discrepancyCount > 0) await logAudit(session, `form answers flagged ${discrepancyCount} discrepancy(ies) against chart data`, existing.patientId)
  } else {
    await logAudit(session, `updated intake form status to ${parsed.data.status}`, existing.patientId)
  }

  return NextResponse.json({ ok: true })
}
