'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useBrand } from '@/components/BrandProvider'

interface NewPatientForm {
  name: string
  dob: string
  email: string
  phone: string
  city: string
  zip: string
  currentProvider: string
  primaryPayerId: string
  primaryMemberId: string
  primaryGroupNumber: string
  primaryPlanType: string
  primarySubscriberName: string
  primarySubscriberRelationship: string
}

const EMPTY_FORM: NewPatientForm = {
  name: '', dob: '', email: '', phone: '', city: '', zip: '', currentProvider: '',
  primaryPayerId: '', primaryMemberId: '', primaryGroupNumber: '', primaryPlanType: '',
  primarySubscriberName: '', primarySubscriberRelationship: '',
}

interface PayerOption {
  id: number
  name: string
}

export function AddClientModal({ onClose }: { onClose: () => void }) {
  const { name: brandName } = useBrand()
  const router = useRouter()
  const [form, setForm] = useState<NewPatientForm>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [payerOptions, setPayerOptions] = useState<PayerOption[]>([])

  useEffect(() => {
    fetch('/api/payers')
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setPayerOptions(data))
      .catch(() => setPayerOptions([]))
  }, [])

  function update<K extends keyof NewPatientForm>(key: K, value: NewPatientForm[K]) {
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
    setSubmitting(true)
    setError(null)
    const res = await fetch('/api/patients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: form.name,
        dob: form.dob,
        email: form.email || undefined,
        phone: form.phone || undefined,
        city: form.city || undefined,
        zip: form.zip || undefined,
        currentProvider: form.currentProvider || undefined,
        primaryPayerId: form.primaryPayerId ? Number(form.primaryPayerId) : undefined,
        primaryMemberId: form.primaryPayerId ? (form.primaryMemberId || undefined) : undefined,
        primaryGroupNumber: form.primaryPayerId ? (form.primaryGroupNumber || undefined) : undefined,
        primaryPlanType: form.primaryPayerId ? (form.primaryPlanType || undefined) : undefined,
        primarySubscriberName: form.primaryPayerId ? (form.primarySubscriberName || undefined) : undefined,
        primarySubscriberRelationship: form.primaryPayerId ? (form.primarySubscriberRelationship || undefined) : undefined,
      }),
    })
    setSubmitting(false)
    if (!res.ok) {
      setError('Could not add this patient. Please check the details and try again.')
      return
    }
    // Navigate straight to the new patient's detail page rather than just
    // refreshing the current page -- an admin who just added a patient
    // wants to see it, not go find it themselves in the list.
    const created = await res.json()
    onClose()
    router.push(`/patients/${created.id}`)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add New Patient</DialogTitle>
        </DialogHeader>
        <p className="-mt-2 text-xs text-muted-foreground">
          This creates a new patient chart in {brandName}.
        </p>

        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Basic info</p>
          <input value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="Full name" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <input value={form.dob} onChange={(e) => update('dob', e.target.value)} type="date" aria-label="Date of birth" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <div className="grid grid-cols-2 gap-3">
            <input value={form.email} onChange={(e) => update('email', e.target.value)} placeholder="Email (optional)" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            <input value={form.phone} onChange={(e) => update('phone', e.target.value)} placeholder="Phone (optional)" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input value={form.city} onChange={(e) => update('city', e.target.value)} placeholder="City (optional)" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            <input value={form.zip} onChange={(e) => update('zip', e.target.value)} placeholder="Zip (optional)" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          </div>

          <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Care details</p>
          <input value={form.currentProvider} onChange={(e) => update('currentProvider', e.target.value)} placeholder="Current provider (optional)" className="w-full rounded-md border border-border px-3 py-2 text-sm" />

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

        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !form.name || !form.dob}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
