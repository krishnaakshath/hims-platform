'use client'
// WS1 T7: the multi-drug prescription builder for a visit. Posts to POST /api/encounters/[id]/prescriptions.
// The allergy preview here is a convenience; the server stays authoritative (a 422 maps back onto the row).
import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fetchJson, sendJson } from '@/lib/client-fetch'
import { parseDosePattern, prescribedQuantity, type MedicationForm } from '@/lib/prescriptions/dose-pattern'
import { allergyConflicts, type AllergyConflict, type AllergyInput } from '@/lib/prescriptions/allergy-check'
import { FOOD_TIMINGS, ROUTES } from '@/lib/prescriptions/validation'

const PATTERN_CHIPS = ['1-0-0', '0-0-1', '1-0-1', '1-1-1', '1-1-1-1'] as const
const FOOD_LABEL: Record<string, string> = { before_food: 'Before food', after_food: 'After food', with_food: 'With food', any: 'Any time' }

interface Drug {
  id: number | null
  name: string
  genericName: string | null
  medicationClass: string
  form: MedicationForm | null
  commonDose: string | null
}
interface Row {
  key: number
  drug: Drug | null
  query: string
  results: Drug[]
  dose: string
  pattern: string
  isSos: boolean
  days: number
  route: (typeof ROUTES)[number]
  foodTiming: string
  instructions: string
  overrideReason: string
  serverConflicts: AllergyConflict[]
}

let nextKey = 1
const emptyRow = (): Row => ({
  key: nextKey++, drug: null, query: '', results: [], dose: '', pattern: '', isSos: false, days: 5,
  route: 'oral', foodTiming: '', instructions: '', overrideReason: '', serverConflicts: [],
})

function rowConflicts(row: Row, allergies: AllergyInput[]): AllergyConflict[] {
  const local = row.drug
    ? allergyConflicts({ name: row.drug.name, genericName: row.drug.genericName, medicationClass: row.drug.medicationClass }, allergies)
    : []
  const seen = new Set(local.map((c) => c.allergen))
  return [...local, ...row.serverConflicts.filter((c) => !seen.has(c.allergen))]
}

