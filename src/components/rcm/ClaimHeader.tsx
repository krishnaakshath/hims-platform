import { formatPaise } from '@/lib/format'
import { formatIsoDate } from '@/lib/india-time'
import { CLAIM_STATUS_LABEL } from '@/lib/rcm/claim-status'
import type { ClaimWorkspace } from '@/lib/queries/claim-workspace'
import { SlaBadges } from './SlaBadges'

export const CODING_DRIFT_MESSAGE = 'Coding changed after the last submission; it must be finalised again before the next version'

export function ClaimHeader({ ws }: { ws: ClaimWorkspace }) {
  const { claim, patient, policy, payer, money } = ws
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{claim.claimNumber}</h1>
          <p className="text-sm text-muted-foreground">{CLAIM_STATUS_LABEL[claim.status]} · {claim.claimType.toUpperCase()} · {payer.name}{claim.insurerClaimReference ? ` · insurer ref ${claim.insurerClaimReference}` : ''}</p>
          <div className="mt-1"><SlaBadges flags={ws.slaFlags} /></div>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-right text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-muted-foreground">Claimed</dt><dd className="tabular-nums">{formatPaise(money.claimedPaise)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Approved</dt><dd className="tabular-nums">{money.approvedPaise === null ? '—' : formatPaise(money.approvedPaise)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Settled</dt><dd className="tabular-nums">{formatPaise(money.settledPaise)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Insurer outstanding</dt><dd className="tabular-nums">{formatPaise(money.insurerOutstandingPaise)}</dd></div>
        </dl>
      </div>
      <div className="grid gap-2 text-sm sm:grid-cols-2">
        <p><span className="text-muted-foreground">Patient:</span> {patient.name} · {patient.uhid ?? '—'} · {patient.gender ?? '—'} · {patient.ageYears ?? '—'} y{patient.abhaNumber ? ` · ABHA ${patient.abhaNumber}` : ''}</p>
        {policy && <p><span className="text-muted-foreground">Policy:</span> {policy.insurer.name}{policy.tpa ? ` via ${policy.tpa.name}` : ''} · {policy.policyNumber} / {policy.memberId} · {formatIsoDate(policy.validFrom)}–{formatIsoDate(policy.validTo)}</p>}
        {ws.preauth && <p><span className="text-muted-foreground">Pre-auth:</span> {ws.preauth.preauthNumber} · {ws.preauth.approvedPaise === null ? '—' : formatPaise(ws.preauth.approvedPaise)}</p>}
      </div>
      {ws.codingDrift.drifted && <p role="alert" className="rounded-md bg-amber-500/10 p-2 text-sm text-amber-800">{CODING_DRIFT_MESSAGE}</p>}
    </section>
  )
}
