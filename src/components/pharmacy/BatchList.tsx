'use client'
// WS5 T4: the batches behind one stock row (FEFO order), with write-off for the stock roles.
// Written-off batches stay listed so the shelf history is visible, without a write-off button.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { sendJson } from '@/lib/client-fetch'
import { formatIsoDate } from '@/lib/india-time'
import { formatPaise } from '@/lib/money'
import type { BatchStock } from '@/lib/pharmacy/fefo'

const DAY_MS = 86_400_000

/** "Expires in 23 days" / "Expires today" / "Expired 5 days ago", counted in IST business days. */
export function expiryLabel(expiryDate: string, todayIso: string): string {
  const days = Math.round((Date.parse(`${expiryDate}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / DAY_MS)
  const plural = (n: number) => `${n} day${n === 1 ? '' : 's'}`
  if (days === 0) return 'Expires today'
  return days > 0 ? `Expires in ${plural(days)}` : `Expired ${plural(-days)} ago`
}

const REASONS = [
  { value: 'expired', label: 'Expired' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'recalled', label: 'Recalled' },
  { value: 'other', label: 'Other' },
] as const

const TH = 'p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

function WriteOffForm({ batch, onDone }: { batch: BatchStock; onDone: () => void }) {
  const router = useRouter()
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await sendJson(`/api/pharmacy/batches/${batch.id}/write-off`, 'POST', { reason, ...(note.trim() ? { note: note.trim() } : {}) })
    setSubmitting(false)
    if (!res.ok) { setError(res.error); return }
    toast.show({ title: `Batch ${batch.batchNo} written off` })
    router.refresh()
    onDone()
  }

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-muted/30 p-3">
      <label className="text-xs text-muted-foreground">
        Reason
        <select aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 block rounded-md border border-border px-2 py-1.5 text-sm text-foreground">
          <option value="">Choose a reason</option>
          {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </label>
      <label className="text-xs text-muted-foreground">
        Note (optional, not stored)
        <input aria-label="Note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} className="mt-1 block w-56 rounded-md border border-border px-2 py-1.5 text-sm text-foreground" />
      </label>
      <Button size="sm" variant="destructive" disabled={reason === '' || submitting} onClick={submit}>Confirm write-off</Button>
      <Button size="sm" variant="outline" disabled={submitting} onClick={onDone}>Cancel</Button>
      <p className="w-full text-xs text-muted-foreground">Writes off all {batch.quantityOnHand} on hand in batch {batch.batchNo}.</p>
      {error && <p role="alert" className="w-full text-sm text-destructive">{error}</p>}
    </div>
  )
}

export function BatchList({ batches, unit, today, canWriteOff }: { batches: BatchStock[]; unit: string; today: string; canWriteOff: boolean }) {
  const [writingOff, setWritingOff] = useState<number | null>(null)
  if (batches.length === 0) return <p className="p-2 text-sm text-muted-foreground">No batches on file.</p>

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-border text-left">
          <th className={TH}>Batch</th>
          <th className={TH}>Expiry</th>
          <th className={TH}>On hand</th>
          <th className={TH}>MRP</th>
          <th className={TH}><span className="sr-only">Status</span></th>
        </tr>
      </thead>
      <tbody>
        {batches.map((b) => (
          <tr key={b.id} className="border-b border-border last:border-b-0 align-top">
            <td className="p-2 font-medium text-foreground">{b.batchNo}</td>
            <td className="p-2 text-foreground">
              {b.expiryDate ? (
                <>
                  <p>{formatIsoDate(b.expiryDate)}</p>
                  {!b.writtenOff && <p className="text-xs text-muted-foreground">{expiryLabel(b.expiryDate, today)}</p>}
                </>
              ) : <span className="text-muted-foreground">No expiry</span>}
            </td>
            <td className="p-2 text-foreground">{b.quantityOnHand} {unit}</td>
            <td className="p-2 text-foreground">{b.mrpPerUnitPaise > 0 ? formatPaise(b.mrpPerUnitPaise) : '--'}</td>
            <td className="p-2 text-right">
              {b.writtenOff ? (
                <span className="text-xs text-muted-foreground">Written off</span>
              ) : canWriteOff && (
                writingOff === b.id
                  ? <WriteOffForm batch={b} onDone={() => setWritingOff(null)} />
                  : <Button size="sm" variant="outline" aria-label={`Write off batch ${b.batchNo}`} onClick={() => setWritingOff(b.id)}>Write off</Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
