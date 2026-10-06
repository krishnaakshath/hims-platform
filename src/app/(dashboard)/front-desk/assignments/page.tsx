import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listAllAssignments } from '@/lib/queries/doctor-assignments'
import { listAllProviders } from '@/lib/queries/providers'
import { AssignmentStatusChip } from '@/components/AssignmentStatusChip'
import { AcknowledgeDeclineButton } from '@/components/AcknowledgeDeclineButton'

export default async function FrontDeskAssignmentsPage() {
  const session = await requireSessionOrRedirect()
  if (!['frontdesk', 'admin', 'crc'].includes(session.role)) redirect('/')

  const [assignments, providers] = await Promise.all([listAllAssignments(), listAllProviders()])
  await logAudit(session, 'viewed front desk assignments', null)

  const providerName = (id: number) => providers.find((p) => p.id === id)?.name ?? `Provider #${id}`

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold text-foreground">Assignments</h1>
      {/* Created automatically by Check-In -- routing a patient to a doctor
          there creates a row here, Pending until that doctor accepts or
          declines it. This page is the running log of every such routing
          decision, not something front desk fills in by hand. */}
      <p className="mb-6 text-sm text-muted-foreground">Doctor routing decisions from Check-In, pending until accepted or declined.</p>
      {assignments.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No assignments yet -- routing a patient to a doctor from Check-In creates one here.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-left">
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Doctor</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Visit Type</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reason</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Action</th>
              </tr>
            </thead>
            <tbody>
              {assignments.map((a, i) => (
                <tr key={a.id} className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''}`}>
                  <td className="p-3 text-foreground">{a.patientId}</td>
                  <td className="p-3 text-foreground">{providerName(a.providerId)}</td>
                  <td className="p-3 text-foreground capitalize">{a.visitType}</td>
                  <td className="p-3 text-foreground">{a.reason}</td>
                  <td className="p-3"><AssignmentStatusChip status={a.status} declineReason={a.declineReason} /></td>
                  <td className="p-3">
                    {a.status === 'declined' && !a.declineAcknowledgedAt && <AcknowledgeDeclineButton assignmentId={a.id} />}
                    {a.status === 'declined' && a.declineAcknowledgedAt && (
                      <span className="text-xs text-muted-foreground">Handled by {a.declineAcknowledgedByName}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
