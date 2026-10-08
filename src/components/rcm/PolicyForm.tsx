'use client'
import { useState } from 'react'
import { parseRupeesToPaise } from '@/lib/format'
import { INSURER_SIDE_KINDS, POLICY_RELATIONSHIPS, POLICY_TYPES, type PayerKind } from '@/lib/rcm/constants'
import { policySchema, type PolicyInput } from '@/lib/rcm/validation'
import { useRcmAction } from './useRcmAction'
import { Field, FormError, buttonClass, inputClass, secondaryButtonClass } from './ui'

export interface PayerOption { payerId: number; name: string; kind: PayerKind }

const rupees = (p: number | null | undefined) => (p === null || p === undefined ? '' : (p / 100).toFixed(2))

/** Add a policy (POST) or edit one (PATCH). Client-side schema check shows the authored messages first. */
export function PolicyForm({ patientId, payers, initial, policyId, onDone }: {
  patientId: string; payers: PayerOption[]; initial?: Partial<PolicyInput>; policyId?: number; onDone?: () => void
}) {
  const insurers = payers.filter((p) => INSURER_SIDE_KINDS.includes(p.kind))
  const tpas = payers.filter((p) => p.kind === 'tpa')
  const [v, setV] = useState({
    insurerPayerId: String(initial?.insurerPayerId ?? insurers[0]?.payerId ?? ''), tpaPayerId: initial?.tpaPayerId ? String(initial.tpaPayerId) : '',
    policyNumber: initial?.policyNumber ?? '', memberId: initial?.memberId ?? '', planName: initial?.planName ?? '', policyType: initial?.policyType ?? 'individual',
    corporateName: initial?.corporateName ?? '', employeeId: initial?.employeeId ?? '', holderName: initial?.holderName ?? '', relationship: initial?.relationship ?? 'self',
    validFrom: initial?.validFrom ?? '', validTo: initial?.validTo ?? '', sumInsured: rupees(initial?.sumInsuredPaise), copayPercent: initial?.copayBp ? String(initial.copayBp / 100) : '',
    roomRentLimit: rupees(initial?.roomRentLimitPaise), priority: initial?.priority ?? 'primary', status: initial?.status ?? 'active',
  })
  const run = useRcmAction()
  const set = (k: keyof typeof v, val: string) => setV((x) => ({ ...x, [k]: val }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const money = (s: string) => (s.trim() === '' ? null : parseRupeesToPaise(s))
    const copay = v.copayPercent.trim() === '' ? null : Math.round(Number(v.copayPercent) * 100)
    const body = {
      patientId, insurerPayerId: Number(v.insurerPayerId), tpaPayerId: v.tpaPayerId ? Number(v.tpaPayerId) : null, policyNumber: v.policyNumber.trim(), memberId: v.memberId.trim(),
      ...(v.planName.trim() ? { planName: v.planName.trim() } : {}), policyType: v.policyType, ...(v.corporateName.trim() ? { corporateName: v.corporateName.trim() } : {}),
      ...(v.employeeId.trim() ? { employeeId: v.employeeId.trim() } : {}), holderName: v.holderName.trim(), relationship: v.relationship, validFrom: v.validFrom, validTo: v.validTo,
      sumInsuredPaise: money(v.sumInsured), copayBp: Number.isFinite(copay) ? copay : null, roomRentLimitPaise: money(v.roomRentLimit), priority: v.priority, status: v.status,
    }
    const parsed = policySchema.safeParse(body)
    if (!parsed.success) { run.setError(parsed.error.issues[0]?.message ?? 'Check the policy details'); return }
    const { patientId: _omit, ...patch } = body
    void _omit
    const ok = policyId === undefined ? await run.send('/api/rcm/policies', 'POST', body) : await run.send(`/api/rcm/policies/${policyId}`, 'PATCH', patch)
    if (ok) onDone?.()
  }

  const text = (k: keyof typeof v, label: string, type = 'text') => <Field label={label}><input type={type} className={inputClass} value={v[k]} onChange={(e) => set(k, e.target.value)} /></Field>
  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border border-border p-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Insurer"><select className={inputClass} value={v.insurerPayerId} onChange={(e) => set('insurerPayerId', e.target.value)}>{insurers.map((p) => <option key={p.payerId} value={p.payerId}>{p.name}</option>)}</select></Field>
        <Field label="TPA"><select className={inputClass} value={v.tpaPayerId} onChange={(e) => set('tpaPayerId', e.target.value)}><option value="">None</option>{tpas.map((p) => <option key={p.payerId} value={p.payerId}>{p.name}</option>)}</select></Field>
        <Field label="Policy type"><select className={inputClass} value={v.policyType} onChange={(e) => set('policyType', e.target.value)}>{POLICY_TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}</select></Field>
        {text('policyNumber', 'Policy number')}
        {text('memberId', 'Member / card ID')}
        {text('planName', 'Plan')}
        {text('corporateName', 'Employer (corporate policy)')}
        {text('employeeId', 'Employee ID')}
        {text('holderName', 'Policy holder')}
        <Field label="Relationship to holder"><select className={inputClass} value={v.relationship} onChange={(e) => set('relationship', e.target.value)}>{POLICY_RELATIONSHIPS.map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
        {text('validFrom', 'Valid from', 'date')}
        {text('validTo', 'Valid to', 'date')}
        {text('sumInsured', 'Sum insured (₹)')}
        {text('copayPercent', 'Co-pay (%)')}
        {text('roomRentLimit', 'Room rent limit per day (₹)')}
        <Field label="Priority"><select className={inputClass} value={v.priority} onChange={(e) => set('priority', e.target.value)}><option value="primary">Primary</option><option value="secondary">Secondary</option></select></Field>
        <Field label="Status"><select className={inputClass} value={v.status} onChange={(e) => set('status', e.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option></select></Field>
      </div>
      <FormError error={run.error} />
      <div className="flex gap-2">
        <button type="submit" className={buttonClass} disabled={run.busy}>{policyId === undefined ? 'Add policy' : 'Save policy'}</button>
        {onDone && <button type="button" className={secondaryButtonClass} onClick={onDone}>Cancel</button>}
      </div>
    </form>
  )
}
