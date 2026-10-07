'use client'
// Diagnoses or procedures of one encounter (`kind`), with their coding status: Uncoded, Proposed by
// <doctor> (with Accept: a PATCH of the same codeId) or Coded. When editable: change the code (and
// a diagnosis's type), remove (two-step), and add an entry with the CodePicker limited to the kinds
// allowed for that entry. Every write goes through the Task 9 routes; refusals show in an alert and
// rule warnings from a successful write in a status list. Read-only (no controls) when !canEdit.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CODE_SYSTEM_LABEL, DIAGNOSIS_CODE_KINDS, PROCEDURE_CODE_KINDS, type CodeSystemKind } from '@/lib/coding/code-systems'
import type { CodingIssue } from '@/lib/coding/rules'
import { DIAGNOSIS_TYPES, type CodeEntryStatus, type DiagnosisType } from '@/lib/coding/status'
import { Button } from '@/components/ui/button'
import {
  addDiagnosis, addProcedure, removeDiagnosis, removeProcedure, updateDiagnosis, updateProcedure,
  type CodeSearchHit, type CodingApiResult,
} from './codingApi'
import { CodePicker, SampleBadge } from './CodePicker'
import { entryAnchor } from './CodingIssuesPanel'

export interface EntryView {
  id: number
  description: string
  codeId: number | null
  kind: CodeSystemKind | null
  code: string
  display: string | null
  isSample: boolean
  codingStatus: CodeEntryStatus
  proposedByName: string | null
  sequence: number | null
  /** Diagnoses only. */
  type?: DiagnosisType | null
  /** Procedures only. */
  performedOn?: string
  performedOnLabel?: string
  performedByName?: string | null
  serviceName?: string | null
}

export const DIAGNOSIS_TYPE_LABEL: Record<DiagnosisType, string> = { primary: 'Primary', secondary: 'Secondary', provisional: 'Provisional' }

function StatusChip({ e }: { e: EntryView }) {
  const base = 'inline-flex rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap'
  if (e.codingStatus === 'coded') return <span className={`${base} border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100`}>Coded</span>
  if (e.codingStatus === 'proposed') return <span className={`${base} border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100`}>{`Proposed by ${e.proposedByName ?? 'a doctor'}`}</span>
  return <span className={`${base} border-border bg-muted text-foreground`}>Uncoded</span>
}

function CodeCell({ e }: { e: EntryView }) {
  if (!e.code) return <span className="text-muted-foreground">No code</span>
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {e.kind && <span className="text-xs text-muted-foreground">{CODE_SYSTEM_LABEL[e.kind]}</span>}
      <span className="font-mono text-xs font-semibold">{e.code}</span>
      {e.display && <span className="text-xs">{e.display}</span>}
      {e.isSample && <SampleBadge />}
    </span>
  )
}

const fieldClass = 'h-8 rounded-lg border border-input bg-background px-2 text-sm'

