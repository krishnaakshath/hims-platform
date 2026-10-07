'use client'
import { Field, INPUT_CLASS, SectionHeading } from './Field'
import type { SectionProps } from './registration-form-state'
import { INDIAN_STATES } from '@/lib/india/reference'

export function AddressSection({ form, update, errors }: SectionProps) {
  return (
    <section aria-label="Address" className="space-y-3">
      <SectionHeading>Address</SectionHeading>
      <Field label="Address line 1" required error={errors.addressLine1}>
        {(p) => <input {...p} autoComplete="off" value={form.addressLine1} onChange={(e) => update('addressLine1', e.target.value)} className={INPUT_CLASS} />}
      </Field>
      <Field label="Address line 2" error={errors.addressLine2}>
        {(p) => <input {...p} autoComplete="off" value={form.addressLine2} onChange={(e) => update('addressLine2', e.target.value)} className={INPUT_CLASS} />}
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="City" required error={errors.city}>
          {(p) => <input {...p} value={form.city} onChange={(e) => update('city', e.target.value)} className={INPUT_CLASS} />}
        </Field>
        <Field label="District" required error={errors.district}>
          {(p) => <input {...p} value={form.district} onChange={(e) => update('district', e.target.value)} className={INPUT_CLASS} />}
        </Field>
        <Field label="State / UT" required error={errors.stateCode}>
          {(p) => (
            <select {...p} value={form.stateCode} onChange={(e) => update('stateCode', e.target.value)} className={INPUT_CLASS}>
              <option value="">Select</option>
              {INDIAN_STATES.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
            </select>
          )}
        </Field>
        <Field label="PIN code" required error={errors.pinCode}>
          {(p) => <input {...p} inputMode="numeric" autoComplete="postal-code" maxLength={6} value={form.pinCode} onChange={(e) => update('pinCode', e.target.value.replace(/\D/g, '').slice(0, 6))} className={INPUT_CLASS} />}
        </Field>
      </div>
    </section>
  )
}
