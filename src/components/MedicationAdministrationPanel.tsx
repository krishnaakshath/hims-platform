'use client'
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface MedicationRecord {
  id: number
  medicationName: string
  dose: string
  scheduledFor: string
  status: 'scheduled' | 'given' | 'held' | 'refused'
  administeredAt: string | null
  administeredByName: string | null
  notes: string | null
}

// Same dot + plain-text-label convention as StatusChip/AssignmentStatusChip/
// AppointmentStatusChip, kept local for the same reason as NoteForm's
// NoteStatusPill: MAR status isn't any of those components' domain.
function MedStatusPill({ status }: { status: MedicationRecord['status'] }) {
  const config: Record<MedicationRecord['status'], { label: string; dotClassName: string; textClassName: string }> = {
    scheduled: { label: 'Scheduled', dotClassName: 'bg-primary', textClassName: 'text-foreground' },
    given: { label: 'Given', dotClassName: 'bg-success', textClassName: 'text-success' },
    held: { label: 'Held', dotClassName: 'bg-warning', textClassName: 'text-warning' },
    refused: { label: 'Refused', dotClassName: 'bg-destructive', textClassName: 'text-destructive' },
  }
  const { label, dotClassName, textClassName } = config[status]
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${textClassName}`}>
      <span className={`h-2 w-2 rounded-full ${dotClassName}`} aria-hidden="true" />
      {label}
    </span>
  )
}

export function MedicationAdministrationPanel({ admissionId, onClose }: { admissionId: number; onClose: () => void }) {
  const [medications, setMedications] = useState<MedicationRecord[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [medicationName, setMedicationName] = useState('')
  const [dose, setDose] = useState('')
  const [scheduledDate, setScheduledDate] = useState('')
  const [scheduledTime, setScheduledTime] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const [pendingReason, setPendingReason] = useState<{ medId: number; status: 'held' | 'refused'; reason: string } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actioningId, setActioningId] = useState<number | null>(null)

  async function load() {
    const res = await fetch(`/api/inpatient/admissions/${admissionId}/medications`)
    if (!res.ok) { setLoadError('Could not load the medication list.'); return }
    setLoadError(null)
    setMedications(await res.json())
  }

  // Fetch on mount via a plain .then chain (matching NotificationPanel's
  // convention) rather than calling the `load` helper directly, since the
  // latter trips react-hooks/set-state-in-effect (it calls setState after
  // its own internal await, which the linter's static analysis can't see is
  // deferred). `load` itself is reused for reloading after mutations below,
  // from event handlers rather than an effect.
  useEffect(() => {
    fetch(`/api/inpatient/admissions/${admissionId}/medications`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => { setLoadError(null); setMedications(data) })
      .catch(() => setLoadError('Could not load the medication list.'))
  }, [admissionId])

  async function addMedication() {
    setAdding(true)
    setAddError(null)
    const scheduledFor = scheduledDate && scheduledTime ? new Date(`${scheduledDate}T${scheduledTime}`).toISOString() : ''
    const res = await fetch(`/api/inpatient/admissions/${admissionId}/medications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ medicationName, dose, scheduledFor }),
    })
    setAdding(false)
    if (res.ok) {
      setMedicationName('')
      setDose('')
      setScheduledDate('')
      setScheduledTime('')
      await load()
      return
    }
    const body = await res.json().catch(() => null)
    setAddError(body?.error ?? 'Could not add this medication.')
  }

  const canAdd = Boolean(medicationName && dose && scheduledDate && scheduledTime) && !adding

  async function administer(medId: number, status: 'given' | 'held' | 'refused', notes?: string) {
    setActioningId(medId)
    setActionError(null)
    const res = await fetch(`/api/inpatient/admissions/${admissionId}/medications/${medId}/administer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, ...(notes ? { notes } : {}) }),
    })
    setActioningId(null)
    if (res.ok) {
      setPendingReason(null)
      await load()
      return
    }
    const body = await res.json().catch(() => null)
    setActionError(body?.error ?? 'Could not record this dose.')
  }

  function confirmPendingReason() {
    if (!pendingReason || !pendingReason.reason) return
    administer(pendingReason.medId, pendingReason.status, pendingReason.reason)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Medications (MAR)</DialogTitle>
        </DialogHeader>

        <div className="mb-3 flex flex-wrap items-end gap-2">
          <input value={medicationName} onChange={(e) => setMedicationName(e.target.value)} placeholder="Medication name" aria-label="Medication name" className="min-w-[9rem] flex-1 rounded-md border border-border px-3 py-2 text-sm" />
          <input value={dose} onChange={(e) => setDose(e.target.value)} placeholder="Dose" aria-label="Dose" className="w-28 rounded-md border border-border px-3 py-2 text-sm" />
          <input type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} aria-label="Scheduled date" className="rounded-md border border-border px-3 py-2 text-sm" />
          <input type="time" value={scheduledTime} onChange={(e) => setScheduledTime(e.target.value)} aria-label="Scheduled time" className="rounded-md border border-border px-3 py-2 text-sm" />
          <Button size="sm" onClick={addMedication} disabled={!canAdd}>Add medication</Button>
        </div>
        {addError && <p className="mb-2 text-sm text-destructive">{addError}</p>}

        {loadError && <p className="text-sm text-destructive">{loadError}</p>}
        {medications === null && !loadError && <p className="text-sm text-muted-foreground">Loading…</p>}
        {medications !== null && medications.length === 0 && <p className="text-sm text-muted-foreground">No medications ordered yet.</p>}

        {medications !== null && medications.length > 0 && (
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {medications.map((m) => (
              <div key={m.id} className="rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">{m.medicationName} <span className="font-normal text-muted-foreground">({m.dose})</span></p>
                    <p className="text-xs text-muted-foreground">Scheduled {new Date(m.scheduledFor).toLocaleString()}</p>
                    {m.status !== 'scheduled' && (
                      <p className="text-xs text-muted-foreground">
                        {m.status === 'given' ? 'Given' : m.status === 'held' ? 'Held' : 'Refused'} by {m.administeredByName} at {m.administeredAt ? new Date(m.administeredAt).toLocaleString() : '—'}
                        {m.notes && ` — ${m.notes}`}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <MedStatusPill status={m.status} />
                    {m.status === 'scheduled' && (
                      <>
                        <Button size="xs" onClick={() => administer(m.id, 'given')} disabled={actioningId === m.id}>Give</Button>
                        <Button size="xs" variant="outline" onClick={() => setPendingReason({ medId: m.id, status: 'held', reason: '' })} disabled={actioningId === m.id}>Hold</Button>
                        <Button size="xs" variant="destructive" onClick={() => setPendingReason({ medId: m.id, status: 'refused', reason: '' })} disabled={actioningId === m.id}>Refuse</Button>
                      </>
                    )}
                  </div>
                </div>
                {pendingReason?.medId === m.id && (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      value={pendingReason.reason}
                      onChange={(e) => setPendingReason({ ...pendingReason, reason: e.target.value })}
                      placeholder={`Reason for ${pendingReason.status === 'held' ? 'holding' : 'refusing'} this dose (required)`}
                      aria-label="Reason"
                      className="flex-1 rounded-md border border-border px-3 py-1.5 text-sm"
                    />
                    <Button size="xs" variant="outline" onClick={() => setPendingReason(null)}>Cancel</Button>
                    <Button size="xs" onClick={confirmPendingReason} disabled={!pendingReason.reason || actioningId === m.id}>Confirm</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {actionError && <p className="mt-2 text-sm text-destructive">{actionError}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
