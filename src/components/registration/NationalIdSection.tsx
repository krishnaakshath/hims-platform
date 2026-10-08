'use client'
import { useState } from 'react'
import { Field, INPUT_CLASS, SectionHeading } from './Field'
import { pickError, type SectionProps } from './registration-form-state'
import { AbhaVerifyButton } from '@/components/abdm/AbhaVerifyDialog' // SP8
import {
  KYC_DOC_TYPES, KYC_DOC_LABELS, AADHAAR_DECLINE_REASONS, ABHA_UNAVAILABLE_REASONS,
} from '@/lib/india/reference'

const ABDM_HINT = 'ABDM not connected: the number is recorded but not verified'

// Digits grouped 4-4-4 for readability; when the field is not focused all but
// the last four digits are shown as X.
function spaced(s: string): string {
  return s.replace(/(.{4})(?=.)/g, '$1 ')
}
function display(digits: string, focused: boolean): string {
  if (focused || digits.length < 5) return spaced(digits)
  return spaced('X'.repeat(digits.length - 4) + digits.slice(-4))
}

function ReasonSelect({ label, value, onChange, options, error }: {
  label: string; value: string; onChange: (v: string) => void; options: readonly { code: string; label: string }[]; error?: string
}) {
  return (
    <Field label={label} required error={error}>
      {(p) => (
        <select {...p} value={value} onChange={(e) => onChange(e.target.value)} className={INPUT_CLASS}>
          <option value="">Select a reason</option>
          {options.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
        </select>
      )}
    </Field>
  )
}

export function NationalIdSection({ form, update, errors }: SectionProps) {
  const [focused, setFocused] = useState(false)
  const declined = form.aadhaarMode === 'declined'
  const unavailable = form.abhaMode === 'unavailable'
  return (
    <section aria-label="Identity documents" className="space-y-3">
      <SectionHeading>Aadhaar</SectionHeading>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={declined} onChange={(e) => update('aadhaarMode', e.target.checked ? 'declined' : 'provided')} />
        Patient does not provide Aadhaar
      </label>
      {!declined ? (
        <>
          <Field label="Aadhaar number" error={pickError(errors, 'aadhaar.number', 'aadhaar')}>
            {(p) => (
              <input
                {...p}
                aria-label="Aadhaar number"
                inputMode="numeric"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="XXXX XXXX XXXX"
                value={display(form.aadhaarNumber, focused)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onChange={(e) => update('aadhaarNumber', e.target.value.replace(/\D/g, '').slice(0, 12))}
                className={INPUT_CLASS}
              />
            )}
          </Field>
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" required checked={form.aadhaarConsent} onChange={(e) => update('aadhaarConsent', e.target.checked)} />
              Patient consents to recording their Aadhaar number
            </label>
            {errors['aadhaar.consent'] && <p role="alert" className="text-xs text-destructive">{errors['aadhaar.consent']}</p>}
          </div>
        </>
      ) : (
        <>
          <ReasonSelect label="Reason for no Aadhaar" value={form.aadhaarDeclineReason} onChange={(v) => update('aadhaarDeclineReason', v)}
            options={AADHAAR_DECLINE_REASONS} error={pickError(errors, 'aadhaar.reason', 'aadhaar')} />
          <Field label={form.aadhaarDeclineReason === 'other' ? 'Note (required)' : 'Note (optional)'} error={errors['aadhaar.note']}>
            {(p) => <input {...p} autoComplete="off" value={form.aadhaarDeclineNote} onChange={(e) => update('aadhaarDeclineNote', e.target.value)} className={INPUT_CLASS} />}
          </Field>
        </>
      )}

      <SectionHeading>ABHA (Ayushman Bharat Health Account)</SectionHeading>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={unavailable} onChange={(e) => update('abhaMode', e.target.checked ? 'unavailable' : 'provided')} />
        ABHA not available
      </label>
      {!unavailable ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="ABHA number" hint={ABDM_HINT} error={pickError(errors, 'abha.abhaNumber', 'abha')}>
            {(p) => <input {...p} inputMode="numeric" autoComplete="off" placeholder="14-digit ABHA number" value={form.abhaNumber} onChange={(e) => { update('abhaNumber', e.target.value.replace(/[^\d\s-]/g, '').slice(0, 17)); if (form.abhaFlowId) update('abhaFlowId', '') }} className={INPUT_CLASS} />}
          </Field>
          <Field label="ABHA address" hint={ABDM_HINT} error={errors['abha.abhaAddress']}>
            {(p) => <input {...p} autoComplete="off" autoCapitalize="none" placeholder="name@abdm" value={form.abhaAddress} onChange={(e) => update('abhaAddress', e.target.value)} className={INPUT_CLASS} />}
          </Field>
          {/* SP8: create or verify through ABDM; fills the fields and remembers the flow. */}
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <AbhaVerifyButton patientId={null} mode="register" label="Create or verify with ABDM" onVerified={(v) => {
              update('abhaNumber', v.abhaNumber)
              update('abhaAddress', v.abhaAddress ?? '')
              update('abhaFlowId', v.flowId)
            }} />
            {form.abhaFlowId && <span className="text-xs font-semibold text-emerald-800">Verified with ABDM</span>}
          </div>
        </div>
      ) : (
        <>
          <ReasonSelect label="Reason ABHA is not available" value={form.abhaUnavailableReason} onChange={(v) => update('abhaUnavailableReason', v)}
            options={ABHA_UNAVAILABLE_REASONS} error={pickError(errors, 'abha.reason', 'abha')} />
          <Field label={form.abhaUnavailableReason === 'other' ? 'Note (required)' : 'Note (optional)'} error={errors['abha.note']}>
            {(p) => <input {...p} autoComplete="off" value={form.abhaUnavailableNote} onChange={(e) => update('abhaUnavailableNote', e.target.value)} className={INPUT_CLASS} />}
          </Field>
        </>
      )}

      <SectionHeading>Other ID and medico-legal</SectionHeading>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Other ID document type" error={pickError(errors, 'kyc.docType', 'kyc')}>
          {(p) => (
            <select {...p} value={form.kycDocType} onChange={(e) => update('kycDocType', e.target.value)} className={INPUT_CLASS}>
              <option value="">None</option>
              {KYC_DOC_TYPES.map((t) => <option key={t} value={t}>{KYC_DOC_LABELS[t]}</option>)}
            </select>
          )}
        </Field>
        <Field label="ID document number" error={errors['kyc.docNumber']}>
          {(p) => <input {...p} autoComplete="off" value={form.kycDocNumber} onChange={(e) => update('kycDocNumber', e.target.value)} className={INPUT_CLASS} />}
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.isMlc} onChange={(e) => update('isMlc', e.target.checked)} />
        Medico-legal case (MLC)
      </label>
      {form.isMlc && (
        <Field label="MLC number" error={errors.mlcNumber}>
          {(p) => <input {...p} autoComplete="off" value={form.mlcNumber} onChange={(e) => update('mlcNumber', e.target.value)} className={INPUT_CLASS} />}
        </Field>
      )}
    </section>
  )
}
