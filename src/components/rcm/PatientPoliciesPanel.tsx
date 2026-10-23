'use client'
import { EligibilityCheckPanel } from '@/components/nhcx/EligibilityCheckPanel' // SP8
import { useState } from 'react'
import { CoverageBadge } from '@/components/insurance/CoverageBadge' // WS12 T4
import { ManualVerificationDialog } from '@/components/insurance/ManualVerificationDialog' // WS12 T4
import { VerificationHistory } from '@/components/insurance/VerificationHistory' // WS12 T4
import type { PolicyCoverage } from '@/lib/queries/coverage' // WS12 T4 (type only)
import { formatPaise } from '@/lib/format'
import { formatIsoDate } from '@/lib/india-time'
import type { PolicyInput } from '@/lib/rcm/validation'
import type { PolicyView } from '@/lib/queries/rcm-policies'
import { PolicyCardUpload } from './PolicyCardUpload'
import { PolicyForm, type PayerOption } from './PolicyForm'
import { buttonClass, secondaryButtonClass } from './ui'

export const LEGACY_PREFILL_NOTICE = 'Older insurance details are on file. Use them to start a policy?'

// SP8: NHCX eligibility per active, in-date policy (NHCX_ELIGIBILITY_ROLES; the page passes it only for them).
export type PolicyEligibilityProps = {
  nhcxConfigured: boolean; providers: { id: number; name: string }[]; defaultProviderId: number | null
  payerOnNhcx: Record<number, boolean>; context: 'registration' | 'manual'
}

// WS12 T4: each policy's verdict, current verification and history (COVERAGE_READ_ROLES), and
// "Record manual verification" for COVERAGE_VERIFY_ROLES. `onNhcx` is per policy id.
export type PolicyCoverageProps = { policies: PolicyCoverage[]; onNhcx: Record<number, boolean>; nhcxAvailable: boolean; canVerify: boolean }

export const NOT_ON_NHCX_MESSAGE = 'This insurer is not on NHCX: confirm cover with the insurer or TPA, then record it here'
export const NHCX_NOT_CONFIGURED_MESSAGE = 'NHCX not configured: record a manual verification'

