import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { DOCUMENT_READ_ROLES, PATIENT_DIRECTORY_ROLES, PORTAL_SUBMISSION_REVIEW_ROLES, RCM_ROLES } from '@/lib/role-policy'
import { listPendingPortalSubmissions } from '@/lib/queries/portal-submissions'
import { listRcmPayers } from '@/lib/queries/rcm-payers'
import { INSURER_SIDE_KINDS } from '@/lib/rcm/constants'
import { PortalSubmissionQueue } from '@/components/front-desk/PortalSubmissionQueue'

// WS7 T9 (spec D15): policies and ABHA numbers patients added from the portal, waiting for a
// reviewer. Staff stay the gatekeepers of master data: approving writes the real policy (or records
// the ABHA, not verified with ABDM); rejecting sends the patient the reason.
export default async function PortalSubmissionsPage() {
  const session = await requireSessionOrRedirect()
  if (!PORTAL_SUBMISSION_REVIEW_ROLES.includes(session.role)) redirect('/')

  const [rows, payers] = await Promise.all([listPendingPortalSubmissions(session.role), listRcmPayers()])
  await logAudit(session, 'viewed portal submissions', null, `count=${rows.length}`)
  const canOpenCard = DOCUMENT_READ_ROLES.includes(session.role)
  // WS7 T16: the "Open policy" toast link goes to a page this role can open: the RCM policies page,
  // else the chart's Insurance tab.
  const policyHrefFor = (patientId: string) => RCM_ROLES.includes(session.role)
    ? `/rcm/policies?patientId=${encodeURIComponent(patientId)}`
    : PATIENT_DIRECTORY_ROLES.includes(session.role) ? `/patients/${encodeURIComponent(patientId)}?tab=insurance` : null
  const insurers = payers.filter((p) => p.profile && INSURER_SIDE_KINDS.includes(p.profile.kind)).map((p) => ({ payerId: p.payerId, name: p.name }))
  const tpas = payers.filter((p) => p.profile?.kind === 'tpa').map((p) => ({ payerId: p.payerId, name: p.name }))

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold text-foreground">Portal submissions</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Insurance policies and ABHA numbers patients added from the patient portal, oldest first. Check each against the card before approving.
      </p>
      <PortalSubmissionQueue
        rows={rows.map((r) => ({
          id: r.id, kind: r.kind, patientName: r.patientName, uhid: r.uhid, submittedAt: r.submittedAt.toISOString(), details: r.details,
          hasCard: r.hasCard, cardHref: canOpenCard && r.documentId !== null ? `/api/documents/${r.documentId}/download` : null,
          policyHref: r.kind === 'policy' ? policyHrefFor(r.patientId) : null,
        }))}
        insurers={insurers}
        tpas={tpas}
      />
    </div>
  )
}
