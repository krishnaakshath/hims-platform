'use client'
import { useState } from 'react'
import { formatPaise } from '@/lib/format'
import { formatIsoDate } from '@/lib/india-time'
import type { PolicyInput } from '@/lib/rcm/validation'
import type { PolicyView } from '@/lib/queries/rcm-policies'
import { PolicyCardUpload } from './PolicyCardUpload'
import { PolicyForm, type PayerOption } from './PolicyForm'
import { secondaryButtonClass } from './ui'

export const LEGACY_PREFILL_NOTICE = 'Older insurance details are on file. Use them to start a policy?'

export function PatientPoliciesPanel({ patientId, policies, payers, canEdit, legacyPrefill, todayIso }: {
  patientId: string; policies: PolicyView[]; payers: PayerOption[]; canEdit: boolean; legacyPrefill: Partial<PolicyInput> | null; todayIso: string
}) {
  const [adding, setAdding] = useState<Partial<PolicyInput> | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
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
            </div>
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
                sumInsuredPaise: p.sumInsuredPaise, copayBp: p.copayBp, roomRentLimitPaise: p.roomRentLimitPaise, priority: p.priority, status: p.status,
              }} />
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