export function RxBuilder({ encounterId, patientAllergies, allergyStatus, canWrite, onSaved }: {
  encounterId: number
  patientAllergies: AllergyInput[]
  allergyStatus: 'unknown' | 'none_known' | 'recorded'
  canWrite: boolean
  onSaved?: (prescriptionId: number) => void
}) {
  const [rows, setRows] = useState<Row[]>(() => [emptyRow()])
  const [advice, setAdvice] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ prescriptionId: number; episodeIds: number[] } | null>(null)

  const patch = (key: number, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))

  // Debounced catalogue search for the row being typed in.
  const searchTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const timers = searchTimers.current
    return () => { timers.forEach(clearTimeout) }
  }, [])
  function onQuery(key: number, q: string) {
    patch(key, { query: q, drug: null, results: [] })
    clearTimeout(searchTimers.current.get(key))
    if (q.trim().length < 2) return
    searchTimers.current.set(key, setTimeout(async () => {
      const res = await fetchJson<{ items: (Omit<Drug, 'id'> & { id: number })[] }>(`/api/medications/search?q=${encodeURIComponent(q.trim())}`)
      if (res.ok) patch(key, { results: res.data.items })
    }, 200))
  }
  function choose(key: number, drug: Drug) {
    patch(key, { drug, query: drug.name, results: [], dose: drug.commonDose ?? '' })
  }

  if (!canWrite) {
    return <p className="text-sm text-muted-foreground">You do not have permission to write prescriptions.</p>
  }

  const blocked = (r: Row) => {
    const c = rowConflicts(r, patientAllergies)
    return c.length > 0 && r.overrideReason.trim().length < 5
  }
  const rowReady = (r: Row) =>
    r.drug !== null && r.dose.trim().length > 0 && r.days >= 1 && r.days <= 365 &&
    (r.isSos || parseDosePattern(r.pattern) !== null) && !blocked(r)
  const canSave = !saving && !saved && rows.length > 0 && rows.every(rowReady)

  async function save() {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    const items = rows.map((r) => {
      const d = r.drug!
      const hasConflict = rowConflicts(r, patientAllergies).length > 0
      return {
        medicationId: d.id,
        name: d.name,
        ...(d.genericName ? { genericName: d.genericName } : {}),
        medicationClass: d.medicationClass,
        dose: r.dose.trim(),
        ...(!r.isSos ? { dosePattern: parseDosePattern(r.pattern)!.label } : {}),
        isSos: r.isSos,
        durationDays: r.days,
        route: r.route,
        ...(r.foodTiming ? { foodTiming: r.foodTiming } : {}),
        ...(r.instructions.trim() ? { instructions: r.instructions.trim() } : {}),
        ...(hasConflict ? { allergyOverrideReason: r.overrideReason.trim() } : {}),
      }
    })
    const res = await sendJson<{ prescriptionId: number; episodeIds: number[] }>(
      `/api/encounters/${encounterId}/prescriptions`, 'POST',
      { items, ...(advice.trim() ? { advice: advice.trim() } : {}) },
    )
    savingRef.current = false
    setSaving(false)
    if (res.ok) {
      setSaved(res.data)
      onSaved?.(res.data.prescriptionId)
      return
    }
    const body = res.body as { code?: string; conflicts?: { index: number; conflicts: AllergyConflict[] }[]; index?: number } | undefined
    if (res.status === 422 && body?.code === 'allergy_conflict' && Array.isArray(body.conflicts)) {
      setRows((rs) => rs.map((r, i) => {
        const hit = body.conflicts!.find((c) => c.index === i)
        return hit ? { ...r, serverConflicts: hit.conflicts } : r
      }))
      return
    }
    setError(res.error)
  }

  if (saved) {
    return (
      <div role="status" className="space-y-2 rounded-md border border-border p-3 text-sm">
        <p>Prescription saved.</p>
        <a href={`/prescriptions/print?ids=${saved.episodeIds.join(',')}`} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline">Print</a>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {allergyStatus === 'unknown' && (
        <p role="note" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
          Allergy status not recorded for this patient. Ask about allergies before prescribing.
        </p>
      )}
      {rows.map((row, idx) => {
        const conflicts = rowConflicts(row, patientAllergies)
        const pattern = parseDosePattern(row.pattern)
        const qty = row.drug?.form
          ? prescribedQuantity({ pattern, frequencyPerDay: null, durationDays: row.days, form: row.drug.form, isSos: row.isSos })
          : null
        return (
          <fieldset key={row.key} className="space-y-2 rounded-md border border-border p-3">
            <legend className="px-1 text-xs text-muted-foreground">Drug {idx + 1}</legend>
            <div className="relative">
              <input
                role="combobox"
                aria-expanded={row.results.length > 0}
                aria-controls={`rx-results-${row.key}`}
                aria-label="Drug search"
                value={row.query}
                onChange={(e) => onQuery(row.key, e.target.value)}
                placeholder="Search brand or generic name"
                className="w-full rounded-md border border-border px-3 py-2 text-sm"
              />
              {row.results.length > 0 && (
                <ul id={`rx-results-${row.key}`} role="listbox" className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-border bg-white shadow">
                  {row.results.map((d) => (
                    <li key={d.id} role="option" aria-selected={false} tabIndex={0}
                      onClick={() => choose(row.key, d)}
                      onKeyDown={(e) => { if (e.key === 'Enter') choose(row.key, d) }}
                      className="cursor-pointer px-3 py-1.5 text-sm hover:bg-muted">
                      <span className="font-medium">{d.name}</span>
                      {d.genericName && <span className="block text-xs text-muted-foreground">{d.genericName}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {row.drug?.genericName && <p className="mt-0.5 text-xs text-muted-foreground">{row.drug.genericName}</p>}
            </div>

            {conflicts.length > 0 && (
              <div role="alert" className="space-y-2 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">
                <p className="font-semibold">Allergy conflict</p>
                <ul className="list-disc pl-5">
                  {conflicts.map((c) => <li key={c.allergen}>{c.allergen} ({c.severity})</li>)}
                </ul>
                <input
                  value={row.overrideReason}
                  onChange={(e) => patch(row.key, { overrideReason: e.target.value })}
                  maxLength={300}
                  placeholder="Reason for prescribing anyway (min 5 characters)"
                  aria-label="Allergy override reason"
                  className="w-full rounded-md border border-red-300 bg-white px-3 py-2 text-sm text-foreground"
                />
              </div>
            )}

            <input
              value={row.dose}
              onChange={(e) => patch(row.key, { dose: e.target.value })}
              placeholder="Dose (e.g. 500 mg)"
              aria-label="Dose"
              className="w-full rounded-md border border-border px-3 py-2 text-sm"
            />
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Dose pattern">
              {PATTERN_CHIPS.map((p) => (
                <button key={p} type="button" aria-pressed={!row.isSos && row.pattern === p}
                  onClick={() => patch(row.key, { pattern: p, isSos: false })}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium ${!row.isSos && row.pattern === p ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-white'}`}>
                  {p}
                </button>
              ))}
              <button type="button" aria-pressed={row.isSos}
                onClick={() => patch(row.key, { isSos: !row.isSos, pattern: '' })}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium ${row.isSos ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-white'}`}>
                SOS
              </button>
              {!row.isSos && (
                <input
                  value={row.pattern}
                  onChange={(e) => patch(row.key, { pattern: e.target.value })}
                  placeholder="Other, e.g. ½-0-½"
                  aria-label="Free pattern"
                  aria-invalid={row.pattern !== '' && !pattern}
                  className="w-32 rounded-md border border-border px-2 py-1 text-xs"
                />
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <label className="text-xs">Days
                <input type="number" min={1} max={365} aria-label="Days" value={row.days}
                  onChange={(e) => patch(row.key, { days: Number(e.target.value) })}
                  className="mt-0.5 w-full rounded-md border border-border px-2 py-1.5 text-sm" />
              </label>
              <label className="text-xs">Route
                <select aria-label="Route" value={row.route} onChange={(e) => patch(row.key, { route: e.target.value as Row['route'] })}
                  className="mt-0.5 w-full rounded-md border border-border px-2 py-1.5 text-sm">
                  {ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              <label className="text-xs">Food
                <select aria-label="Food timing" value={row.foodTiming} onChange={(e) => patch(row.key, { foodTiming: e.target.value })}
                  className="mt-0.5 w-full rounded-md border border-border px-2 py-1.5 text-sm">
                  <option value="">Not specified</option>
                  {FOOD_TIMINGS.map((f) => <option key={f} value={f}>{FOOD_LABEL[f]}</option>)}
                </select>
              </label>
              <div className="text-xs">Quantity
                <p data-testid="rx-quantity" className="mt-0.5 py-1.5 text-sm font-medium">{qty ?? '—'}</p>
              </div>
            </div>
            <input
              value={row.instructions}
              onChange={(e) => patch(row.key, { instructions: e.target.value })}
              maxLength={500}
              placeholder="Instructions (optional)"
              aria-label="Instructions"
              className="w-full rounded-md border border-border px-3 py-2 text-sm"
            />
            {rows.length > 1 && (
              <Button type="button" variant="outline" size="sm" onClick={() => setRows((rs) => rs.filter((r) => r.key !== row.key))}>
                <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Remove drug
              </Button>
            )}
          </fieldset>
        )
      })}
      <Button type="button" variant="outline" size="sm" onClick={() => setRows((rs) => (rs.length < 15 ? [...rs, emptyRow()] : rs))}>
        <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Add drug
      </Button>
      <textarea
        value={advice}
        onChange={(e) => setAdvice(e.target.value)}
        maxLength={1000}
        placeholder="Advice for the patient (optional)"
        aria-label="Advice"
        className="w-full rounded-md border border-border px-3 py-2 text-sm"
      />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="button" onClick={save} disabled={!canSave}>Save prescription</Button>
    </div>
  )
}
