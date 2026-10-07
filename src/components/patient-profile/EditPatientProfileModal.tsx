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
import { GENDERS, MARITAL_STATUSES, BLOOD_GROUPS, LANGUAGES, ABHA_UNAVAILABLE_REASONS } from '@/lib/india/reference'
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

// Optional-at-registration fields may be cleared (sent as null); the required
// ones are sent as typed so the server reports an empty value on the field.
const CLEARABLE = ['maritalStatus', 'bloodGroup', 'occupation', 'religion', 'preferredLanguage', 'email', 'phone', 'addressLine2', 'mlcNumber'] as const
const REQUIRED = ['gender', 'nationality', 'addressLine1', 'city', 'district', 'stateCode', 'pinCode'] as const

type Baseline = RegistrationFormState & { abhaMode: 'provided' | 'unavailable' }

function initialAbhaMode(p: ProfileView): 'provided' | 'unavailable' {
  return p.abhaUnavailableReason && !p.abhaNumber && !p.abhaAddress ? 'unavailable' : 'provided'
}

/** Only the fields that differ from what is on file -- phone and legacy values are never rewritten unless edited. */
function changedProfileFields(form: RegistrationFormState, base: Baseline): { body: Record<string, unknown>; abhaProblem: string | null } {
  const body: Record<string, unknown> = {}
  for (const k of REQUIRED) if (form[k].trim() !== base[k].trim()) body[k] = form[k].trim()
  for (const k of CLEARABLE) if (form[k].trim() !== base[k].trim()) body[k] = form[k].trim() === '' ? null : form[k].trim()
  if (form.isMlc !== base.isMlc) {
    body.isMlc = form.isMlc
    if (form.isMlc && form.mlcNumber.trim() !== '') body.mlcNumber = form.mlcNumber.trim()
  }
  let abhaProblem: string | null = null
  const abhaChanged = form.abhaMode !== base.abhaMode
    || (form.abhaMode === 'provided'
      ? form.abhaNumber !== base.abhaNumber || form.abhaAddress !== base.abhaAddress
      : form.abhaUnavailableReason !== base.abhaUnavailableReason || form.abhaUnavailableNote !== base.abhaUnavailableNote)
  if (abhaChanged) {
    if (form.abhaMode === 'unavailable') {
      if (!form.abhaUnavailableReason) abhaProblem = 'Select a reason ABHA is not available.'
      else body.abha = { status: 'unavailable', reason: form.abhaUnavailableReason, ...(opt(form.abhaUnavailableNote.trim()) ? { note: form.abhaUnavailableNote.trim() } : {}) }
    } else {
      const number = opt(form.abhaNumber.trim()), address = opt(form.abhaAddress.trim())
      if (!number && !address) abhaProblem = 'Enter an ABHA number or address, or mark ABHA as not available.'
      else body.abha = { status: 'provided', ...(number ? { abhaNumber: normalizeAbhaNumber(number) } : {}), ...(address ? { abhaAddress: address } : {}) }
    }
  }
  return { body, abhaProblem }
}

async function errorOf(res: Response, fallback: string): Promise<{ message: string; data: unknown }> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  return { message: data?.error ?? fallback, data }
}

