'use client'
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import { sendJson } from '@/lib/client-fetch'

export interface AllergyChip { id: number; allergen: string; reaction: string | null; severity: 'mild' | 'moderate' | 'severe' }

const SEVERITY_CHIP: Record<AllergyChip['severity'], string> = {
  severe: 'border-destructive/40 bg-destructive/10 text-destructive',
  moderate: 'border-warning/40 bg-warning/10 text-warning-foreground',
  mild: 'border-border bg-muted text-foreground',
}
const FIELD = 'rounded-md border border-border bg-card px-2 py-1 text-sm'

// WS1 T3: the active-allergy chips on the patient strip, plus (for ALLERGY_WRITE_ROLES) add,
// remove (inactivate) and "No known allergies". Every change refreshes the server-rendered page.
export function AllergyEditor({ patientId, allergyStatus, allergies, canEdit }: {
  patientId: string
  allergyStatus: 'unknown' | 'none_known' | 'recorded'
  allergies: AllergyChip[]
  canEdit: boolean
}) {
  const router = useRouter()
  const id = useId()
  const [adding, setAdding] = useState(false)
  const [allergen, setAllergen] = useState('')
  const [reaction, setReaction] = useState('')
  const [severity, setSeverity] = useState<AllergyChip['severity']>('moderate')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(call: Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setBusy(true)
    setError(null)
    const res = await call
    setBusy(false)
    if (!res.ok) { setError(res.error ?? 'Could not save'); return }
    after?.()
    router.refresh()
  }

  const base = `/api/patients/${encodeURIComponent(patientId)}`
  const add = (e: React.FormEvent) => {
    e.preventDefault()
    void run(sendJson(`${base}/allergies`, 'POST', { allergen, severity, ...(reaction.trim() ? { reaction } : {}) }), () => {
      setAllergen(''); setReaction(''); setSeverity('moderate'); setAdding(false)
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Allergies</span>
      {allergies.length > 0 ? (
        <ul aria-label="Allergies" className="flex flex-wrap gap-1.5">
          {allergies.map((a) => (
            <li key={a.id} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${SEVERITY_CHIP[a.severity]}`}>
              <span>{a.allergen}{a.reaction ? ` (${a.reaction})` : ''}</span>
              {canEdit && (
                <button type="button" disabled={busy} aria-label={`Remove allergy ${a.allergen}`} className="rounded-full p-0.5 hover:bg-black/10"
                  onClick={() => void run(sendJson(`${base}/allergies/${a.id}`, 'PATCH', { active: false }))}>
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : allergyStatus === 'none_known' ? (
        <span className="rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-xs font-semibold text-success">No known allergies</span>
      ) : (
        <span className="text-xs text-muted-foreground">None recorded</span>
      )}
      {canEdit && !adding && (
        <>
          <button type="button" onClick={() => setAdding(true)} className="text-xs font-medium text-primary hover:underline">Add allergy</button>
          {allergies.length === 0 && allergyStatus !== 'none_known' && (
            <button type="button" disabled={busy} onClick={() => void run(sendJson(`${base}/allergy-status`, 'PUT', { status: 'none_known' }))}
              className="text-xs font-medium text-primary hover:underline">Mark no known allergies</button>
          )}
        </>
      )}
      {canEdit && adding && (
        <form onSubmit={add} className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${id}-allergen`} className="sr-only">Allergen</label>
          <input id={`${id}-allergen`} value={allergen} onChange={(e) => setAllergen(e.target.value)} placeholder="Allergen" required minLength={2} maxLength={120} className={FIELD} />
          <label htmlFor={`${id}-reaction`} className="sr-only">Reaction</label>
          <input id={`${id}-reaction`} value={reaction} onChange={(e) => setReaction(e.target.value)} placeholder="Reaction (optional)" maxLength={200} className={FIELD} />
          <label htmlFor={`${id}-severity`} className="sr-only">Severity</label>
          <select id={`${id}-severity`} value={severity} onChange={(e) => setSeverity(e.target.value as AllergyChip['severity'])} className={FIELD}>
            <option value="mild">Mild</option>
            <option value="moderate">Moderate</option>
            <option value="severe">Severe</option>
          </select>
          <button type="submit" disabled={busy} className="rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-60">Save</button>
          <button type="button" onClick={() => setAdding(false)} className="text-xs text-muted-foreground hover:underline">Cancel</button>
        </form>
      )}
      {error && <p role="alert" className="w-full text-xs text-destructive">{error}</p>}
    </div>
  )
}
