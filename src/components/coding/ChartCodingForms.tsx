'use client'
// SP6 Task 13: the interactive parts of the chart's "Visit coding" panel. A doctor (pi/admin)
// proposes a diagnosis or adds a procedure for one visit -- with a code from the loaded code set
// (CodePicker; the server records it as `proposed`) or as free text (stored `uncoded` for the coder)
// -- and answers a coding query. Every write goes through the Task 9 routes (codingApi); a refusal
// shows the server's own message in an alert, rule warnings from a successful write in a status.
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { DIAGNOSIS_CODE_KINDS, PROCEDURE_CODE_KINDS } from '@/lib/coding/code-systems'
import type { CodingIssue } from '@/lib/coding/rules'
import { DIAGNOSIS_TYPES, type DiagnosisType } from '@/lib/coding/status'
import { Button } from '@/components/ui/button'
import { addDiagnosis, addProcedure, replyToCodingQuery, type CodeSearchHit, type CodingApiResult } from './codingApi'
import { CodePicker, SampleBadge } from './CodePicker'
import { DIAGNOSIS_TYPE_LABEL } from './EntryEditor'

const fieldClass = 'h-8 rounded-lg border border-input bg-background px-2 text-sm'

function useWrite() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<CodingIssue[]>([])
  async function write(fn: () => Promise<CodingApiResult<object>>): Promise<boolean> {
    setBusy(true)
    setError(null)
    setWarnings([])
    const r = await fn()
    setBusy(false)
    if (!r.ok) {
      setError(r.issues?.length ? `${r.error}: ${r.issues.map((i) => i.message).join('; ')}` : r.error)
      return false
    }
    const data = r.data as { warnings?: CodingIssue[] } | null
    setWarnings(data?.warnings ?? [])
    router.refresh()
    return true
  }
  return { busy, error, warnings, write }
}

function Feedback({ error, warnings }: { error: string | null; warnings: CodingIssue[] }) {
  return (
    <>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {warnings.length > 0 && (
        <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-medium">Saved, with warnings:</p>
          <ul className="list-disc ps-5">{warnings.map((w, i) => <li key={`${w.code}-${i}`}>{w.message}</li>)}</ul>
        </div>
      )}
    </>
  )
}

type Mode = 'code' | 'text'

function ModeChoice({ mode, setMode, noun }: { mode: Mode; setMode: (m: Mode) => void; noun: string }) {
  const name = useId()
  return (
    <fieldset className="flex flex-wrap gap-4 text-sm">
      <legend className="sr-only">{`How to record the ${noun}`}</legend>
      <label className="flex items-center gap-1.5">
        <input type="radio" name={name} checked={mode === 'code'} onChange={() => setMode('code')} />
        Choose a code
      </label>
      <label className="flex items-center gap-1.5">
        <input type="radio" name={name} checked={mode === 'text'} onChange={() => setMode('text')} />
        Describe it (no code)
      </label>
    </fieldset>
  )
}

function ChosenCode({ hit }: { hit: CodeSearchHit | null }) {
  return (
    <p className="text-sm">
      {hit
        ? <span className="flex flex-wrap items-center gap-1.5">Chosen: <span className="font-mono font-semibold">{hit.code}</span> {hit.display} {hit.isSample && <SampleBadge />}</span>
        : <span className="text-muted-foreground">Choose a code from the list.</span>}
    </p>
  )
}

