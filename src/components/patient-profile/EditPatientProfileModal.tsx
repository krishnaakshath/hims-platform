'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Field, INPUT_CLASS, SectionHeading } from '@/components/registration/Field'
import { AddressSection } from '@/components/registration/AddressSection'
import { ContactsSection } from '@/components/registration/ContactsSection'
import {
  EMPTY_REGISTRATION_FORM, serverFieldErrors, type RegistrationFormState, type ContactDraft,
} from '@/components/registration/registration-form-state'
import { formatAbhaNumber, normalizeAbhaNumber } from '@/lib/india/abha'
import { GENDERS, MARITAL_STATUSES, BLOOD_GROUPS, LANGUAGES } from '@/lib/india/reference'
import type { ProfileView } from './PatientProfilePanel'

const opt = (s: string) => (s.trim() === '' ? undefined : s)

function initialForm(p: ProfileView): RegistrationFormState {
  return {
    ...EMPTY_REGISTRATION_FORM,
    gender: p.gender ?? '', maritalStatus: p.maritalStatus ?? '', bloodGroup: p.bloodGroup ?? '', occupation: p.occupation ?? '',
    nationality: p.nationality ?? 'IN', religion: p.religion ?? '', preferredLanguage: p.preferredLanguage ?? '',
    email: p.email ?? '', phone: p.phone ?? '',
    addressLine1: p.addressLine1 ?? '', addressLine2: p.addressLine2 ?? '', city: p.city ?? '', district: p.district ?? '',
    stateCode: p.stateCode ?? '', pinCode: p.pinCode ?? '',
    abhaNumber: p.abhaNumber && /^\d{14}$/.test(p.abhaNumber) ? formatAbhaNumber(p.abhaNumber) : p.abhaNumber ?? '',
    abhaAddress: p.abhaAddress ?? '',
    isMlc: p.isMlc, mlcNumber: p.mlcNumber ?? '',
    contacts: p.contacts.map((c) => ({ kind: c.kind, name: c.name, relationship: c.relationship, phone: c.phone, addressText: c.addressText ?? '' })),
  }
}

