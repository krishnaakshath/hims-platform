'use client'
import { Field, INPUT_CLASS, SectionHeading } from './Field'
import type { SectionProps, ContactDraft } from './registration-form-state'
import { CONTACT_RELATIONSHIPS } from '@/lib/india/reference'

const MAX_CONTACTS = 5
const KIND_LABELS: Record<ContactDraft['kind'], string> = { next_of_kin: 'Next of kin', guardian: 'Guardian', emergency: 'Emergency contact' }

export function ContactsSection({ form, update, errors }: SectionProps) {
  const { contacts } = form
  const setRow = (i: number, patch: Partial<ContactDraft>) =>
    update('contacts', contacts.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  return (
    <section aria-label="Contacts" className="space-y-3">
      <SectionHeading>Contacts and guardian</SectionHeading>
      {errors.contacts && <p role="alert" className="text-xs text-destructive">{errors.contacts}</p>}
      {contacts.map((c, i) => (
        <fieldset key={i} className="space-y-3 rounded-md border border-border p-3">
          <legend className="px-1 text-xs text-muted-foreground">Contact {i + 1}</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={`Contact ${i + 1} type`}>
              {(p) => (
                <select {...p} value={c.kind} onChange={(e) => setRow(i, { kind: e.target.value as ContactDraft['kind'] })} className={INPUT_CLASS}>
                  {(Object.keys(KIND_LABELS) as ContactDraft['kind'][]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                </select>
              )}
            </Field>
            <Field label={`Contact ${i + 1} name`} required error={errors[`contacts.${i}.name`]}>
              {(p) => <input {...p} value={c.name} onChange={(e) => setRow(i, { name: e.target.value })} className={INPUT_CLASS} />}
            </Field>
            <Field label={`Contact ${i + 1} relationship`} error={errors[`contacts.${i}.relationship`]}>
              {(p) => (
                <select {...p} value={c.relationship} onChange={(e) => setRow(i, { relationship: e.target.value })} className={INPUT_CLASS}>
                  <option value="">Select</option>
                  {CONTACT_RELATIONSHIPS.map((r) => <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}
                </select>
              )}
            </Field>
            <Field label={`Contact ${i + 1} phone`} required error={errors[`contacts.${i}.phone`]}>
              {(p) => <input {...p} type="tel" inputMode="tel" value={c.phone} onChange={(e) => setRow(i, { phone: e.target.value })} className={INPUT_CLASS} />}
            </Field>
          </div>
          <Field label={`Contact ${i + 1} address (optional)`} error={errors[`contacts.${i}.addressText`]}>
            {(p) => <input {...p} value={c.addressText} onChange={(e) => setRow(i, { addressText: e.target.value })} className={INPUT_CLASS} />}
          </Field>
          <button type="button" onClick={() => update('contacts', contacts.filter((_, j) => j !== i))}
            className="text-xs text-destructive underline" aria-label={`Remove contact ${i + 1}`}>
            Remove contact
          </button>
        </fieldset>
      ))}
      <button type="button" disabled={contacts.length >= MAX_CONTACTS}
        onClick={() => update('contacts', [...contacts, { kind: contacts.some((c) => c.kind === 'guardian') ? 'emergency' : 'next_of_kin', name: '', relationship: '', phone: '', addressText: '' }])}
        className="rounded-md border border-border px-3 py-1.5 text-xs disabled:opacity-50">
        Add contact
      </button>
      {contacts.length >= MAX_CONTACTS && <p className="text-xs text-muted-foreground">Up to {MAX_CONTACTS} contacts.</p>}
    </section>
  )
}