/** "Propose diagnosis" toggle + form for one visit. */
export function ProposeDiagnosisForm({ encounterId, encounterDate, hasPrimary }: { encounterId: number; encounterDate: string; hasPrimary: boolean }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('code')
  const [hit, setHit] = useState<CodeSearchHit | null>(null)
  const [description, setDescription] = useState('')
  const [type, setType] = useState<DiagnosisType>(hasPrimary ? 'secondary' : 'primary')
  const { busy, error, warnings, write } = useWrite()
  const desc = description.trim()
  const ready = mode === 'code' ? hit !== null : desc.length > 0

  async function submit(ev: React.FormEvent) {
    ev.preventDefault()
    if (!ready) return
    const req = mode === 'code'
      ? { codeId: hit!.id, type, ...(desc ? { description: desc } : {}) }
      : { type, description: desc }
    if (await write(() => addDiagnosis(encounterId, req))) { setOpen(false); setHit(null); setDescription('') }
  }

  return (
    <div className="space-y-2">
      <Button type="button" size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>Propose diagnosis</Button>
      {open && (
        <form onSubmit={submit} aria-label="Propose a diagnosis" className="space-y-3 rounded-lg border border-dashed border-border p-3">
          <ModeChoice mode={mode} setMode={setMode} noun="diagnosis" />
          {mode === 'code' && (
            <>
              <CodePicker kinds={DIAGNOSIS_CODE_KINDS} onDate={encounterDate} onPick={setHit} label="Search diagnosis codes" />
              <ChosenCode hit={hit} />
            </>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium">
              Type
              <select value={type} onChange={(ev) => setType(ev.target.value as DiagnosisType)} className={fieldClass}>
                {DIAGNOSIS_TYPES.map((t) => <option key={t} value={t}>{DIAGNOSIS_TYPE_LABEL[t]}</option>)}
              </select>
            </label>
            <label className="flex min-w-56 flex-1 flex-col gap-1 text-xs font-medium">
              {mode === 'code' ? 'Diagnosis description (optional)' : 'Diagnosis description'}
              <input type="text" maxLength={500} required={mode === 'text'} value={description} onChange={(ev) => setDescription(ev.target.value)} className={fieldClass} />
            </label>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !ready}>Propose</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      )}
      <Feedback error={error} warnings={warnings} />
    </div>
  )
}

/** "Add procedure" toggle + form for one visit. */
export function AddProcedureForm({ encounterId, encounterDate, todayIso }: { encounterId: number; encounterDate: string; todayIso: string }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('code')
  const [hit, setHit] = useState<CodeSearchHit | null>(null)
  const [description, setDescription] = useState('')
  const [performedOn, setPerformedOn] = useState(encounterDate <= todayIso ? encounterDate : todayIso)
  const { busy, error, warnings, write } = useWrite()
  const desc = description.trim()
  const ready = (mode === 'code' ? hit !== null : desc.length > 0) && performedOn !== ''

  async function submit(ev: React.FormEvent) {
    ev.preventDefault()
    if (!ready) return
    const req = mode === 'code'
      ? { codeId: hit!.id, performedOn, ...(desc ? { description: desc } : {}) }
      : { performedOn, description: desc }
    if (await write(() => addProcedure(encounterId, req))) { setOpen(false); setHit(null); setDescription('') }
  }

  return (
    <div className="space-y-2">
      <Button type="button" size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>Add procedure</Button>
      {open && (
        <form onSubmit={submit} aria-label="Add a procedure" className="space-y-3 rounded-lg border border-dashed border-border p-3">
          <ModeChoice mode={mode} setMode={setMode} noun="procedure" />
          {mode === 'code' && (
            <>
              <CodePicker kinds={PROCEDURE_CODE_KINDS} onDate={performedOn || encounterDate} onPick={setHit} label="Search procedure codes" />
              <ChosenCode hit={hit} />
            </>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium">
              Performed on
              <input type="date" required max={todayIso} value={performedOn} onChange={(ev) => setPerformedOn(ev.target.value)} className={fieldClass} />
            </label>
            <label className="flex min-w-56 flex-1 flex-col gap-1 text-xs font-medium">
              {mode === 'code' ? 'Procedure description (optional)' : 'Procedure description'}
              <input type="text" maxLength={500} required={mode === 'text'} value={description} onChange={(ev) => setDescription(ev.target.value)} className={fieldClass} />
            </label>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !ready}>Add</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      )}
      <Feedback error={error} warnings={warnings} />
    </div>
  )
}

/** Reply box under one open coding query. */
export function QueryReplyBox({ queryId, question }: { queryId: number; question: string }) {
  const [body, setBody] = useState('')
  const { busy, error, write } = useWrite()
  const text = body.trim()

  async function submit(ev: React.FormEvent) {
    ev.preventDefault()
    if (!text) return
    if (await write(() => replyToCodingQuery(queryId, text))) setBody('')
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <label className="flex flex-col gap-1 text-xs font-medium">
        Your reply
        <textarea
          rows={2} maxLength={2000} value={body} onChange={(ev) => setBody(ev.target.value)}
          aria-label={`Reply to the coding query: ${question}`}
          className="rounded-lg border border-input bg-background px-2 py-1.5 text-sm"
        />
      </label>
      <Button type="submit" size="sm" disabled={busy || !text}>Send reply</Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form>
  )
}
