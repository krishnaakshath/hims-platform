'use client'
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendJson } from '@/lib/client-fetch'
import { formatPaise, parseRupeesToPaise } from '@/lib/format'
import { formatIsoDate } from '@/lib/india-time'
import { DIAGNOSIS_CODE_KINDS, PROCEDURE_CODE_KINDS } from '@/lib/coding/code-systems'
import { missingPreauthFields, requestedVsEstimate, type PreauthFormDefaults } from '@/lib/rcm/preauth-form'
import { CodePicker, type PickedCode } from './CodePicker'
import { EstimateTable, type EstimateItem } from './EstimateTable'
import { Field, FormError, buttonClass, inputClass } from './ui'

export interface PreauthFormProps {
  policies: { id: number; label: string }[]
  admissions: { id: number; admittedOn: string; status: string }[]
  encounters: { id: number; date: string }[]
  doctors: { id: number; name: string }[]
  /** WS12 T8: pre-filled from the admission or visit (preauthDefaultsFor). */
  defaults?: PreauthFormDefaults
}

type CreateResponse = { preauthId: number; preauthNumber: string; eligibility?: { started: true; checkId: number } | { started: false; message: string } }

const STARTED_MESSAGE = "NHCX eligibility check started: the insurer's answer will show on the patient's coverage badge."

function initialContextId(d: PreauthFormDefaults | undefined): string {
  if (!d) return ''
  const id = d.claimType === 'opd' ? d.encounterId : d.admissionId
  return id === null ? '' : String(id)
}

export function PreauthForm({ policies, admissions, encounters, doctors, defaults }: PreauthFormProps) {
  const router = useRouter()
  const whyId = useId()
  const defaultPolicy = defaults?.policyId != null && policies.some((p) => p.id === defaults.policyId) ? defaults.policyId : policies[0]?.id ?? null
  const defaultDoctor = defaults?.treatingProviderId != null && doctors.some((d) => d.id === defaults.treatingProviderId) ? String(defaults.treatingProviderId) : ''
  const [policyId, setPolicyId] = useState<number | null>(defaultPolicy)
  const [claimType, setClaimType] = useState<'ipd' | 'daycare' | 'opd'>(defaults?.claimType ?? 'ipd')
  const [contextId, setContextId] = useState(initialContextId(defaults))
  const [planned, setPlanned] = useState(defaults?.plannedAdmissionDate ?? '')
  const [los, setLos] = useState('1')
  const [room, setRoom] = useState(defaults?.roomCategoryCode ?? '')
  // Never the first doctor by default: the treating doctor is a choice, not a guess.
  const [doctorId, setDoctorId] = useState(defaultDoctor)
  const [dx, setDx] = useState<PickedCode[]>([])
  const [px, setPx] = useState<PickedCode[]>([])
  const [text, setText] = useState('')
  const [items, setItems] = useState<EstimateItem[]>([])
  const [estimate, setEstimate] = useState<number | null>(null)
  const [requested, setRequested] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<{ preauthId: number; preauthNumber: string; message: string | null } | null>(null)

  const requestedPaise = requested.trim() ? parseRupeesToPaise(requested) : null
  const amountCheck = requestedVsEstimate(requestedPaise, estimate)
  const missing = missingPreauthFields({ policyId, plannedAdmissionDate: planned, treatingProviderId: doctorId, estimateItems: items.length, diagnosisCodes: dx.length, provisionalDiagnosisText: text })
  if (amountCheck.needsConfirm && !confirmed) missing.push('confirmation of the requested amount')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (policyId === null) { setError('Choose a policy'); return }
    if (requested.trim() && (requestedPaise === null || requestedPaise < 1)) { setError('Enter the requested amount in rupees'); return }
    if (missing.length > 0) return
    setBusy(true)
    const ctx = contextId ? (claimType === 'opd' ? { encounterId: Number(contextId) } : { admissionId: Number(contextId) }) : {}
    const r = await sendJson<CreateResponse>('/api/rcm/preauths', 'POST', {
      policyId, claimType, ...ctx, plannedAdmissionDate: planned, expectedLengthOfStayDays: Number(los), treatingProviderId: Number(doctorId),
      diagnosisCodeIds: dx.map((d) => d.id), procedureCodeIds: px.map((p) => p.id), ...(text.trim() ? { provisionalDiagnosisText: text.trim() } : {}),
      estimate: items.map((i) => ({ serviceId: i.serviceId, quantity: i.quantity })), ...(requestedPaise ? { requestedPaise } : {}), ...(room.trim() ? { roomCategoryCode: room.trim() } : {}),
    })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    const el = r.data.eligibility
    // The eligibility outcome is shown before leaving, so staff know whether a check is running.
    setCreated({ preauthId: r.data.preauthId, preauthNumber: r.data.preauthNumber, message: el ? (el.started ? STARTED_MESSAGE : el.message) : null })
  }

  if (created) {
    return (
      <div role="status" className="space-y-3 rounded-lg border border-border bg-card p-4 text-sm">
        <p className="font-semibold">Draft pre-authorisation {created.preauthNumber} created.</p>
        {created.message && <p>{created.message}</p>}
        <button type="button" className={buttonClass} onClick={() => router.push(`/rcm/preauths/${created.preauthId}`)}>Open the pre-authorisation</button>
      </div>
    )
  }

  const disabled = busy || missing.length > 0
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
        <Field label="Treating doctor">
          <select className={inputClass} value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
            <option value="">Choose the treating doctor</option>
            {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <CodePicker kinds={DIAGNOSIS_CODE_KINDS} label="Diagnoses" value={dx} onChange={setDx} />
        <CodePicker kinds={PROCEDURE_CODE_KINDS} label="Procedures" value={px} onChange={setPx} />
      </div>
      <Field label="Provisional diagnosis (free text)"><textarea className={inputClass} rows={2} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <EstimateTable policyId={policyId} plannedAdmissionDate={planned} roomCategoryCode={room} lengthOfStayDays={Number(los)} items={items} onItems={setItems} onTotal={setEstimate} />
      <Field label={`Requested amount (₹)${estimate !== null ? `, estimate ${formatPaise(estimate)}` : ''}`}><input className={inputClass} placeholder="Defaults to the estimate" value={requested} onChange={(e) => { setRequested(e.target.value); setConfirmed(false) }} /></Field>
      {amountCheck.message && (
        <p className={`text-xs ${amountCheck.level === 'warn' ? 'font-medium text-amber-800' : 'text-muted-foreground'}`}>{amountCheck.message}</p>
      )}
      {amountCheck.needsConfirm && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          I have checked the requested amount
        </label>
      )}
      <FormError error={error} />
      <div className="space-y-1">
        <button type="submit" className={buttonClass} disabled={disabled} aria-describedby={missing.length > 0 ? whyId : undefined}>{busy ? 'Saving…' : 'Create draft pre-authorisation'}</button>
        {missing.length > 0 && <p id={whyId} className="text-xs text-muted-foreground">To create the draft, add: {missing.join(', ')}</p>}
      </div>
    </form>
  )
}
