// SP5: generate and release the PDF lab report of a requisition (no body). The release runs in
// one transaction (src/lib/queries/lab-reports.ts); the patient notice and the follow-up notice
// are sent only after it has committed, with a stable dedupe key, and never fail the request.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { brand } from '@/lib/brand'
import { LAB_REPORT_RELEASE_ROLES } from '@/lib/role-policy'
import { releaseLabReport } from '@/lib/queries/lab-reports'
import { notifyPatientSafely } from '@/lib/queries/notifications'
import { notifyFollowUpSafely } from '@/lib/follow-ups/notifier'
import { errorResponse, labServerError, parseId } from '@/lib/labs/route-responses'

const RELEASE_ERROR = {
  not_found: [404, 'Lab requisition not found'],
  nothing_to_report: [409, 'No verified results to report yet.'],
  stale: [409, 'Results changed while the report was being generated. Please try again.'],
} as const

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_REPORT_RELEASE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const requisitionId = parseId((await params).id)
  if (requisitionId === null) return errorResponse(400, 'Invalid requisition id')

  let result: Awaited<ReturnType<typeof releaseLabReport>>
  try {
    result = await releaseLabReport(requisitionId, session)
  } catch (err) {
    return labServerError('lab report release', err, 'Could not release the lab report')
  }
  if (!result.ok) {
    const [status, message] = RELEASE_ERROR[result.error]
    return errorResponse(status, message)
  }

  // After commit. Each never throws.
  const { report, followUp } = result
  await notifyPatientSafely(session, {
    patientId: report.patientId,
    templateKey: 'lab_report_ready',
    vars: { hospitalName: brand.name },
    related: { type: 'lab_report', id: report.id },
    dedupeKey: `lab_report_ready:report=${report.id}`,
  })
  if (followUp.outcome === 'created' && followUp.followUpOrderId !== null && followUp.dueDate !== null) {
    await notifyFollowUpSafely(session, { kind: 'planned', followUpOrderId: followUp.followUpOrderId, patientId: report.patientId, dueDate: followUp.dueDate, appointmentStartsAt: null })
  }

  return NextResponse.json({ report: { id: report.id, reportNumber: report.reportNumber, version: report.version }, followUp }, { status: 201 })
}
