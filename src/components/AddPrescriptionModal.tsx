'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Sparkles } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { MedicationWithInventory } from '@/lib/queries/medications'
import { suggestMedicationsForDiagnoses } from '@/lib/medication-suggestions'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

// `catalog` comes from listMedicationsWithInventory(), which inner-joins
// medicationInventory -- a catalog drug with no inventory row is simply not
// listed here at all. "Not in our catalog" is the escape hatch both for
// that case and for a genuinely unstocked/off-formulary drug (spec §4);
// `medicationId` stays null on that path.
export function AddPrescriptionModal({
  patientId, catalog, activeProviders, needsOnBehalfOf, diagnosisCodes, onClose,
}: {
  patientId: string
  catalog: MedicationWithInventory[]
  activeProviders: { id: number; name: string; specialty: string }[]
  needsOnBehalfOf: boolean
  diagnosisCodes: string[]
  onClose: () => void
}) {
  const suggestions = suggestMedicationsForDiagnoses(diagnosisCodes, catalog)
  const router = useRouter()
  const [offCatalog, setOffCatalog] = useState(false)
  const [medicationId, setMedicationId] = useState<number | ''>('')
  const [name, setName] = useState('')
  const [medicationClass, setMedicationClass] = useState('')
  const [dose, setDose] = useState('')
  const [frequencyPerDay, setFrequencyPerDay] = useState(1)
  const [durationDays, setDurationDays] = useState(30)
  const [startDate, setStartDate] = useState(today)
  const [instructions, setInstructions] = useState('')
  const [onBehalfOfProviderId, setOnBehalfOfProviderId] = useState<number | ''>('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ id: number } | null>(null)

  function pickCatalogMedication(id: number | '') {
    setMedicationId(id)
    if (id === '') return
    const match = catalog.find((c) => c.id === id)
    if (match) {
      setName(match.name)
      setMedicationClass(match.medicationClass)
      if (match.commonDose) setDose(match.commonDose)
    }
  }

  function toggleOffCatalog(checked: boolean) {
    setOffCatalog(checked)
    setMedicationId('')
    if (checked) {
      setName('')
      setMedicationClass('')
    }
  }

  const canSubmit =
    !submitting &&
    name.trim().length > 0 &&
    medicationClass.trim().length > 0 &&
    frequencyPerDay >= 1 && frequencyPerDay <= 6 &&
    durationDays >= 1 && durationDays <= 365 &&
    startDate.length > 0 &&
    (!needsOnBehalfOf || onBehalfOfProviderId !== '')

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await fetch(`/api/patients/${patientId}/prescriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        medicationId: medicationId === '' ? null : medicationId,
        name,
        medicationClass,
        dose: dose.trim() === '' ? null : dose,
        frequencyPerDay,
        durationDays,
        startDate,
        instructions: instructions.trim() === '' ? null : instructions,
        ...(needsOnBehalfOf && onBehalfOfProviderId !== '' ? { onBehalfOfProviderId } : {}),
      }),
    })
    setSubmitting(false)
    if (res.ok) {
      const body = await res.json()
      setCreated(body)
      return
    }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not save this prescription.')
  }

  // Closing without printing is fine -- the Print link stays permanently
  // available on the medication row once the page refreshes.
  function done() {
    router.refresh()
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Prescription</DialogTitle>
        </DialogHeader>

        {created ? (
          <>
            <div className="max-h-[60vh] space-y-3 overflow-y-auto">
              <p className="text-sm text-foreground">Prescription saved.</p>
              <a
                href={`/prescriptions/print?ids=${created.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium text-primary hover:underline"
              >
                Print prescription
              </a>
            </div>
            <DialogFooter>
              <Button onClick={done}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="max-h-[60vh] space-y-3 overflow-y-auto">
              {!offCatalog && suggestions.length > 0 && (
                <div className="rounded-md border border-accent/20 bg-accent/5 p-2.5">
                  <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
                    <Sparkles className="h-3 w-3" aria-hidden="true" />
                    Commonly used for this patient&apos;s diagnosis — verify appropriateness
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map((s) => (
                      <button
                        key={s.medication.id}
                        type="button"
                        onClick={() => pickCatalogMedication(s.medication.id)}
                        title={`Suggested for ${s.diagnosisCode} — ${s.diagnosisLabel}`}
                        className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                          medicationId === s.medication.id
                            ? 'border-accent bg-accent text-accent-foreground'
                            : 'border-accent/30 bg-white text-accent hover:bg-accent/10'
                        }`}
                      >
                        {s.medication.name} <span className="opacity-70">({s.medication.medicationClass})</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {!offCatalog && (
                <select
                  aria-label="Medication"
                  value={medicationId}
                  onChange={(e) => pickCatalogMedication(e.target.value === '' ? '' : Number(e.target.value))}
                  className="w-full rounded-md border border-border px-3 py-2 text-sm"
                >
                  <option value="">Select a medication…</option>
                  {catalog.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={offCatalog} onChange={(e) => toggleOffCatalog(e.target.checked)} />
                Not in our catalog
              </label>
              {offCatalog && (
                <>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Medication name"
                    aria-label="Medication name"
                    className="w-full rounded-md border border-border px-3 py-2 text-sm"
                  />
                  <input
                    value={medicationClass}
                    onChange={(e) => setMedicationClass(e.target.value)}
                    placeholder="Medication class"
                    aria-label="Medication class"
                    className="w-full rounded-md border border-border px-3 py-2 text-sm"
                  />
                </>
              )}
              <input
                value={dose}
                onChange={(e) => setDose(e.target.value)}
                placeholder="Dose (optional)"
                aria-label="Dose"
                className="w-full rounded-md border border-border px-3 py-2 text-sm"
              />
              <input
                type="number"
                min={1}
                max={6}
                value={frequencyPerDay}
                onChange={(e) => setFrequencyPerDay(Number(e.target.value))}
                aria-label="Times per day"
                className="w-full rounded-md border border-border px-3 py-2 text-sm"
              />
              <input
                type="number"
                min={1}
                max={365}
                value={durationDays}
                onChange={(e) => setDurationDays(Number(e.target.value))}
                aria-label="Duration (days)"
                className="w-full rounded-md border border-border px-3 py-2 text-sm"
              />
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                aria-label="Start date"
                className="w-full rounded-md border border-border px-3 py-2 text-sm"
              />
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                maxLength={500}
                placeholder="Instructions (optional)"
                aria-label="Instructions"
                className="w-full rounded-md border border-border px-3 py-2 text-sm"
              />
              {needsOnBehalfOf && (
                <select
                  aria-label="Prescribing as"
                  value={onBehalfOfProviderId}
                  onChange={(e) => setOnBehalfOfProviderId(e.target.value === '' ? '' : Number(e.target.value))}
                  className="w-full rounded-md border border-border px-3 py-2 text-sm"
                >
                  <option value="">Select a provider…</option>
                  {activeProviders.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.specialty}</option>)}
                </select>
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={submit} disabled={!canSubmit}>Save prescription</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
