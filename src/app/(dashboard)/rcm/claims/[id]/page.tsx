// /rcm/claims/[id]: the claim workspace (RCM_ROLES). Audited with the patient id.
import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { RCM_ROLES, WRITE_OFF_APPROVE_ROLES } from '@/lib/role-policy'
import { parseId } from '@/lib/http'
import { getClaimGateway } from '@/lib/rcm/gateway'
import { getClaimWorkspace } from '@/lib/queries/claim-workspace'
import { ClaimHeader } from '@/components/rcm/ClaimHeader'
import { ReadinessPanel } from '@/components/rcm/ReadinessPanel'
import { ClaimInvoicesPanel } from '@/components/rcm/ClaimInvoicesPanel'
import { ClaimDocumentsPanel } from '@/components/rcm/ClaimDocumentsPanel'
import { ClaimVersionsPanel } from '@/components/rcm/ClaimVersionsPanel'
import { SubmitClaimDialog } from '@/components/rcm/SubmitClaimDialog'
import { InsurerUpdateForms } from '@/components/rcm/InsurerUpdateForms'
import { SettlementPanel } from '@/components/rcm/SettlementPanel'
import { WriteOffPanel } from '@/components/rcm/WriteOffPanel'
import { ClaimTimeline } from '@/components/rcm/ClaimTimeline'

export default async function ClaimWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionOrRedirect()
  if (!RCM_ROLES.includes(session.role)) redirect('/')

  const id = parseId((await params).id)
  if (id === null) notFound()
  const ws = await getClaimWorkspace(id, session)
  if (!ws) notFound()
  await logAudit(session, 'rcm: viewed claim', ws.patient.id, `claim=${id}`)

  const status = ws.claim.status
  const open = status !== 'closed' && status !== 'withdrawn'
  const openQuery = ws.queries.find((q) => q.status === 'open') ?? null
  const mode = ws.allowedActions.includes('submit') ? 'submit' as const
    : ws.allowedActions.includes('respond_query') && openQuery ? 'respond_query' as const
    : ws.allowedActions.includes('appeal') ? 'appeal' as const : null
  const readinessForNext = mode === null ? true : ws.readiness.ready
  return (
    <div className="space-y-4">
      <ClaimHeader ws={ws} />
      <div className="grid gap-4 lg:grid-cols-2">
        <ReadinessPanel claimId={id} ready={ws.readiness.ready} items={ws.readiness.items} editable={open} />
        <SubmitClaimDialog claimId={id} mode={mode} ready={readinessForNext} queryId={openQuery?.id ?? null} nhcxLabel={getClaimGateway('nhcx').status().label} />
        <ClaimInvoicesPanel claimId={id} invoices={ws.invoices} editable={status === 'draft'} />
        <ClaimDocumentsPanel claimId={id} documents={ws.documents} editable={open} />
        <ClaimVersionsPanel versions={ws.versions} />
        <InsurerUpdateForms claimId={id} allowedActions={ws.allowedActions.filter((a) => a !== 'submit' && a !== 'respond_query' && a !== 'appeal' && a !== 'record_settlement')} claimedPaise={ws.claim.claimedPaise} reasonCodes={ws.reasonCodes} />
        <SettlementPanel claimId={id} canRecord={ws.allowedActions.includes('record_settlement')} settlements={ws.settlements} approvedPaise={ws.claim.approvedPaise} settledPaise={ws.claim.settledPaise} />
        <WriteOffPanel claimId={id} writeOffs={ws.writeOffs} ceilingPaise={ws.money.writeOffCeilingPaise} canRequest={open} canDecide={WRITE_OFF_APPROVE_ROLES.includes(session.role) && session.userId !== null} viewerUserId={session.userId} reasonCodes={ws.reasonCodes} />
      </div>
      {ws.queries.length > 0 && (
        <section className="rounded-lg border border-border bg-card p-4 text-sm">
          <h2 className="mb-2 font-semibold">Insurer queries</h2>
          <ul className="space-y-2">{ws.queries.map((q) => <li key={q.id}><p>{q.question} <span className="text-xs text-muted-foreground">({q.status}, due {q.dueOn})</span></p>{q.responses.map((r) => <p key={r.id} className="pl-3 text-xs">Reply {r.respondedOn}: {r.body}</p>)}</li>)}</ul>
        </section>
      )}
      <ClaimTimeline events={ws.events} />
    </div>
  )
}
