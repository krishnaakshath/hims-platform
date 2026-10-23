'use client'
import { fetchJson, sendJson } from '@/lib/client-fetch'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { useBrand } from '@/components/BrandProvider'
import { DemographicsSection } from '@/components/registration/DemographicsSection'
import { AddressSection } from '@/components/registration/AddressSection'
import { NationalIdSection } from '@/components/registration/NationalIdSection'
import { ContactsSection } from '@/components/registration/ContactsSection'
import { Field, INPUT_CLASS, SectionHeading } from '@/components/registration/Field'
import { RegistrationStepper } from '@/components/registration/RegistrationStepper' // WS6 T8
import { PhotoCapture } from '@/components/registration/PhotoCapture' // WS6 T8
import { NextAvailableHint } from '@/components/registration/NextAvailableHint' // WS6 T8
import { FrontDeskDuplicateWarning } from '@/components/FrontDeskPatientSearch'
import {
  EMPTY_REGISTRATION_FORM, toRegistrationPayload, fieldErrors, serverFieldErrors, type RegistrationFormState,
  REGISTRATION_STEPS, errorsForStep, errorRootOf, stepOfErrorKey,
} from '@/components/registration/registration-form-state'
import { REFERRAL_SOURCES, GENDERS, INDIAN_STATES } from '@/lib/india/reference'

interface PayerOption {
  id: number
  name: string
}

// WS6 T8: an unsaved registration is kept in sessionStorage (this tab only) while the
// dialog is open, so an accidental close or reload does not lose it; it is removed on
// success. Aadhaar and the other identifiers (DRAFT_OMIT) are never written there. A dialog opened pre-filled
// (`initial`: Scan & Share, a booking request) carries its own source and keeps no draft.
const DRAFT_KEY = 'hims.registration-draft.v1'
interface Draft { form: RegistrationFormState; step: number }
// Identifiers never kept in the draft (blanked on write and on read): Aadhaar, ABHA and its
// ABDM flow, KYC document number, MLC number, insurance member id.
const DRAFT_OMIT = ['aadhaarNumber', 'abhaNumber', 'abhaAddress', 'abhaFlowId', 'kycDocNumber', 'mlcNumber', 'primaryMemberId'] as const
function withoutSensitive(form: RegistrationFormState): RegistrationFormState {
  const out = { ...form }
  for (const k of DRAFT_OMIT) out[k] = ''
  return out
}

function readDraft(): Draft | null {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const d = JSON.parse(raw) as Partial<Draft>
    if (!d || typeof d !== 'object' || !d.form || typeof d.form !== 'object') return null
    const step = typeof d.step === 'number' && d.step >= 0 && d.step < REGISTRATION_STEPS.length ? d.step : 0
    return { form: withoutSensitive({ ...EMPTY_REGISTRATION_FORM, ...d.form }), step }
  } catch {
    return null
  }
}
function writeDraft(d: Draft) {
  try { window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...d, form: withoutSensitive(d.form) })) } catch { /* storage unavailable */ }
}
function clearDraft() {
  try { window.sessionStorage.removeItem(DRAFT_KEY) } catch { /* storage unavailable */ }
}

/** Error roots of the fields that already hold a value (a restored draft or a pre-filled form). */
function filledRoots(form: RegistrationFormState): Set<string> {
  const out = new Set<string>()
  for (const k of Object.keys(form) as (keyof RegistrationFormState)[]) {
    const v = form[k]
    const empty = EMPTY_REGISTRATION_FORM[k]
    if (JSON.stringify(v) !== JSON.stringify(empty)) out.add(errorRootOf(k))
  }
  return out
}

const label = (list: readonly { code: string; label: string }[], code: string) => list.find((x) => x.code === code)?.label ?? code

