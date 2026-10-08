// /rcm/preauths/[id]: one pre-authorisation (RCM_ROLES). Audited with the patient id.
import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { RCM_ROLES } from '@/lib/role-policy'
import { parseId } from '@/lib/http'
import { formatPaise } from '@/lib/format'
import { formatIsoDate } from '@/lib/india-time'
import { PREAUTH_STATUS_LABEL } from '@/lib/rcm/preauth-status'
import { PRICE_SOURCE_LABEL } from '@/lib/rcm/constants'
import { getPreauthDetail } from '@/lib/queries/preauths'
import { listReasonCodes } from '@/lib/queries/rcm-payers'
import { PreauthActions } from '@/components/rcm/PreauthActions'
import { PreauthDocumentUpload } from '@/components/rcm/PreauthDocumentUpload'
import { PreauthTimeline } from '@/components/rcm/PreauthTimeline'
// SP8
import { EligibilityCheckPanel } from '@/components/nhcx/EligibilityCheckPanel'
import { listRcmPayers } from '@/lib/queries/rcm-payers'
import { listActiveProviders } from '@/lib/queries/providers'
import { nhcxEligibilityAvailable, payersOnNhcx } from '@/lib/queries/nhcx-eligibility'
import { NHCX_EXCHANGE_ROLES } from '@/lib/role-policy'
import { listExchangesFor, preauthNhcxState } from '@/lib/queries/nhcx-review'
import { NhcxExchangePanel } from '@/components/nhcx/NhcxExchangePanel'

export default async function PreauthPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionOrRedirect()
  if (!RCM_ROLES.includes(session.role)) redirect('/')

  const id = parseId((await params).id)
  if (id === null) notFound()
  const [d, reasons] = await Promise.all([getPreauthDetail(id), listReasonCodes('rejection')])
  if (!d) notFound()
  await logAudit(session, 'rcm: viewed pre-authorisation', d.patient.id, `preauth=${id}`)
  const p = d.preauth
  const openQuery = d.queries.find((q) => q.status === 'open') ?? null
  // SP8: NHCX eligibility on the pre-auth's policy (auth-requirements).
  const [payerRows, activeProviders] = d.policy ? await Promise.all([listRcmPayers(), listActiveProviders()]) : [[], []]
  const [nhcxSend, exchanges] = await Promise.all([preauthNhcxState(id), listExchangesFor({ preauthId: id })])
  const onNhcx = d.policy ? payersOnNhcx([d.policy], new Map(payerRows.map((r) => [r.payerId, r.profile?.nhcxParticipantCode ?? null])))[d.policy.id] ?? false : false
  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border bg-card p-4">
        <h1 className="text-2xl font-bold">{p.preauthNumber}</h1>
        <p className="text-sm text-muted-foreground">{PREAUTH_STATUS_LABEL[p.status]} · {p.claimType.toUpperCase()} · planned {formatIsoDate(p.plannedAdmissionDate)} · {p.expectedLengthOfStayDays} days</p>
        <p className="mt-1 text-sm">{d.patient.name} · {d.patient.uhid ?? '—'} · {d.patient.gender ?? '—'} · {d.patient.ageYears ?? '—'} y{d.policy ? ` · ${d.policy.insurer.name}${d.policy.tpa ? ` via ${d.policy.tpa.name}` : ''} · ${d.policy.policyNumber}` : ''}</p>
        <p className="mt-1 text-sm">Requested {formatPaise(p.requestedPaise)} · Approved {p.approvedPaise === null ? '—' : formatPaise(p.approvedPaise)}{p.approvalReference ? ` · ref ${p.approvalReference}` : ''}{p.validUntil ? ` · valid until ${formatIsoDate(p.validUntil)}` : ''}</p>
        <p className="mt-1 text-xs text-muted-foreground">Diagnoses: {p.diagnoses.map((x) => `${x.code} ${x.display}`).join('; ') || p.provisionalDiagnosisText || '—'} · Procedures: {p.procedures.map((x) => `${x.code} ${x.display}`).join('; ') || '—'}</p>
      </section>
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">Estimate</h2>
        <table className="w-full text-sm"><tbody>{p.estimateLines.map((l) => <tr key={l.serviceId} className="border-t border-border"><td>{l.code} · {l.name}</td><td>× {l.quantity}</td><td>{PRICE_SOURCE_LABEL[l.priceSource] ?? l.priceSource}</td><td className="text-right tabular-nums">{formatPaise(l.amountPaise)}</td></tr>)}</tbody></table>
        <p className="mt-1 text-right text-sm font-semibold">{formatPaise(p.estimatedPaise)}</p>
      </section>
      {d.policy && (
        <section className="rounded-lg border border-border bg-card p-4 text-sm">
          <h2 className="mb-2 font-semibold">Eligibility (NHCX)</h2>
          <EligibilityCheckPanel policyId={d.policy.id} context="preauth" purpose="auth-requirements" providers={activeProviders.map((pr) => ({ id: pr.id, name: pr.name }))}
            defaultProviderId={p.treatingProviderId} nhcxConfigured={nhcxEligibilityAvailable()} payerOnNhcx={onNhcx} />
        </section>
      )}
      <PreauthActions preauthId={id} status={p.status} enhancedBefore={d.events.some((e) => e.action === 'approve_enhancement')} openQueryId={openQuery?.id ?? null} rejectionReasons={reasons.map((r) => ({ value: r.code, label: r.label }))} />
      <section className="rounded-lg border border-border bg-card p-4 text-sm">
        <h2 className="mb-2 font-semibold">Queries</h2>
        {d.queries.length === 0 ? <p className="text-muted-foreground">None.</p> : <ul className="space-y-2">{d.queries.map((q) => <li key={q.id}>{q.question} <span className="text-xs text-muted-foreground">({q.status}, due {formatIsoDate(q.dueOn)})</span>{q.responses.map((r) => <p key={r.id} className="pl-3 text-xs">Reply {formatIsoDate(r.respondedOn)}: {r.body}</p>)}</li>)}</ul>}
      </section>
      <section className="rounded-lg border border-border bg-card p-4 text-sm">
        <h2 className="mb-2 font-semibold">Documents</h2>
        <ul>{d.documents.map((doc) => <li key={doc.id}><a className="text-primary hover:underline" href={`/api/rcm/preauth-documents/${doc.id}`} target="_blank" rel="noreferrer">{doc.title}</a> <span className="font-mono text-xs text-muted-foreground">{doc.sha256.slice(0, 12)}</span></li>)}</ul>
        <PreauthDocumentUpload preauthId={id} />
      </section>
      <NhcxExchangePanel exchanges={exchanges} canAct={NHCX_EXCHANGE_ROLES.includes(session.role)} sendPreauthId={id} canSendPreauth={nhcxSend.canSend} sendReason={nhcxSend.reason} />
      <PreauthTimeline events={d.events} />
    </div>
  )
}
