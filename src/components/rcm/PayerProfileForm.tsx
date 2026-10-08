'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendJson } from '@/lib/client-fetch'
import { CHANNEL_LABEL, EMPANELMENT_STATUSES, PAYER_KINDS, PAYER_KIND_LABEL, SUBMISSION_CHANNELS, type PayerKind } from '@/lib/rcm/constants'
import { Field, FormError, buttonClass, inputClass } from './ui'
import type { PayerProfileValues } from './payer-profile-values'

const opt = (s: string) => (s.trim() === '' ? undefined : s.trim())

/** Create (with name and code) or update an insurer/TPA profile. */
export function PayerProfileForm({ payerId, initial, onKindChange }: { payerId: number | null; initial: PayerProfileValues; onKindChange?: (k: PayerKind) => void }) {
  const router = useRouter()
  const [v, setV] = useState(initial)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const set = (k: keyof PayerProfileValues, val: string | boolean) => { setSaved(false); setV((x) => ({ ...x, [k]: val })) }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const profile = {
      kind: v.kind, shortName: opt(v.shortName), irdaiRegistrationNo: opt(v.irdaiRegistrationNo), nhcxParticipantCode: opt(v.nhcxParticipantCode), defaultChannel: v.defaultChannel,
      portalUrl: opt(v.portalUrl), claimsEmail: opt(v.claimsEmail), empanelmentStatus: v.empanelmentStatus, empanelledFrom: opt(v.empanelledFrom), empanelledTo: opt(v.empanelledTo),
      agreementReference: opt(v.agreementReference), preauthSlaHours: Number(v.preauthSlaHours), claimSettlementSlaDays: Number(v.claimSettlementSlaDays),
      queryResponseDays: Number(v.queryResponseDays), submissionWindowDays: Number(v.submissionWindowDays), requiresAbha: v.requiresAbha, requiresPreauthForIpd: v.requiresPreauthForIpd,
      active: v.active, notes: opt(v.notes), gstin: opt(v.gstin) ?? null, stateCode: opt(v.stateCode) ?? null,
    }
    const r = payerId === null
      ? await sendJson<{ payerId: number }>('/api/rcm/payers', 'POST', { ...profile, name: name.trim(), code: code.trim().toUpperCase() })
      : await sendJson(`/api/rcm/payers/${payerId}`, 'PUT', profile)
    if (!r.ok) { setError(r.error); return }
    setError(null)
    setSaved(true)
    if (payerId === null) router.push(`/rcm/payers/${(r.data as { payerId: number }).payerId}`)
    else router.refresh()
  }

  const text = (k: keyof PayerProfileValues, label: string, type = 'text') => (
    <Field label={label}><input type={type} className={inputClass} value={v[k] as string} onChange={(e) => set(k, e.target.value)} /></Field>
  )
  const check = (k: keyof PayerProfileValues, label: string) => (
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={v[k] as boolean} onChange={(e) => set(k, e.target.checked)} />{label}</label>
  )
  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {payerId === null && <Field label="Name"><input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} /></Field>}
        {payerId === null && <Field label="Code (capitals, digits, -)"><input className={inputClass} value={code} onChange={(e) => setCode(e.target.value)} /></Field>}
        <Field label="Kind"><select className={inputClass} value={v.kind} onChange={(e) => { set('kind', e.target.value); onKindChange?.(e.target.value as PayerKind) }}>{PAYER_KINDS.map((k) => <option key={k} value={k}>{PAYER_KIND_LABEL[k]}</option>)}</select></Field>
        {text('shortName', 'Short name')}
        {text('irdaiRegistrationNo', 'IRDAI registration')}
        {text('nhcxParticipantCode', 'NHCX participant code')}
        <Field label="Default channel"><select className={inputClass} value={v.defaultChannel} onChange={(e) => set('defaultChannel', e.target.value)}>{SUBMISSION_CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}</select></Field>
        {text('portalUrl', 'Portal link (https://…)')}
        {text('claimsEmail', 'Claims email', 'email')}
        <Field label="Empanelment"><select className={inputClass} value={v.empanelmentStatus} onChange={(e) => set('empanelmentStatus', e.target.value)}>{EMPANELMENT_STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select></Field>
        {text('empanelledFrom', 'Empanelled from', 'date')}
        {text('empanelledTo', 'Empanelled to', 'date')}
        {text('agreementReference', 'Agreement reference')}
        {text('preauthSlaHours', 'Pre-auth decision SLA (hours)', 'number')}
        {text('claimSettlementSlaDays', 'Settlement SLA (days)', 'number')}
        {text('queryResponseDays', 'Query reply window (days)', 'number')}
        {text('submissionWindowDays', 'Submission window after discharge (days)', 'number')}
        {text('gstin', 'GSTIN')}
        {text('stateCode', 'State code (IN-xx)')}
      </div>
      <div className="flex flex-wrap gap-4">{check('requiresPreauthForIpd', 'Needs pre-authorisation for inpatient claims')}{check('requiresAbha', 'Needs the patient ABHA number')}{check('active', 'Active')}</div>
      <Field label="Notes"><textarea className={inputClass} rows={2} value={v.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      <FormError error={error} />
      {saved && <p className="text-xs text-emerald-700">Saved</p>}
      <button type="submit" className={buttonClass}>{payerId === null ? 'Add insurer or TPA' : 'Save profile'}</button>
    </form>
  )
}