// SP8: `initial` pre-fills the form (a Scan & Share profile); `onRegistered`
// runs after the patient is created, before navigating to them. WS6 T7:
// `navigateToPatient={false}` stays on the page (register from a booking request).
// WS6 T8: four steps (Identity -> Contact & address -> IDs & insurance -> Review); Next stays
// disabled while the current step has errors.
export function AddClientModal({ onClose, initial, onRegistered, navigateToPatient = true }: {
  onClose: () => void
  initial?: RegistrationFormState
  onRegistered?: (patientId: string) => Promise<void> | void
  navigateToPatient?: boolean
}) {
  const { name: brandName } = useBrand()
  const router = useRouter()
  const toast = useToast()
  const keepsDraft = !initial
  const [restored] = useState<Draft | null>(() => (keepsDraft ? readDraft() : null))
  const [form, setForm] = useState<RegistrationFormState>(initial ?? restored?.form ?? EMPTY_REGISTRATION_FORM)
  const [step, setStep] = useState(restored?.step ?? 0)
  const [touched, setTouched] = useState<Set<string>>(() => filledRoots(initial ?? restored?.form ?? EMPTY_REGISTRATION_FORM))
  const [draftNotice, setDraftNotice] = useState(restored !== null)
  const [photo, setPhoto] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [payerOptions, setPayerOptions] = useState<PayerOption[]>([])

  useEffect(() => {
    fetch('/api/payers')
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setPayerOptions(data))
      .catch(() => setPayerOptions([]))
  }, [])

  const registered = useRef(false) // no draft is written once the patient exists
  useEffect(() => {
    if (!keepsDraft || registered.current) return
    // Nothing typed yet (or only identifiers, which are never kept): no draft.
    if (filledRoots(withoutSensitive(form)).size === 0) clearDraft()
    else writeDraft({ form, step })
  }, [keepsDraft, form, step])

  const liveErrors = useMemo(() => fieldErrors(toRegistrationPayload(form)), [form])
  // A live error shows once its field was touched (a doctor referral's note with its source,
  // the guardian rule with the date of birth); a server error shows until its field changes.
  const errors = useMemo(() => {
    const shown: Record<string, string> = {}
    for (const [k, v] of Object.entries(liveErrors)) {
      const root = k.split('.')[0]
      if (touched.has(root) || (root === 'referralNote' && touched.has('referralSource')) || (root === 'contacts' && touched.has('dob'))) shown[k] = v
    }
    return { ...shown, ...serverErrors }
  }, [liveErrors, touched, serverErrors])
  const stepBlocked = step < REGISTRATION_STEPS.length - 1 && Object.keys(errorsForStep(liveErrors, step)).length > 0

  function update<K extends keyof RegistrationFormState>(key: K, value: RegistrationFormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
    const root = errorRootOf(key)
    setTouched((t) => (t.has(root) ? t : new Set(t).add(root)))
    setServerErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k.split('.')[0] !== root)))
  }

  function selectPayer(value: string) {
    setForm((f) => ({
      ...f,
      primaryPayerId: value,
      // Default the subscriber fields the first time a payer is picked
      // (going from "no insurance" to "insurance"), without stomping on
      // anything the user already typed if they're just switching payers.
      primarySubscriberName: f.primaryPayerId === '' && value !== '' ? f.name : f.primarySubscriberName,
      primarySubscriberRelationship: f.primaryPayerId === '' && value !== '' ? 'self' : f.primarySubscriberRelationship,
    }))
  }

  function startOver() {
    clearDraft()
    setForm(EMPTY_REGISTRATION_FORM)
    setTouched(new Set())
    setServerErrors({})
    setStep(0)
    setDraftNotice(false)
  }

  function goToFirstErrorStep(errs: Record<string, string>) {
    const steps = Object.keys(errs).map(stepOfErrorKey)
    if (steps.length > 0) setStep(Math.min(...steps))
  }

  /** WS6 T8: the photo goes up only once the patient exists; a failure never undoes registration. */
  async function uploadPhoto(patientId: string) {
    if (!photo) return
    const body = new FormData()
    body.append('file', photo)
    const res = await fetchJson(`/api/patients/${encodeURIComponent(patientId)}/photo`, { method: 'POST', body })
    if (!res.ok) toast.show({ tone: 'error', title: 'Photo not saved', description: `The patient is registered. ${res.error}` })
  }

  async function submit() {
    setError(null)
    const payload = toRegistrationPayload(form)
    const local = fieldErrors(payload)
    if (Object.keys(local).length > 0) {
      setTouched(new Set(Object.keys(local).map((k) => k.split('.')[0])))
      goToFirstErrorStep(local)
      setError('Please correct the highlighted fields.')
      return
    }
    setSubmitting(true)
    try {
      const res = await sendJson<{ id: string; uhid?: string | null }>('/api/patients', 'POST', payload)
      if (res.ok) {
        const id = String(res.data.id)
        registered.current = true
        clearDraft()
        await uploadPhoto(id)
        if (onRegistered) await onRegistered(res.data.id) // SP8
        toast.show({
          title: 'Patient registered',
          description: res.data.uhid ? `UHID ${res.data.uhid}` : undefined,
          action: { label: 'Check in now', href: `/front-desk/check-in?patient=${encodeURIComponent(id)}` },
          secondaryAction: { label: 'Print registration slip', href: `/print/registration/${encodeURIComponent(id)}` },
        })
        onClose()
        if (!navigateToPatient) return
        // Navigate straight to the new patient's page so the front desk sees
        // it; ?registered=1 shows the registration-slip / check-in banner (Wave C).
        router.push(`/patients/${encodeURIComponent(id)}?registered=1`)
        return
      }
      if (res.status === 400) {
        const server = serverFieldErrors(res.body)
        setServerErrors(server)
        goToFirstErrorStep(server)
        setError('Please correct the highlighted fields.')
      } else {
        // 409 duplicate: the route's own message; anything else: the fixed one.
        setError(res.error)
      }
    } catch {
      setError('Could not add this patient. Please try again.')
    } finally {
      // The Aadhaar number never outlives the attempt, success or failure.
      setForm((f) => ({ ...f, aadhaarNumber: '' }))
      setSubmitting(false)
    }
  }

  const last = REGISTRATION_STEPS.length - 1
  const payerName = payerOptions.find((p) => String(p.id) === form.primaryPayerId)?.name

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add New Patient</DialogTitle>
        </DialogHeader>
        <p className="-mt-2 text-xs text-muted-foreground">
          This creates a new patient chart in {brandName}.
        </p>
        <RegistrationStepper steps={REGISTRATION_STEPS} current={step} />
        {draftNotice && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted px-3 py-2 text-xs">
            <span>Restored an unsaved registration from this session.</span>
            <Button type="button" variant="outline" size="xs" onClick={startOver}>Start over</Button>
          </div>
        )}

        <div className="space-y-4">
          {step === 0 && (
            <>
              <DemographicsSection form={form} update={update} errors={errors} />
              {/* Wave B P1-10: advisory duplicate check (name + DOB, or mobile). */}
              <FrontDeskDuplicateWarning name={form.name} dob={form.dob} phone={form.phone} />
              <section aria-label="Referral" className="space-y-3">
                <SectionHeading>Referral</SectionHeading>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Referral source" error={errors.referralSource}>
                    {(p) => (
                      <select {...p} value={form.referralSource} onChange={(e) => update('referralSource', e.target.value)} className={INPUT_CLASS}>
                        <option value="">Not recorded</option>
                        {REFERRAL_SOURCES.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
                      </select>
                    )}
                  </Field>
                  {form.referralSource && (
                    <Field label={form.referralSource === 'doctor' ? 'Referring doctor' : 'Referral note'} required={form.referralSource === 'doctor'} error={errors.referralNote}>
                      {(p) => <input {...p} autoComplete="off" value={form.referralNote} onChange={(e) => update('referralNote', e.target.value)} className={INPUT_CLASS} />}
                    </Field>
                  )}
                </div>
              </section>
              <PhotoCapture onCaptured={setPhoto} />
            </>
          )}

          {step === 1 && (
            <>
              <AddressSection form={form} update={update} errors={errors} />
              <ContactsSection form={form} update={update} errors={errors} />
            </>
          )}

          {step === 2 && (
            <>
              <NationalIdSection form={form} update={update} errors={errors} />

              <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Care details</p>
              <input value={form.currentProvider} onChange={(e) => update('currentProvider', e.target.value)} aria-label="Current provider (optional)" placeholder="Current provider (optional)" className="w-full rounded-md border border-border px-3 py-2 text-sm" />

              <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Insurance (optional)</p>
              <select value={form.primaryPayerId} onChange={(e) => selectPayer(e.target.value)} aria-label="Insurance payer" className="w-full rounded-md border border-border px-3 py-2 text-sm">
                <option value="">No insurance on file</option>
                {payerOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {form.primaryPayerId && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <input value={form.primaryMemberId} onChange={(e) => update('primaryMemberId', e.target.value)} placeholder="Member ID" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
                    <input value={form.primaryGroupNumber} onChange={(e) => update('primaryGroupNumber', e.target.value)} placeholder="Group number" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
                  </div>
                  <select value={form.primaryPlanType} onChange={(e) => update('primaryPlanType', e.target.value)} className="w-full rounded-md border border-border px-3 py-2 text-sm">
                    <option value="">Plan type</option>
                    <option value="ppo">PPO</option><option value="hmo">HMO</option><option value="epo">EPO</option><option value="pos">POS</option><option value="medicare">Medicare</option><option value="medicaid">Medicaid</option>
                  </select>
                  <div className="grid grid-cols-2 gap-3">
                    <input value={form.primarySubscriberName} onChange={(e) => update('primarySubscriberName', e.target.value)} placeholder="Subscriber name" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
                    <select value={form.primarySubscriberRelationship} onChange={(e) => update('primarySubscriberRelationship', e.target.value)} className="w-full rounded-md border border-border px-3 py-2 text-sm">
                      <option value="self">Self</option>
                      <option value="spouse">Spouse</option>
                      <option value="child">Child</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                </>
              )}
            </>
          )}

          {step === last && (
            <>
              <section aria-label="Review" className="space-y-2">
                <SectionHeading>Review</SectionHeading>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Name</dt><dd>{form.name}</dd>
                  <dt className="text-muted-foreground">Date of birth</dt><dd>{form.dob}</dd>
                  <dt className="text-muted-foreground">Gender</dt><dd>{label(GENDERS, form.gender)}</dd>
                  {form.phone && <><dt className="text-muted-foreground">Mobile</dt><dd>{form.phone}</dd></>}
                  <dt className="text-muted-foreground">Address</dt>
                  <dd>{[form.addressLine1, form.city, form.district, label(INDIAN_STATES, form.stateCode), form.pinCode].filter(Boolean).join(', ')}</dd>
                  <dt className="text-muted-foreground">Aadhaar</dt><dd>{form.aadhaarMode === 'provided' ? 'Provided with consent' : 'Not provided'}</dd>
                  <dt className="text-muted-foreground">ABHA</dt><dd>{form.abhaMode === 'provided' ? (form.abhaNumber || form.abhaAddress) : 'Not available'}</dd>
                  <dt className="text-muted-foreground">Insurance</dt><dd>{payerName ?? 'None on file'}</dd>
                  {form.referralSource && <><dt className="text-muted-foreground">Referral</dt><dd>{[label(REFERRAL_SOURCES, form.referralSource), form.referralNote].filter(Boolean).join(' · ')}</dd></>}
                  <dt className="text-muted-foreground">Photo</dt><dd>{photo ? 'Captured' : 'None'}</dd>
                </dl>
              </section>
              <NextAvailableHint />
            </>
          )}
        </div>

        {stepBlocked && <p className="text-xs text-muted-foreground">Complete the required fields on this step to continue.</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {step > 0 && <Button variant="outline" onClick={() => setStep((s) => s - 1)}>Back</Button>}
          {step < last
            ? <Button onClick={() => setStep((s) => s + 1)} disabled={stepBlocked}>Next</Button>
            : <Button onClick={submit} disabled={submitting}>Save</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
