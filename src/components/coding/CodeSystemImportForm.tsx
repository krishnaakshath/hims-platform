'use client'
// Web import of a small code-system CSV (admin page /coding/code-systems). The file is read in the
// browser as text and posted as JSON; "Check file" is a dry run and "Load" is enabled only after a
// clean check of exactly the same inputs. Full releases go through the CLI (docs/CODE-SYSTEMS.md).
import { useId, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { CODE_SYSTEM_KINDS, CODE_SYSTEM_LABEL, isSampleVersion, type CodeSystemKind } from '@/lib/coding/code-systems'
import { CODE_CSV_HEADERS, MAX_REPORTED_ISSUES, WEB_IMPORT_LIMITS } from '@/lib/coding/import'
import type { ImportIssue } from '@/lib/tariff/import'

const FIELD = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm'
const LABEL = 'mb-1 block text-xs font-medium text-muted-foreground'
const TOO_BIG = 'This file is larger than 4 MB. Load it with npm run codes:import instead (see docs/CODE-SYSTEMS.md).'

interface ImportResponse {
  ok?: boolean
  codeCount?: number
  isSample?: boolean
  codeSystemId?: number
  isCurrent?: boolean
  error?: string
  issues?: ImportIssue[]
}

type Checked = { key: string; codeCount: number; isSample: boolean; issues: ImportIssue[] }

export function CodeSystemImportForm() {
  const router = useRouter()
  const uid = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const [kind, setKind] = useState<CodeSystemKind>('icd10')
  const [version, setVersion] = useState('')
  const [name, setName] = useState('')
  const [licenceNote, setLicenceNote] = useState('')
  const [makeCurrent, setMakeCurrent] = useState(false)
  const [file, setFile] = useState<{ name: string; text: string } | null>(null)
  const [checked, setChecked] = useState<Checked | null>(null)
  const [loaded, setLoaded] = useState<{ codeCount: number; isCurrent: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const sample = isSampleVersion(version.trim())
  const key = JSON.stringify([kind, version, name, licenceNote, file?.name ?? '', file?.text ?? ''])
  const current = checked !== null && checked.key === key ? checked : null
  const canLoad = current !== null && current.issues.length === 0 && current.codeCount > 0 && loaded === null

  function onFile(f: File | undefined) {
    setError(null); setLoaded(null); setChecked(null); setFile(null)
    if (!f) return
    if (f.size > WEB_IMPORT_LIMITS.maxBytes) {
      setError(TOO_BIG)
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    const reader = new FileReader()
    reader.onload = () => setFile({ name: f.name, text: typeof reader.result === 'string' ? reader.result : '' })
    reader.onerror = () => setError('Could not read that file.')
    reader.readAsText(f)
  }

  async function run(commit: boolean) {
    setError(null)
    if (!file) { setError('Choose a CSV file first.'); return }
    if (!version.trim() || !name.trim()) { setError('Enter a version and a name.'); return }
    if (!sample && !licenceNote.trim()) { setError('Enter the licence reference for this code set.'); return }
    if (new TextEncoder().encode(file.text).length > WEB_IMPORT_LIMITS.maxBytes) { setError(TOO_BIG); return }
    setBusy(true)
    let status = 0
    let body: ImportResponse | null = null
    try {
      const res = await fetch('/api/coding/code-systems/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind, version: version.trim(), name: name.trim(), licenceNote: licenceNote.trim() === '' ? null : licenceNote.trim(),
          sourceFileName: file.name.slice(0, 200), csv: file.text, commit, makeCurrent,
        }),
      })
      status = res.status
      body = (await res.json().catch(() => null)) as ImportResponse | null
    } catch {
      body = { error: 'Could not reach the server. Check your connection and try again.' }
    }
    setBusy(false)

    if (status === 400 && Array.isArray(body?.issues)) {
      setChecked({ key, codeCount: 0, isSample: sample, issues: body.issues })
      return
    }
    if (!commit && status === 200 && body?.ok) {
      setChecked({ key, codeCount: body.codeCount ?? 0, isSample: body.isSample ?? sample, issues: [] })
      return
    }
    if (commit && status === 201) {
      setLoaded({ codeCount: body?.codeCount ?? 0, isCurrent: body?.isCurrent ?? false })
      router.refresh()
      return
    }
    setError(body?.error ?? 'The import failed. Nothing was loaded.')
  }

  const issues = current?.issues ?? []
  const reset = () => { setLoaded(null); setError(null) }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${uid}-kind`} className={LABEL}>Code set</label>
          <select id={`${uid}-kind`} className={FIELD} value={kind} onChange={(e) => { setKind(e.target.value as CodeSystemKind); reset() }}>
            {CODE_SYSTEM_KINDS.map((k) => <option key={k} value={k}>{CODE_SYSTEM_LABEL[k]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-version`} className={LABEL}>Version</label>
          <input id={`${uid}-version`} className={FIELD} value={version} maxLength={40} placeholder="e.g. 2019-WHO" onChange={(e) => { setVersion(e.target.value); reset() }} />
        </div>
        <div>
          <label htmlFor={`${uid}-name`} className={LABEL}>Name</label>
          <input id={`${uid}-name`} className={FIELD} value={name} maxLength={120} placeholder="e.g. WHO ICD-10 2019" onChange={(e) => { setName(e.target.value); reset() }} />
        </div>
        <div>
          <label htmlFor={`${uid}-licence`} className={LABEL}>{sample ? 'Licence note (optional for a sample)' : 'Licence note'}</label>
          <input id={`${uid}-licence`} className={FIELD} value={licenceNote} maxLength={500} placeholder="Where the licence comes from" onChange={(e) => { setLicenceNote(e.target.value); reset() }} />
        </div>
      </div>

      <div className="space-y-2 rounded-lg border border-border p-4 text-sm">
        <p>The first row must be exactly these headers, in this order:</p>
        <p><code className="break-all rounded bg-muted px-2 py-1 text-xs">{CODE_CSV_HEADERS.join(',')}</code></p>
        <p className="text-muted-foreground">Up to 4 MB and 60,000 rows. All-or-nothing: if any row has a problem, nothing is loaded.</p>
      </div>

      <div className="space-y-3">
        <div>
          <label htmlFor={`${uid}-file`} className={LABEL}>CSV file</label>
          <input id={`${uid}-file`} ref={fileRef} type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} className="block text-sm" />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={makeCurrent} onChange={(e) => { setMakeCurrent(e.target.checked); reset() }} />
          Make this the current version once loaded
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => void run(false)}>Check file</Button>
          <Button type="button" disabled={busy || !canLoad} onClick={() => void run(true)}>Load</Button>
        </div>
      </div>

      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}

      <div aria-live="polite" className="space-y-3">
        {loaded && (
          <p className="rounded-md bg-muted p-3 text-sm font-medium">
            {`Loaded ${loaded.codeCount} codes${loaded.isCurrent ? ' as the current version' : ' (not the current version)'}.`}
          </p>
        )}
        {!loaded && current && (
          issues.length === 0
            ? <p className="text-sm">{`${current.codeCount} ${current.codeCount === 1 ? 'code' : 'codes'} ready to load${current.isSample ? ' as a SAMPLE set' : ''}. No problems found.`}</p>
            : <p className="text-sm font-medium">{`${issues.length} ${issues.length === 1 ? 'problem' : 'problems'} found. Fix the file and check it again.`}</p>
        )}
      </div>

      {issues.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Import problems</caption>
            <thead>
              <tr className="border-b border-border bg-secondary/40">
                <th scope="col" className="p-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Line</th>
                <th scope="col" className="p-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Column</th>
                <th scope="col" className="p-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Problem</th>
              </tr>
            </thead>
            <tbody>
              {issues.slice(0, MAX_REPORTED_ISSUES).map((i, n) => (
                <tr key={n} className="border-b border-border last:border-b-0">
                  <td className="p-3">{i.line}</td>
                  <td className="p-3">{i.column ?? '—'}</td>
                  <td className="p-3">{i.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