export function PatientPoliciesPanel({ patientId, policies, payers, canEdit, legacyPrefill, todayIso, eligibility, coverage }: {
  patientId: string; policies: PolicyView[]; payers: PayerOption[]; canEdit: boolean; legacyPrefill: Partial<PolicyInput> | null; todayIso: string
  eligibility?: PolicyEligibilityProps; coverage?: PolicyCoverageProps
}) {
  const [adding, setAdding] = useState<Partial<PolicyInput> | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const [verifying, setVerifying] = useState<number | null>(null)
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Insurance policies</h2>
        {canEdit && adding === null && <button type="button" className={secondaryButtonClass} onClick={() => setAdding({})}>Add policy</button>}
      </div>
      {canEdit && legacyPrefill && policies.length === 0 && adding === null && (
        <p className="rounded-md bg-amber-500/10 p-2 text-sm text-amber-800">{LEGACY_PREFILL_NOTICE} <button type="button" className="underline" onClick={() => setAdding(legacyPrefill)}>Use them</button></p>
      )}
      {adding !== null && <PolicyForm patientId={patientId} payers={payers} initial={adding} onDone={() => setAdding(null)} />}
      {policies.length === 0 && adding === null && <p className="text-sm text-muted-foreground">No policy on file.</p>}
      <ul className="space-y-2">
        {policies.map((p) => (
          <li key={p.id} className="rounded-md border border-border p-3 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-medium">{p.insurer.name}{p.tpa ? ` via ${p.tpa.name}` : ''} <span className="text-xs text-muted-foreground">({p.priority}, {p.status})</span>
                  {p.validTo < todayIso && <span className="ml-1 rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] text-red-700">Expired</span>}</p>
                <p className="text-xs text-muted-foreground">Policy {p.policyNumber} · member {p.memberId}{p.planName ? ` · ${p.planName}` : ''} · {formatIsoDate(p.validFrom)}–{formatIsoDate(p.validTo)}{p.sumInsuredPaise !== null ? ` · sum insured ${formatPaise(p.sumInsuredPaise)}` : ''}</p>
              </div>
              {canEdit && editing !== p.id && <button type="button" className={secondaryButtonClass} onClick={() => setEditing(p.id)}>Edit</button>}
              {eligibility && p.status === 'active' && p.validFrom <= todayIso && p.validTo >= todayIso && (
                <div className="w-full">
                  <EligibilityCheckPanel policyId={p.id} context={eligibility.context} providers={eligibility.providers} defaultProviderId={eligibility.defaultProviderId}
                    nhcxConfigured={eligibility.nhcxConfigured} payerOnNhcx={eligibility.payerOnNhcx[p.id] ?? false} />
                </div>
              )}
            </div>
            {coverage && <PolicyCoverageBlock p={p} c={coverage.policies.find((c) => c.policyId === p.id) ?? null} coverage={coverage} todayIso={todayIso}
              verifying={verifying === p.id} onVerify={(open) => setVerifying(open ? p.id : null)} />}
            <div className="mt-2 flex gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- streamed from an authenticated route, not a static asset */}
              {p.hasCardFront && <img src={`/api/rcm/policies/${p.id}/card/front`} alt="Policy card front" className="h-16 rounded border border-border" />}
              {/* eslint-disable-next-line @next/next/no-img-element -- streamed from an authenticated route, not a static asset */}
              {p.hasCardBack && <img src={`/api/rcm/policies/${p.id}/card/back`} alt="Policy card back" className="h-16 rounded border border-border" />}
            </div>
            {canEdit && <PolicyCardUpload policyId={p.id} />}
            {editing === p.id && (
              <PolicyForm patientId={patientId} payers={payers} policyId={p.id} onDone={() => setEditing(null)} initial={{
                insurerPayerId: p.insurer.payerId, tpaPayerId: p.tpa?.payerId ?? null, policyNumber: p.policyNumber, memberId: p.memberId, planName: p.planName ?? undefined,
                policyType: p.policyType, corporateName: p.corporateName ?? undefined, holderName: p.holderName, relationship: p.relationship, validFrom: p.validFrom, validTo: p.validTo,
                sumInsuredPaise: p.sumInsuredPaise, copayBp: p.copayBp, roomRentLimitPaise: p.roomRentLimitPaise, icuLimitPaise: p.icuLimitPaise, priority: p.priority, status: p.status,
              }} />
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function PolicyCoverageBlock({ p, c, coverage, todayIso, verifying, onVerify }: {
  p: PolicyView; c: PolicyCoverage | null; coverage: PolicyCoverageProps; todayIso: string; verifying: boolean; onVerify: (open: boolean) => void
}) {
  if (!c) return null
  const onNhcx = coverage.onNhcx[p.id] ?? false
  // Manual is the primary path when NHCX cannot answer for this policy.
  const manualFirst = !onNhcx || !coverage.nhcxAvailable
  const guidance = !onNhcx ? NOT_ON_NHCX_MESSAGE : !coverage.nhcxAvailable ? NHCX_NOT_CONFIGURED_MESSAGE : null
  // A manual verification cannot be recorded for a policy that has already ended (the server refuses it too).
  const canRecord = coverage.canVerify && p.validTo >= todayIso
  return (
    <div className="mt-2 space-y-2 border-t border-border pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <CoverageBadge verdict={c.verdict} />
        {c.verdict.detail && <span className="text-xs text-muted-foreground">{c.verdict.detail}</span>}
      </div>
      <VerificationHistory policyId={p.id} current={c.current} history={c.history} />
      {canRecord && (
        <div className="space-y-1">
          {manualFirst && guidance && <p className="text-xs text-amber-800">{guidance}</p>}
          {!verifying && (
            <button type="button" data-variant={manualFirst ? 'primary' : 'secondary'} className={manualFirst ? buttonClass : secondaryButtonClass} onClick={() => onVerify(true)}>
              Record manual verification
            </button>
          )}
          {verifying && (
            <div className="space-y-1">
              <ManualVerificationDialog policyId={p.id} insurerName={p.insurer.name} policyValidTo={p.validTo} todayIso={todayIso} onSaved={() => onVerify(false)} />
              <button type="button" className={secondaryButtonClass} onClick={() => onVerify(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
