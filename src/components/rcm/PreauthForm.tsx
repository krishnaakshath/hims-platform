'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendJson } from '@/lib/client-fetch'
import { formatPaise, parseRupeesToPaise } from '@/lib/format'
import { formatIsoDate } from '@/lib/india-time'
import { DIAGNOSIS_CODE_KINDS, PROCEDURE_CODE_KINDS } from '@/lib/coding/code-systems'
import { CodePicker, type PickedCode } from './CodePicker'
import { EstimateTable, type EstimateItem } from './EstimateTable'
import { Field, FormError, buttonClass, inputClass } from './ui'

export interface PreauthFormProps {
  policies: { id: number; label: string }[]
  admissions: { id: number; admittedOn: string; status: string }[]
  encounters: { id: number; date: string }[]
  doctors: { id: number; name: string }[]
}

export function PreauthForm({ policies, admissions, encounters, doctors }: PreauthFormProps) {
  const router = useRouter()
  const [policyId, setPolicyId] = useState<number | null>(policies[0]?.id ?? null)
  const [claimType, setClaimType] = useState<'ipd' | 'daycare' | 'opd'>('ipd')
  const [contextId, setContextId] = useState('')
  const [planned, setPlanned] = useState('')
  const [los, setLos] = useState('1')
  const [room, setRoom] = useState('')
  const [doctorId, setDoctorId] = useState(doctors[0] ? String(doctors[0].id) : '')
  const [dx, setDx] = useState<PickedCode[]>([])
  const [px, setPx] = useState<PickedCode[]>([])
  const [text, setText] = useState('')
  const [items, setItems] = useState<EstimateItem[]>([])
  const [estimate, setEstimate] = useState<number | null>(null)
  const [requested, setRequested] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (policyId === null) { setError('Choose a policy'); return }
    const requestedPaise = requested.trim() ? parseRupeesToPaise(requested) : null
    if (requested.trim() && (requestedPaise === null || requestedPaise < 1)) { setError('Enter the requested amount in rupees'); return }
    setBusy(true)
    const ctx = contextId ? (claimType === 'opd' ? { encounterId: Number(contextId) } : { admissionId: Number(contextId) }) : {}
    const r = await sendJson<{ preauthId: number }>('/api/rcm/preauths', 'POST', {
      policyId, claimType, ...ctx, plannedAdmissionDate: planned, expectedLengthOfStayDays: Number(los), treatingProviderId: Number(doctorId),
      diagnosisCodeIds: dx.map((d) => d.id), procedureCodeIds: px.map((p) => p.id), ...(text.trim() ? { provisionalDiagnosisText: text.trim() } : {}),
      estimate: items.map((i) => ({ serviceId: i.serviceId, quantity: i.quantity })), ...(requestedPaise ? { requestedPaise } : {}), ...(room.trim() ? { roomCategoryCode: room.trim() } : {}),
    })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    router.push(`/rcm/preauths/${r.data.preauthId}`)
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Policy"><select className={inputClass} value={policyId ?? ''} onChange={(e) => setPolicyId(e.target.value ? Number(e.target.value) : null)}>{policies.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></Field>
        <Field label="Claim type"><select className={inputClass} value={claimType} onChange={(e) => { setClaimType(e.target.value as typeof claimType); setContextId('') }}><option value="ipd">Inpatient</option><option value="daycare">Daycare</option><option value="opd">Outpatient</option></select></Field>
        <Field label={claimType === 'opd' ? 'Visit' : 'Admission (if already admitted)'}>
          <select className={inputClass} value={contextId} onChange={(e) => setContextId(e.target.value)}>
            <option value="">{claimType === 'opd' ? 'Not linked' : 'Planned admission'}</option>
            {claimType === 'opd' ? encounters.map((e) => <option key={e.id} value={e.id}>Visit {formatIsoDate(e.date)}</option>) : admissions.map((a) => <option key={a.id} value={a.id}>Admitted {formatIsoDate(a.admittedOn)} ({a.status})</option>)}
          </select>
        </Field>
        <Field label="Planned admission date"><input type="date" className={inputClass} value={planned} onChange={(e) => setPlanned(e.target.value)} /></Field>
        <Field label="Expected stay (days)"><input type="number" min={1} max={365} className={inputClass} value={los} onChange={(e) => setLos(e.target.value)} /></Field>
        <Field label="Room category code"><input className={inputClass} value={room} onChange={(e) => setRoom(e.target.value)} /></Field>
        <Field label="Treating doctor"><select className={inputClass} value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>{doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <CodePicker kinds={DIAGNOSIS_CODE_KINDS} label="Diagnoses" value={dx} onChange={setDx} />
        <CodePicker kinds={PROCEDURE_CODE_KINDS} label="Procedures" value={px} onChange={setPx} />
      </div>
      <Field label="Provisional diagnosis (free text)"><textarea className={inputClass} rows={2} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <EstimateTable policyId={policyId} plannedAdmissionDate={planned} roomCategoryCode={room} items={items} onItems={setItems} onTotal={setEstimate} />
      <Field label={`Requested amount (₹)${estimate !== null ? `, estimate ${formatPaise(estimate)}` : ''}`}><input className={inputClass} placeholder="Defaults to the estimate" value={requested} onChange={(e) => setRequested(e.target.value)} /></Field>
      <FormError error={error} />
      <button type="submit" className={buttonClass} disabled={busy || items.length === 0 || !planned || !doctorId}>{busy ? 'Saving…' : 'Create draft pre-authorisation'}</button>
    </form>
  )
}