function SelectField({ label, value, onChange, options, error }: {
  label: string; value: string; onChange: (v: string) => void; options: readonly { code: string; label: string }[]; error?: string
}) {
  return (
    <Field label={label} error={error}>
      {(p) => (
        <select {...p} value={value} onChange={(e) => onChange(e.target.value)} className={INPUT_CLASS}>
          <option value="">Select</option>
          {options.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
        </select>
      )}
    </Field>
  )
}

const contactsPayload = (cs: ContactDraft[]) => cs.map((c) => ({
  kind: c.kind, name: c.name, relationship: c.relationship, phone: c.phone, ...(opt(c.addressText) ? { addressText: c.addressText } : {}),
}))

// Edits what staff may change after registration: demographics, address,
// ABHA, the MLC flag and contacts. Aadhaar has its own panel/route; name and
// date of birth are not editable here.
export function EditPatientProfileModal({ patient, onClose }: { patient: ProfileView; onClose: () => void }) {
  const router = useRouter()
  const [initial] = useState(() => initialForm(patient))
  const [form, setForm] = useState(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [message, setMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const update = <K extends keyof RegistrationFormState>(k: K, v: RegistrationFormState[K]) => setForm((f) => ({ ...f, [k]: v }))

  async function save() {
    setSaving(true)
    setMessage(null)
    setErrors({})
    const abhaChanged = form.abhaNumber !== initial.abhaNumber || form.abhaAddress !== initial.abhaAddress
    const abhaNumber = opt(form.abhaNumber), abhaAddress = opt(form.abhaAddress)
    const profile: Record<string, unknown> = {
      gender: opt(form.gender), maritalStatus: opt(form.maritalStatus), bloodGroup: opt(form.bloodGroup),
      occupation: opt(form.occupation), nationality: opt(form.nationality), religion: opt(form.religion),
      preferredLanguage: opt(form.preferredLanguage), email: opt(form.email), phone: opt(form.phone),
      addressLine1: opt(form.addressLine1), addressLine2: opt(form.addressLine2), city: opt(form.city),
      district: opt(form.district), stateCode: opt(form.stateCode), pinCode: opt(form.pinCode),
      isMlc: form.isMlc, mlcNumber: form.isMlc ? opt(form.mlcNumber) : undefined,
      abha: abhaChanged && (abhaNumber || abhaAddress)
        ? { status: 'provided', ...(abhaNumber ? { abhaNumber: normalizeAbhaNumber(abhaNumber) } : {}), ...(abhaAddress ? { abhaAddress } : {}) }
        : undefined,
    }
    const body = Object.fromEntries(Object.entries(profile).filter(([, v]) => v !== undefined))
    const contactsChanged = JSON.stringify(contactsPayload(form.contacts)) !== JSON.stringify(contactsPayload(initial.contacts))
    const headers = { 'Content-Type': 'application/json' }
    try {
      const res = await fetch(`/api/patients/${patient.id}/profile`, { method: 'PATCH', headers, body: JSON.stringify(body) })
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null
        setErrors(serverFieldErrors(data))
        setMessage(data?.error ?? 'Could not save the profile. Please try again.')
        return
      }
      if (contactsChanged) {
        const cres = await fetch(`/api/patients/${patient.id}/contacts`, { method: 'PUT', headers, body: JSON.stringify({ contacts: contactsPayload(form.contacts) }) })
        if (!cres.ok) {
          const data = (await cres.json().catch(() => null)) as { error?: string } | null
          setMessage(`Profile saved, but contacts were not: ${data?.error ?? 'please try again.'}`)
          router.refresh()
          return
        }
      }
      onClose()
      router.refresh()
    } catch {
      setMessage('Could not save the profile. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>Edit profile</DialogTitle></DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); void save() }} className="space-y-4" noValidate>
          <section aria-label="Basic info" className="space-y-3">
            <SectionHeading>Basic info</SectionHeading>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <SelectField label="Gender" value={form.gender} onChange={(v) => update('gender', v)} options={GENDERS} error={errors.gender} />
              <SelectField label="Marital status" value={form.maritalStatus} onChange={(v) => update('maritalStatus', v)} options={MARITAL_STATUSES} error={errors.maritalStatus} />
              <SelectField label="Blood group" value={form.bloodGroup} onChange={(v) => update('bloodGroup', v)} options={BLOOD_GROUPS} error={errors.bloodGroup} />
              <SelectField label="Preferred language" value={form.preferredLanguage} onChange={(v) => update('preferredLanguage', v)} options={LANGUAGES} error={errors.preferredLanguage} />
              <Field label="Occupation" error={errors.occupation}>
                {(p) => <input {...p} value={form.occupation} onChange={(e) => update('occupation', e.target.value)} className={INPUT_CLASS} />}
              </Field>
              <Field label="Religion" error={errors.religion}>
                {(p) => <input {...p} value={form.religion} onChange={(e) => update('religion', e.target.value)} className={INPUT_CLASS} />}
              </Field>
              <Field label="Phone" error={errors.phone}>
                {(p) => <input {...p} type="tel" inputMode="tel" value={form.phone} onChange={(e) => update('phone', e.target.value)} className={INPUT_CLASS} />}
              </Field>
              <Field label="Email" error={errors.email}>
                {(p) => <input {...p} type="email" autoComplete="off" value={form.email} onChange={(e) => update('email', e.target.value)} className={INPUT_CLASS} />}
              </Field>
            </div>
          </section>
          <AddressSection form={form} update={update} errors={errors} />
          <section aria-label="ABHA" className="space-y-3">
            <SectionHeading>ABHA</SectionHeading>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="ABHA number" error={errors.abha}>
                {(p) => <input {...p} inputMode="numeric" autoComplete="off" value={form.abhaNumber} onChange={(e) => update('abhaNumber', e.target.value.replace(/[^\d\s-]/g, '').slice(0, 17))} className={INPUT_CLASS} />}
              </Field>
              <Field label="ABHA address">
                {(p) => <input {...p} autoComplete="off" autoCapitalize="none" placeholder="name@abdm" value={form.abhaAddress} onChange={(e) => update('abhaAddress', e.target.value)} className={INPUT_CLASS} />}
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
          <ContactsSection form={form} update={update} errors={errors} />
          {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
