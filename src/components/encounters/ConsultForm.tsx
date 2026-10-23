'use client'
import { useRef, useState } from 'react'
import { sendJson } from '@/lib/client-fetch'

export interface ConsultFields {
  chiefComplaint: string | null
  historyPresentIllness: string | null
  pastHistory: string | null
  familyHistory: string | null
  personalHistory: string | null
  examination: string | null
  advice: string | null
}

const SECTIONS: { key: keyof ConsultFields; label: string }[] = [
  { key: 'chiefComplaint', label: 'Chief complaint' },
  { key: 'historyPresentIllness', label: 'History of present illness' },
  { key: 'pastHistory', label: 'Past history' },
  { key: 'familyHistory', label: 'Family history' },
  { key: 'personalHistory', label: 'Personal history' },
  { key: 'examination', label: 'Examination' },
  { key: 'advice', label: 'Advice' },
]

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

// Each field saves on blur (only that field, only when it changed) through PUT .../consult.
export function ConsultForm({ encounterId, initial, readOnly = false }: { encounterId: number; initial: Partial<ConsultFields>; readOnly?: boolean }) {
  const [values, setValues] = useState<Record<keyof ConsultFields, string>>(() =>
    Object.fromEntries(SECTIONS.map((s) => [s.key, initial[s.key] ?? ''])) as Record<keyof ConsultFields, string>)
  const lastSaved = useRef<Record<string, string>>(Object.fromEntries(SECTIONS.map((s) => [s.key, (initial[s.key] ?? '').trim()])))
  const [state, setState] = useState<SaveState>('idle')
  const [error, setError] = useState<string | null>(null)

  async function save(key: keyof ConsultFields) {
    const value = values[key].trim()
    if (value === lastSaved.current[key]) return
    setState('saving')
    setError(null)
    const res = await sendJson(`/api/encounters/${encounterId}/consult`, 'PUT', { [key]: value === '' ? null : value })
    if (!res.ok) { setState('error'); setError(res.error); return }
    lastSaved.current[key] = value
    setState('saved')
  }

  return (
    <div className="space-y-3">
      {SECTIONS.map((s) => (
        <label key={s.key} className="block text-xs font-medium text-muted-foreground">
          {s.label}
          <textarea
            value={values[s.key]}
            readOnly={readOnly}
            maxLength={4000}
            rows={2}
            onChange={(e) => { setValues((v) => ({ ...v, [s.key]: e.target.value })); if (state === 'saved') setState('idle') }}
            onBlur={() => { if (!readOnly) void save(s.key) }}
            className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm text-foreground"
          />
        </label>
      ))}
      <p aria-live="polite" className="min-h-5 text-xs">
        {state === 'saving' && <span className="text-muted-foreground">Saving...</span>}
        {state === 'saved' && <span role="status" className="text-success">Saved</span>}
        {state === 'error' && <span role="alert" className="text-destructive">{error ?? 'Could not save'}</span>}
      </p>
    </div>
  )
}