export function EntryEditor({ kind, encounterId, entries, canEdit, encounterDate, todayIso, providers }: {
  kind: 'diagnosis' | 'procedure'
  encounterId: number
  entries: EntryView[]
  canEdit: boolean
  /** Codes are checked for validity on the visit date (procedures: on their performed date). */
  encounterDate: string
  todayIso: string
  /** Active doctors (id and name only) for a procedure's "performed by". */
  providers: { id: number; name: string }[]
}) {
  const router = useRouter()
  const isDx = kind === 'diagnosis'
  const noun = isDx ? 'diagnosis' : 'procedure'
  const allowedKinds: readonly CodeSystemKind[] = isDx ? DIAGNOSIS_CODE_KINDS : PROCEDURE_CODE_KINDS
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<CodingIssue[]>([])
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editType, setEditType] = useState<DiagnosisType>('secondary')
  const [confirmRemoveId, setConfirmRemoveId] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [newCode, setNewCode] = useState<CodeSearchHit | null>(null)
  const [newType, setNewType] = useState<DiagnosisType>(entries.some((e) => e.type === 'primary') ? 'secondary' : 'primary')
  const [newDescription, setNewDescription] = useState('')
  const [newDate, setNewDate] = useState(encounterDate <= todayIso ? encounterDate : todayIso)
  const [newBy, setNewBy] = useState('')

  async function write(fn: () => Promise<CodingApiResult<object>>): Promise<boolean> {
    setBusy(true)
    setError(null)
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

  const accept = (e: EntryView) => write(() => isDx
    ? updateDiagnosis(encounterId, e.id, { codeId: e.codeId! })
    : updateProcedure(encounterId, e.id, { codeId: e.codeId! }))
  const changeCode = async (e: EntryView, hit: CodeSearchHit) => {
    if (await write(() => isDx ? updateDiagnosis(encounterId, e.id, { codeId: hit.id }) : updateProcedure(encounterId, e.id, { codeId: hit.id }))) setEditingId(null)
  }
  const changeType = async (e: EntryView) => {
    if (await write(() => updateDiagnosis(encounterId, e.id, { type: editType }))) setEditingId(null)
  }
  const remove = async (e: EntryView) => {
    if (await write(() => isDx ? removeDiagnosis(encounterId, e.id) : removeProcedure(encounterId, e.id))) setConfirmRemoveId(null)
  }
  async function add(ev: React.FormEvent) {
    ev.preventDefault()
    if (!newCode) return
    const description = newDescription.trim() || undefined
    const ok = await write(() => isDx
      ? addDiagnosis(encounterId, { codeId: newCode.id, type: newType, description })
      : addProcedure(encounterId, {
        codeId: newCode.id, performedOn: newDate, description, ...(newBy ? { performedByProviderId: Number(newBy) } : {}),
      }))
    if (ok) { setAdding(false); setNewCode(null); setNewDescription('') }
  }

  const headingId = `${kind}-heading`
  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-lg border border-border p-4">
      <h2 id={headingId} className="text-base font-semibold">{isDx ? 'Diagnoses' : 'Procedures'}</h2>

      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{isDx ? 'No diagnoses recorded for this visit.' : 'No procedures recorded for this visit.'}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <caption className="sr-only">{isDx ? 'Diagnoses of this visit' : 'Procedures of this visit'}</caption>
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-2 py-1.5">{isDx ? 'Diagnosis' : 'Procedure'}</th>
                <th scope="col" className="px-2 py-1.5">Code</th>
                <th scope="col" className="px-2 py-1.5">{isDx ? 'Type' : 'Performed'}</th>
                <th scope="col" className="px-2 py-1.5">Status</th>
                {canEdit && <th scope="col" className="px-2 py-1.5"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {entries.map((e) => (
                <tr key={e.id} id={entryAnchor(kind, e.id)} tabIndex={-1} className="align-top target:bg-amber-50 dark:target:bg-amber-950/40">
                  <td className="px-2 py-2">{e.description}</td>
                  <td className="px-2 py-2">
                    <CodeCell e={e} />
                    {canEdit && editingId === e.id && (
                      <div className="mt-2 space-y-2 rounded-lg border border-border p-2">
                        <CodePicker
                          kinds={allowedKinds}
                          onDate={isDx ? encounterDate : (e.performedOn ?? encounterDate)}
                          onPick={(hit) => changeCode(e, hit)}
                          label={`Search codes for ${e.description}`}
                        />
                        {isDx && (
                          <div className="flex items-end gap-2">
                            <label className="flex flex-col gap-1 text-xs font-medium">
                              Type
                              <select value={editType} onChange={(ev) => setEditType(ev.target.value as DiagnosisType)} className={fieldClass}>
                                {DIAGNOSIS_TYPES.map((t) => <option key={t} value={t}>{DIAGNOSIS_TYPE_LABEL[t]}</option>)}
                              </select>
                            </label>
                            <Button type="button" size="sm" variant="outline" disabled={busy || editType === e.type} onClick={() => changeType(e)}>Save type</Button>
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    {isDx
                      ? (e.type ? DIAGNOSIS_TYPE_LABEL[e.type] : '—')
                      : [e.performedOnLabel, e.performedByName, e.serviceName].filter(Boolean).join(' · ')}
                  </td>
                  <td className="px-2 py-2"><StatusChip e={e} /></td>
                  {canEdit && (
                    <td className="px-2 py-2">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {e.codingStatus === 'proposed' && e.codeId !== null && (
                          <Button type="button" size="xs" disabled={busy} onClick={() => accept(e)} aria-label={`Accept ${e.code} for ${e.description}`}>Accept</Button>
                        )}
                        <Button
                          type="button" size="xs" variant="outline" disabled={busy}
                          aria-expanded={editingId === e.id}
                          aria-label={`${editingId === e.id ? 'Close editing' : 'Edit'} ${e.description}`}
                          onClick={() => { setEditingId(editingId === e.id ? null : e.id); setEditType(e.type ?? 'secondary') }}
                        >
                          {editingId === e.id ? 'Done' : 'Edit'}
                        </Button>
                        {confirmRemoveId === e.id ? (
                          <>
                            <Button type="button" size="xs" variant="destructive" disabled={busy} onClick={() => remove(e)} aria-label={`Confirm removing ${e.description}`}>Confirm remove</Button>
                            <Button type="button" size="xs" variant="ghost" onClick={() => setConfirmRemoveId(null)}>Keep</Button>
                          </>
                        ) : (
                          <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => setConfirmRemoveId(e.id)} aria-label={`Remove ${e.description}`}>Remove</Button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {warnings.length > 0 && (
        <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-medium">Saved, with warnings:</p>
          <ul className="list-disc ps-5">{warnings.map((w, i) => <li key={`${w.code}-${i}`}>{w.message}</li>)}</ul>
        </div>
      )}

      {canEdit && (adding ? (
        <form onSubmit={add} className="space-y-3 rounded-lg border border-dashed border-border p-3" aria-label={`Add a ${noun}`}>
          <CodePicker
            kinds={allowedKinds}
            onDate={isDx ? encounterDate : newDate}
            onPick={setNewCode}
            label={`Search codes for the new ${noun}`}
          />
          <p className="text-sm">
            {newCode
              ? <span className="flex flex-wrap items-center gap-1.5">Chosen: <span className="font-mono font-semibold">{newCode.code}</span> {newCode.display} {newCode.isSample && <SampleBadge />}</span>
              : <span className="text-muted-foreground">Choose a code from the list.</span>}
          </p>
          <div className="flex flex-wrap items-end gap-3">
            {isDx ? (
              <label className="flex flex-col gap-1 text-xs font-medium">
                Type
                <select value={newType} onChange={(ev) => setNewType(ev.target.value as DiagnosisType)} className={fieldClass}>
                  {DIAGNOSIS_TYPES.map((t) => <option key={t} value={t}>{DIAGNOSIS_TYPE_LABEL[t]}</option>)}
                </select>
              </label>
            ) : (
              <>
                <label className="flex flex-col gap-1 text-xs font-medium">
                  Performed on
                  <input type="date" required max={todayIso} value={newDate} onChange={(ev) => setNewDate(ev.target.value)} className={fieldClass} />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium">
                  Performed by
                  <select value={newBy} onChange={(ev) => setNewBy(ev.target.value)} className={fieldClass}>
                    <option value="">Not recorded</option>
                    {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
              </>
            )}
            <label className="flex min-w-56 flex-1 flex-col gap-1 text-xs font-medium">
              Description (optional; the code&apos;s name is used if blank)
              <input type="text" maxLength={500} value={newDescription} onChange={(ev) => setNewDescription(ev.target.value)} className={fieldClass} />
            </label>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !newCode}>{`Add ${noun}`}</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => { setAdding(false); setNewCode(null) }}>Cancel</Button>
          </div>
        </form>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>{`Add a ${noun}`}</Button>
      ))}
    </section>
  )
}
