'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface PatientOption { id: string; name: string }

// Inline filing control rendered in the Documents table's Patient column
// when `canWrite`. A plain <select>, not a typeahead -- no patient-
// autocomplete component exists in this codebase, and this is the same
// "anonymous id, pick from a list" call CheckInModal/ConfirmBookingRequestModal
// already make for patient entry.
export function AssignDocumentPatientControl({ documentId, patientId, patientName, patientDob, patientOptions }: {
  documentId: number
  patientId: string | null
  patientName: string | null
  patientDob: string | null
  patientOptions: PatientOption[]
}) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value
    setSaving(true)
    setError(null)
    const res = await fetch(`/api/documents/${documentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientId: value === '' ? null : value }),
    })
    setSaving(false)
    if (res.ok) { router.refresh(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not file this document.')
  }

  return (
    <div>
      <select
        value={patientId ?? ''}
        onChange={handleChange}
        disabled={saving}
        aria-label="Patient"
        className="w-full rounded-md border border-border px-2 py-1 text-xs disabled:opacity-50"
      >
        <option value="">— Unfiled —</option>
        {patientOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {patientId && (
        <p className="mt-0.5 text-xs text-muted-foreground">
          {patientName ?? patientId}{patientDob ? ` (DOB ${patientDob})` : ''}
        </p>
      )}
      {error && <p className="mt-0.5 text-xs text-destructive">{error}</p>}
    </div>
  )
}
