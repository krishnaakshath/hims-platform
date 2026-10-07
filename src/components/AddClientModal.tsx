'use client'
import { sendJson } from '@/lib/client-fetch'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useBrand } from '@/components/BrandProvider'
import { DemographicsSection } from '@/components/registration/DemographicsSection'
import { AddressSection } from '@/components/registration/AddressSection'
import { NationalIdSection } from '@/components/registration/NationalIdSection'
import { ContactsSection } from '@/components/registration/ContactsSection'
import { FrontDeskDuplicateWarning } from '@/components/FrontDeskPatientSearch'
import {
  EMPTY_REGISTRATION_FORM, toRegistrationPayload, fieldErrors, serverFieldErrors, type RegistrationFormState,
} from '@/components/registration/registration-form-state'

interface PayerOption {
  id: number
  name: string
}

export function AddClientModal({ onClose }: { onClose: () => void }) {
  const { name: brandName } = useBrand()
  const router = useRouter()
  const [form, setForm] = useState<RegistrationFormState>(EMPTY_REGISTRATION_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [payerOptions, setPayerOptions] = useState<PayerOption[]>([])

  useEffect(() => {
    fetch('/api/payers')
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setPayerOptions(data))
      .catch(() => setPayerOptions([]))
  }, [])

  function update<K extends keyof RegistrationFormState>(key: K, value: RegistrationFormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
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

  async function submit() {
    setError(null)
    const payload = toRegistrationPayload(form)
    const local = fieldErrors(payload)
    setErrors(local)
    if (Object.keys(local).length > 0) {
      setError('Please correct the highlighted fields.')
      return
    }
    setSubmitting(true)
    try {
      const res = await sendJson<{ id: string }>('/api/patients', 'POST', payload)
      if (res.ok) {
        onClose()
        // Navigate straight to the new patient's page so the front desk sees it.
        router.push(`/patients/${res.data.id}`)
        return
      }
      if (res.status === 400) {
        setErrors(serverFieldErrors(res.body))
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

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add New Patient</DialogTitle>
        </DialogHeader>
        <p className="-mt-2 text-xs text-muted-foreground">
          This creates a new patient chart in {brandName}.
        </p>

        <div className="space-y-4">
          <DemographicsSection form={form} update={update} errors={errors} />
          {/* Wave B P1-10: advisory duplicate check (name + DOB, or mobile). */}
          <FrontDeskDuplicateWarning name={form.name} dob={form.dob} phone={form.phone} />
          <AddressSection form={form} update={update} errors={errors} />
          <NationalIdSection form={form} update={update} errors={errors} />
          <ContactsSection form={form} update={update} errors={errors} />

          <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Care details</p>
          <input value={form.currentProvider} onChange={(e) => update('currentProvider', e.target.value)} aria-label="Current provider (optional)" placeholder="Current provider (optional)" className="w-full rounded-md border border-border px-3 py-2 text-sm" />

          <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Insurance (optional)</p>
          <select value={form.primaryPayerId} onChange={(e) => selectPayer(e.target.value)} className="w-full rounded-md border border-border px-3 py-2 text-sm">
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
        </div>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !form.name || !form.dob}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