// Edits what staff may change after registration: demographics, address,
// ABHA, the MLC flag and contacts. Aadhaar has its own panel/route; name and
// date of birth are not editable here. Profile and contacts are two
// independent requests; the outcome message says which of them was saved.
export function EditPatientProfileModal({ patient, onClose }: { patient: ProfileView; onClose: () => void }) {
  const router = useRouter()
  const [baseline, setBaseline] = useState<Baseline>(() => ({ ...initialForm(patient), abhaMode: initialAbhaMode(patient) }))
  const [form, setForm] = useState<RegistrationFormState>(() => ({ ...initialForm(patient), abhaMode: initialAbhaMode(patient) }))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [message, setMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const update = <K extends keyof RegistrationFormState>(k: K, v: RegistrationFormState[K]) => setForm((f) => ({ ...f, [k]: v }))

  async function save() {
    setMessage(null)
    setErrors({})
    const { body, abhaProblem } = changedProfileFields(form, baseline)
    if (abhaProblem) { setErrors({ abha: abhaProblem }); return }
    const contactsChanged = JSON.stringify(contactsPayload(form.contacts)) !== JSON.stringify(contactsPayload(baseline.contacts))
    const profileChanged = Object.keys(body).length > 0
    if (!profileChanged && !contactsChanged) { onClose(); return }

    setSaving(true)
    const headers = { 'Content-Type': 'application/json' }
    const call = async (url: string, method: string, payload: unknown): Promise<Response | null> => {
      try { return await fetch(url, { method, headers, body: JSON.stringify(payload) }) } catch { return null }
    }
    try {
      const [pres, cres] = await Promise.all([
        profileChanged ? call(`/api/patients/${patient.id}/profile`, 'PATCH', body) : Promise.resolve(undefined),
        contactsChanged ? call(`/api/patients/${patient.id}/contacts`, 'PUT', { contacts: contactsPayload(form.contacts) }) : Promise.resolve(undefined),
      ])
      const profileOk = pres === undefined ? null : pres?.ok === true
      const contactsOk = cres === undefined ? null : cres?.ok === true
      let profileFailure: string | null = null, contactsFailure: string | null = null
      if (profileOk === false) {
        const e = pres ? await errorOf(pres, 'Could not save the profile.') : { message: 'Could not save the profile. Please try again.', data: null }
        setErrors(serverFieldErrors(e.data)); profileFailure = e.message
      }
      if (contactsOk === false) {
        const e = cres ? await errorOf(cres, 'Could not save the contacts.') : { message: 'Could not save the contacts. Please try again.', data: null }
        contactsFailure = e.message
      }

      // Remember what is now on file so a retry resends only what failed.
      setBaseline((b) => ({
        ...b,
        ...(profileOk ? { ...form, contacts: b.contacts } : {}),
        ...(contactsOk ? { contacts: form.contacts } : {}),
      }))

      if (!profileFailure && !contactsFailure) { onClose(); router.refresh(); return }
      if (profileFailure && contactsFailure) {
        setMessage(`Nothing was saved. Profile: ${profileFailure} Contacts: ${contactsFailure}`)
        return
      }
      if (profileOk === null) { setMessage(contactsFailure); return }
      if (contactsOk === null) { setMessage(profileFailure); return }
      if (contactsFailure) setMessage(`Profile changes were saved. Contacts were not saved: ${contactsFailure}`)
      else setMessage(`Contacts were saved. Profile changes were not saved: ${profileFailure}`)
      router.refresh()
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
              {form.abhaMode === 'provided' ? (
                <>
                  <Field label="ABHA number" error={errors.abha}>
                    {(p) => <input {...p} inputMode="numeric" autoComplete="off" value={form.abhaNumber} onChange={(e) => update('abhaNumber', e.target.value.replace(/[^\d\s-]/g, '').slice(0, 17))} className={INPUT_CLASS} />}
                  </Field>
                  <Field label="ABHA address">
                    {(p) => <input {...p} autoComplete="off" autoCapitalize="none" placeholder="name@abdm" value={form.abhaAddress} onChange={(e) => update('abhaAddress', e.target.value)} className={INPUT_CLASS} />}
                  </Field>
                </>
              ) : (
                <>
                  <SelectField label="Reason ABHA is not available" value={form.abhaUnavailableReason} onChange={(v) => update('abhaUnavailableReason', v)} options={ABHA_UNAVAILABLE_REASONS} error={errors.abha} />
                  <Field label={form.abhaUnavailableReason === 'other' ? 'Note (required)' : 'Note (optional)'}>
                    {(p) => <input {...p} autoComplete="off" value={form.abhaUnavailableNote} onChange={(e) => update('abhaUnavailableNote', e.target.value)} className={INPUT_CLASS} />}
                  </Field>
                </>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.abhaMode === 'unavailable'} onChange={(e) => update('abhaMode', e.target.checked ? 'unavailable' : 'provided')} />
              ABHA not available
            </label>
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
