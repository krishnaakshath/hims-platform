'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { sendJson } from '@/components/tariff/api'
import { formatPaise } from '@/lib/format'

type Preview = { groups: number; lines: number; taxablePaise: number; waitingLines: number }
type Result = { created: { invoiceId: number; patientId: string; lineCount: number }[]; skipped: { patientId: string; error: string }[] }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * WS2 T12: "Invoice all ready lines" (spec ruling 12). Shows what would be drafted, then creates
 * one draft invoice per ready visit/stay/pharmacy group. Drafts only; finalising stays a separate step.
 * With `patientId`, only that patient's lines (the cash desk's "Invoice ready charges").
 */
export function InvoiceReadyButton({ patientId, label = 'Invoice all ready lines' }: { patientId?: string; label?: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)
  const query = patientId === undefined ? '' : `?patientId=${encodeURIComponent(patientId)}`

  async function loadPreview() {
    setBusy(true); setError(null); setResult(null)
    try {
      const res = await fetch(`/api/billing/invoice-ready${query}`)
      const data = await res.json().catch(() => null)
      if (!res.ok) setError(data && typeof data.error === 'string' ? data.error : 'Something went wrong. Please try again.')
      else setPreview(data as Preview)
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    }
    setBusy(false)
  }

  async function create() {
    setBusy(true); setError(null)
    const res = await sendJson<Result>('/api/billing/invoice-ready', 'POST', patientId === undefined ? {} : { patientId })
    setBusy(false)
    setPreview(null)
    if (!res.ok) { setError(res.error); return }
    setResult(res.data)
    router.refresh()
  }

  const createdLines = result?.created.reduce((s, c) => s + c.lineCount, 0) ?? 0
  return (
    <div className="space-y-2">
      {preview === null && (
        <Button type="button" variant="outline" disabled={busy} onClick={() => void loadPreview()}>
          <FileText className="mr-1 h-4 w-4" aria-hidden="true" /> {busy ? 'Checking…' : label}
        </Button>
      )}
      {preview !== null && (
        <div className="space-y-2 rounded-md border border-border p-3 text-sm" aria-live="polite">
          {preview.lines === 0 ? <p>No lines are ready to invoice.</p> : (
            <p>
              {plural(preview.lines, 'line')} ready ({formatPaise(preview.taxablePaise)} before tax) will go on {plural(preview.groups, 'draft invoice')}.
            </p>
          )}
          {preview.waitingLines > 0 && <p className="text-muted-foreground">{plural(preview.waitingLines, 'line')} waiting for the visit/stay to close.</p>}
          <div className="flex gap-2">
            {preview.lines > 0 && <Button type="button" disabled={busy} onClick={() => void create()}>{busy ? 'Creating…' : 'Create draft invoices'}</Button>}
            <Button type="button" variant="outline" disabled={busy} onClick={() => setPreview(null)}>{preview.lines > 0 ? 'Cancel' : 'Close'}</Button>
          </div>
        </div>
      )}
      {result && (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {result.created.length === 0 ? 'No draft invoices created.' : `Created ${plural(result.created.length, 'draft invoice')} for ${plural(createdLines, 'line')}.`}
          {result.skipped.length > 0 && ` ${plural(result.skipped.length, 'group')} changed meanwhile and ${result.skipped.length === 1 ? 'was' : 'were'} skipped; check again.`}
        </p>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
