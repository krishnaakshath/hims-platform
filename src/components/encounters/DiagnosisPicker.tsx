'use client'
// WS1 T4: the workspace's diagnosis entry. A code is picked from the current WHO ICD-10 version
// (the shared SP6 CodePicker over GET /api/coding/codes?kind=icd10) or typed as free text; either
// way it is posted to POST /api/encounters/[id]/diagnoses with its type and problem-list flag.
// EncounterDiagnosisList shows the visit's live diagnoses with type, problem-list and remove actions.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendJson } from '@/lib/client-fetch'
import { CodePicker } from '@/components/coding/CodePicker'
import type { CodeSearchHit } from '@/lib/queries/code-systems'

type DiagnosisType = 'primary' | 'secondary' | 'provisional'
const TYPES: { value: DiagnosisType; label: string }[] = [
  { value: 'primary', label: 'Primary' },
  { value: 'secondary', label: 'Secondary' },
  { value: 'provisional', label: 'Provisional' },
]
const FIELD = 'h-8 rounded-lg border border-input bg-background px-2 text-sm'

export function DiagnosisPicker({ encounterId, onDate }: { encounterId: number; onDate: string }) {
  const router = useRouter()
  const [diagnosisType, setDiagnosisType] = useState<DiagnosisType>('secondary')
  const [onProblemList, setOnProblemList] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add(body: { codeId: number } | { text: string }) {
    setBusy(true)
    setError(null)
    const res = await sendJson(`/api/encounters/${encounterId}/diagnoses`, 'POST', { ...body, diagnosisType, onProblemList })
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    setText('')
    router.refresh()
  }

  const typed = text.trim()
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium">
          Type
          <select value={diagnosisType} onChange={(e) => setDiagnosisType(e.target.value as DiagnosisType)} className={FIELD}>
            {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-xs font-medium">
          <input type="checkbox" checked={onProblemList} onChange={(e) => setOnProblemList(e.target.checked)} />
          Add to problem list
        </label>
      </div>
      <CodePicker kinds={['icd10']} onDate={onDate} label="Search ICD-10" onPick={(h: CodeSearchHit) => { if (!busy) void add({ codeId: h.id }) }} />
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-56 flex-1 flex-col gap-1 text-xs font-medium">
          Or type a diagnosis
          <input type="text" value={text} maxLength={300} onChange={(e) => setText(e.target.value)} className={FIELD} />
        </label>
        <button type="button" disabled={busy || typed.length < 2} onClick={() => void add({ text: typed })}
          className="h-8 rounded-md border border-border px-3 text-sm font-medium disabled:opacity-50">
          Add as free text
        </button>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

export interface EncounterDiagnosisItem {
  id: number
  label: string
  code: string | null
  diagnosisType: DiagnosisType | null
  codingStatus: 'uncoded' | 'proposed' | 'coded'
  onProblemList: boolean
}

const STATUS_LABEL: Record<EncounterDiagnosisItem['codingStatus'], string> = { uncoded: 'Not coded', proposed: 'Proposed', coded: 'Coded' }

export function EncounterDiagnosisList({ encounterId, items, canWrite }: { encounterId: number; items: EncounterDiagnosisItem[]; canWrite: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function act(id: number, method: 'PATCH' | 'DELETE', body?: unknown) {
    setBusy(id)
    setError(null)
    const res = await sendJson(`/api/encounters/${encounterId}/diagnoses/${id}`, method, body)
    setBusy(null)
    if (!res.ok) { setError(res.error); return }
    router.refresh()
  }

  if (items.length === 0) return <p className="text-sm text-muted-foreground">No diagnosis recorded for this visit yet.</p>
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-border text-sm" aria-label="Visit diagnoses">
        {items.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            {d.code && <span className="font-mono text-xs font-semibold">{d.code}</span>}
            <span className="flex-1 text-foreground">{d.label}</span>
            <span className="text-xs text-muted-foreground">{STATUS_LABEL[d.codingStatus]}</span>
            {canWrite && d.codingStatus !== 'coded' ? (
              <>
                <select aria-label={`Type of ${d.label}`} value={d.diagnosisType ?? 'secondary'} disabled={busy === d.id}
                  onChange={(e) => void act(d.id, 'PATCH', { diagnosisType: e.target.value })} className={FIELD}>
                  {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={d.onProblemList} disabled={busy === d.id}
                    onChange={(e) => void act(d.id, 'PATCH', { onProblemList: e.target.checked })} />
                  Problem list
                </label>
                <button type="button" disabled={busy === d.id} onClick={() => void act(d.id, 'DELETE')}
                  className="text-xs font-medium text-destructive hover:underline disabled:opacity-50">Remove</button>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">{TYPES.find((t) => t.value === d.diagnosisType)?.label ?? ''}{d.onProblemList ? ' · Problem list' : ''}</span>
            )}
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
