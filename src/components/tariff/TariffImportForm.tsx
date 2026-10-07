'use client'
import { useId, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { MAX_IMPORT_BYTES, RATE_CSV_HEADERS, SERVICE_CSV_HEADERS, type ImportIssue } from '@/lib/tariff/import'
import { FIELD_CLASS } from './api'

type Kind = 'services' | 'rates'
const KINDS: { value: Kind; label: string }[] = [{ value: 'services', label: 'Services' }, { value: 'rates', label: 'Rates' }]
const HEADERS: Record<Kind, readonly string[]> = { services: SERVICE_CSV_HEADERS, rates: RATE_CSV_HEADERS }
const SHOWN_ISSUES = 200

interface Report { kind: Kind; csv: string; rowCount: number; issues: ImportIssue[] }
interface ImportResponse { rowCount?: number; issues?: ImportIssue[]; committed?: boolean; applied?: number; error?: string }

async function postImport(kind: Kind, csv: string, commit: boolean): Promise<{ status: number; body: ImportResponse | null }> {
  try {
    const res = await fetch('/api/tariff/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, csv, commit }) })
    return { status: res.status, body: (await res.json().catch(() => null)) as ImportResponse | null }
  } catch {
    return { status: 0, body: { error: 'Could not reach the server. Check your connection and try again.' } }
  }
}

export function TariffImportForm() {
  const router = useRouter()
  const uid = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const [kind, setKind] = useState<Kind>('services')
  const [csv, setCsv] = useState('')
  const [report, setReport] = useState<Report | null>(null)
  const [result, setResult] = useState<{ kind: Kind; applied: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // A dry run only counts for the exact kind and text it checked.
  const clean = report !== null && report.kind === kind && report.csv === csv && report.issues.length === 0 && report.rowCount > 0
  const issues = report !== null && report.kind === kind && report.csv === csv ? report.issues : []

  function onFile(file: File | undefined) {
    setError(null); setResult(null)
    if (!file) return
    if (file.size > MAX_IMPORT_BYTES) {
      setError('That file is larger than 1 MB. Split it into smaller files and import them one at a time.')
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    const reader = new FileReader()
    reader.onload = () => { setCsv(typeof reader.result === 'string' ? reader.result : ''); setReport(null) }
    reader.onerror = () => setError('Could not read that file.')
    reader.readAsText(file)
  }

  async function run(commit: boolean) {
    setError(null)
    if (!csv.trim()) { setError('Choose a CSV file or paste CSV content first.'); return }
    if (new TextEncoder().encode(csv).length > MAX_IMPORT_BYTES) { setError('The CSV is larger than 1 MB. Split it into smaller files.'); return }
    setBusy(true)
    const { status, body } = await postImport(kind, csv, commit)
    setBusy(false)
    if (body && Array.isArray(body.issues) && (status === 200 || status === 422)) {
      setReport({ kind, csv, rowCount: body.rowCount ?? 0, issues: body.issues })
      if (commit && body.committed) {
        setResult({ kind, applied: body.applied ?? body.rowCount ?? 0 })
        router.refresh()
      }
      return
    }
    setError(body?.error ?? 'The import failed. Nothing was changed.')
  }

  function downloadTemplate() {
    const blob = new Blob([`${HEADERS[kind].join(',')}\n`], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${kind}-template.csv`
    a.click()
    // Some browsers start the download asynchronously; revoking at once can cancel it.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const lbl = 'mb-1 block text-xs font-medium text-muted-foreground'

  return (
    <div className="space-y-6">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">What are you importing?</legend>
        <div className="flex gap-4">
          {KINDS.map((k) => (
            <label key={k.value} className="flex items-center gap-2 text-sm">
              <input type="radio" name={`${uid}-kind`} checked={kind === k.value} onChange={() => { setKind(k.value); setResult(null); setError(null) }} />
              {k.label}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="space-y-2 rounded-lg border border-border p-4 text-sm">
        <p>The first row must be exactly these headers, in this order:</p>
        <p><code className="break-all rounded bg-muted px-2 py-1 text-xs">{HEADERS[kind].join(',')}</code></p>
        <p className="text-muted-foreground">Up to 1 MB. All-or-nothing: if any row has a problem, nothing is imported.</p>
        <Button type="button" variant="outline" size="sm" onClick={downloadTemplate}>Download template</Button>
      </div>

      <div className="space-y-3">
        <div>
          <label htmlFor={`${uid}-file`} className={lbl}>CSV file</label>
          <input id={`${uid}-file`} ref={fileRef} type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} className="block text-sm" />
        </div>
        <div>
          <label htmlFor={`${uid}-text`} className={lbl}>CSV content</label>
          <textarea
            id={`${uid}-text`} value={csv} rows={8} spellCheck={false}
            onChange={(e) => { setCsv(e.target.value); setResult(null) }}
            className={`${FIELD_CLASS} font-mono text-xs`} placeholder="Or paste CSV here"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => void run(false)}>Validate</Button>
          <Button type="button" disabled={busy || !clean || result !== null} onClick={() => void run(true)}>Commit</Button>
        </div>
      </div>

      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}

      <div aria-live="polite" className="space-y-3">
        {result && <p className="rounded-md bg-muted p-3 text-sm font-medium">{`Imported ${result.applied} ${result.kind}.`}</p>}
        {!result && report && report.kind === kind && report.csv === csv && (
          issues.length === 0
            ? <p className="text-sm">{report.rowCount > 0 ? `${report.rowCount} ${report.rowCount === 1 ? 'row' : 'rows'} ready to import. No problems found.` : 'The file has no rows to import.'}</p>
            : <p className="text-sm font-medium">{`${issues.length} ${issues.length === 1 ? 'problem' : 'problems'} found. Fix the file and validate again.`}</p>
        )}
      </div>

      {issues.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Import issues</caption>
            <thead>
              <tr className="border-b border-border bg-secondary/40">
                <th scope="col" className="p-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Line</th>
                <th scope="col" className="p-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Column</th>
                <th scope="col" className="p-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Message</th>
              </tr>
            </thead>
            <tbody>
              {issues.slice(0, SHOWN_ISSUES).map((i, n) => (
                <tr key={n} className="border-b border-border last:border-b-0">
                  <td className="p-3">{i.line}</td>
                  <td className="p-3">{i.column ?? '—'}</td>
                  <td className="p-3">{i.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {issues.length > SHOWN_ISSUES && <p className="p-3 text-xs text-muted-foreground">{`Showing the first ${SHOWN_ISSUES} of ${issues.length} problems.`}</p>}
        </div>
      )}
    </div>
  )
}
