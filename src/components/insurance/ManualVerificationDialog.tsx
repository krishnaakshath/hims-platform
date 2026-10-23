'use client'
// WS12 T3 (R2): record a verification staff confirmed with the insurer or TPA themselves, with an
// optional confirmation document. Valid-until defaults to today + 7 and is capped at today + 30
// and the policy's end; the server re-checks every bound.
import { useState } from 'react'
import { parseRupeesToPaise } from '@/lib/money'
import { formatCalendarDate } from '@/lib/india-time'
import { VERIFICATION_METHODS, manualValidUntilBounds, type VerificationMethod } from '@/lib/insurance/coverage'
import { CARD_UPLOAD_WARNING } from '@/components/rcm/PolicyCardUpload'
import { useRcmAction } from '@/components/rcm/useRcmAction'
import { Field, FormError, Panel, buttonClass, inputClass } from '@/components/rcm/ui'

const METHOD_LABEL: Record<VerificationMethod, string> = {
  insurer_portal: 'Insurer portal', tpa_portal: 'TPA portal', phone: 'Phone call', email: 'Email', letter: 'Letter',
}

const MONEY_FIELDS = [
  { key: 'sumInsuredPaise', label: 'Sum insured (₹)', what: 'the sum insured' },
  { key: 'balancePaise', label: 'Balance (₹)', what: 'the balance' },
  { key: 'roomRentLimitPaise', label: 'Room rent limit per day (₹)', what: 'the room rent limit' },
  { key: 'icuLimitPaise', label: 'ICU limit per day (₹)', what: 'the ICU limit' },
] as const
type MoneyKey = (typeof MONEY_FIELDS)[number]['key']

export function ManualVerificationDialog({ policyId, insurerName, policyValidTo, todayIso, onSaved }: {
  policyId: number; insurerName: string; policyValidTo: string; todayIso: string; onSaved: (verificationId: number) => void
}) {
  const bounds = manualValidUntilBounds(todayIso, policyValidTo)
  const [result, setResult] = useState<'active' | 'inactive'>('active')
  const [method, setMethod] = useState<VerificationMethod | ''>('')
  const [reference, setReference] = useState('')
  const [verifiedOn, setVerifiedOn] = useState(todayIso)
  const [validUntil, setValidUntil] = useState(bounds.defaultIso)
  const [money, setMoney] = useState<Record<MoneyKey, string>>({ sumInsuredPaise: '', balancePaise: '', roomRentLimitPaise: '', icuLimitPaise: '' })
  const [copay, setCopay] = useState('')
  const [note, setNote] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const run = useRcmAction()

  const missing = [
    method === '' && 'how it was verified',
    reference.trim().length < 3 && 'reference',
    verifiedOn === '' && 'verified on',
    validUntil === '' && 'valid until',
  ].filter((m): m is string => typeof m === 'string')

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (missing.length > 0) return
    const f = new FormData()
    f.set('result', result); f.set('method', method); f.set('reference', reference.trim())
    f.set('verifiedOn', verifiedOn); f.set('validUntil', validUntil)
    for (const m of MONEY_FIELDS) {
      const raw = money[m.key].trim()
      if (raw === '') continue
      const paise = parseRupeesToPaise(raw)
      if (paise === null) { run.setError(`Enter ${m.what} in rupees`); return }
      f.set(m.key, String(paise))
    }
    if (copay.trim() !== '') {
      const pct = Number(copay.trim())
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) { run.setError('Enter the co-pay as a percentage from 0 to 100'); return }
      f.set('copayBp', String(Math.round(pct * 100)))
    }
    if (note.trim() !== '') f.set('note', note.trim())
    if (file) f.set('file', file)
    const saved = await run.upload<{ verificationId: number }>(`/api/rcm/policies/${policyId}/verifications`, f)
    if (saved) onSaved(saved.verificationId)
  }

  return (
    <Panel title={`Record manual verification: ${insurerName}`}>
      <form onSubmit={save} className="grid gap-2 sm:grid-cols-2">
        <Field label="Result">
          <select className={inputClass} value={result} onChange={(e) => setResult(e.target.value as typeof result)}>
            <option value="active">Policy active</option><option value="inactive">Not in force</option>
          </select>
        </Field>
        <Field label="How it was verified">
          <select className={inputClass} value={method} onChange={(e) => setMethod(e.target.value as VerificationMethod | '')}>
            <option value="">Choose…</option>
            {VERIFICATION_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
          </select>
        </Field>
        <Field label="Insurer / TPA reference"><input className={inputClass} maxLength={64} value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
        <Field label="Verified on"><input type="date" className={inputClass} max={todayIso} value={verifiedOn} onChange={(e) => setVerifiedOn(e.target.value)} /></Field>
        <Field label="Valid until"><input type="date" className={inputClass} min={todayIso} max={bounds.maxIso} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></Field>
        <p className="self-end text-xs text-muted-foreground">At most {formatCalendarDate(bounds.maxIso)} (30 days, and never after the policy ends).</p>
        {MONEY_FIELDS.map((m) => (
          <Field key={m.key} label={m.label}><input inputMode="decimal" className={inputClass} value={money[m.key]} onChange={(e) => setMoney({ ...money, [m.key]: e.target.value })} /></Field>
        ))}
        <Field label="Co-pay (%)"><input inputMode="decimal" className={inputClass} value={copay} onChange={(e) => setCopay(e.target.value)} /></Field>
        <div className="sm:col-span-2"><Field label="Note (optional)"><textarea className={inputClass} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>
        <div className="sm:col-span-2 space-y-1">
          <Field label="Confirmation document (optional)">
            <input type="file" className="block text-xs" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <p className="text-xs text-muted-foreground">PDF, JPEG or PNG up to 4 MB.</p>
          <p className="text-xs font-medium text-muted-foreground">{CARD_UPLOAD_WARNING}</p>
        </div>
        <div className="sm:col-span-2">
          <button type="submit" className={buttonClass} disabled={run.busy || missing.length > 0}>{run.busy ? 'Saving…' : 'Save verification'}</button>
          {missing.length > 0 && <span className="ml-2 text-xs text-muted-foreground">Still needed: {missing.join(', ')}</span>}
        </div>
      </form>
      <FormError error={run.error} />
    </Panel>
  )
}
