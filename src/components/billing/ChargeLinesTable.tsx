'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Ban, FilePlus2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FIELD_CLASS, sendJson } from '@/components/tariff/api'
import { formatPaise } from '@/lib/format'
import { formatIsoDate } from '@/lib/india-time'
import type { ChargeViolation } from '@/lib/billing/charge-rules'
import { LINE_STATUS_LABELS, PRICE_SOURCE_LABELS } from './labels'

export interface ChargeLineView {
  id: number
  serviceDate: string
  itemCode: string
  itemName: string
  quantity: number
  unitPricePaise: number
  taxablePaise: number
  priceSource: string
  status: 'captured' | 'invoiced' | 'void'
  invoiceId: number | null
  source: string
  violations: ChargeViolation[]
  voidReason: string | null
}

const STATUS_CLASS: Record<string, string> = {
  captured: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
  invoiced: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  void: 'bg-muted text-muted-foreground line-through',
}

/**
 * SP4: the charges of one visit or stay. Unbilled captured lines can be selected into a draft
 * invoice, and any line not yet invoiced can be voided with a reason (kept on the row).
 */
export function ChargeLinesTable({ lines }: { lines: ChargeLineView[] }) {
  const router = useRouter()
  const [selected, setSelected] = useState<number[]>([])
  const [voiding, setVoiding] = useState<ChargeLineView | null>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const selectable = lines.filter((l) => l.status === 'captured' && l.invoiceId === null)
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const selectedTotal = lines.filter((l) => selected.includes(l.id)).reduce((sum, l) => sum + l.taxablePaise, 0)

  async function createDraft() {
    setError(null)
    setBusy(true)
    const res = await sendJson<{ invoiceId: number }>('/api/billing/invoices', 'POST', { lineIds: selected })
    setBusy(false)
    if (res.ok) { router.push(`/billing/invoices/${res.data.invoiceId}`); return }
    setError(res.error)
  }

  async function confirmVoid() {
    if (!voiding) return
    setBusy(true)
    const res = await sendJson(`/api/billing/charge-lines/${voiding.id}/void`, 'POST', { reason })
    setBusy(false)
    if (res.ok) { setVoiding(null); setReason(''); setSelected((s) => s.filter((x) => x !== voiding.id)); router.refresh(); return }
    setError(res.error)
  }

  if (lines.length === 0) return <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No charges captured yet.</p>

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-10 px-3 py-2"><span className="sr-only">Select</span></th>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Rate</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const canSelect = l.status === 'captured' && l.invoiceId === null
              const warnings = l.violations.length
              return (
                <tr key={l.id} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    {canSelect && <input type="checkbox" aria-label={`Select ${l.itemName} on ${formatIsoDate(l.serviceDate)}`} checked={selected.includes(l.id)} onChange={() => toggle(l.id)} />}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{formatIsoDate(l.serviceDate)}</td>
                  <td className="px-3 py-2">
                    <p className="font-medium">{l.itemName}</p>
                    <p className="text-xs text-muted-foreground">{l.itemCode}{l.source === 'room_rent' ? ' · Room rent' : l.source === 'pharmacy' ? ' · Pharmacy' : ''}</p>
                    {warnings > 0 && <p className="text-xs text-amber-700 dark:text-amber-300">{warnings} rule note{warnings > 1 ? 's' : ''}: {l.violations.map((v) => v.message).join('; ')}</p>}
                    {l.status === 'void' && l.voidReason && <p className="text-xs text-muted-foreground">Voided: {l.voidReason}</p>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.quantity}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatPaise(l.unitPricePaise)}
                    <span className="block text-xs text-muted-foreground">{PRICE_SOURCE_LABELS[l.priceSource] ?? l.priceSource}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{formatPaise(l.taxablePaise)}</td>
                  <td className="px-3 py-2">
                    <Badge className={STATUS_CLASS[l.status]}>{l.invoiceId !== null && l.status === 'captured' ? 'On draft' : LINE_STATUS_LABELS[l.status]}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {l.status === 'captured' && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => { setVoiding(l); setReason(''); setError(null) }}>
                        <Ban className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Void
                      </Button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {error && !voiding && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {selectable.length > 0 && (
        <div className="flex items-center justify-end gap-3">
          {selected.length > 0 && <span className="text-sm text-muted-foreground">{selected.length} selected · {formatPaise(selectedTotal)} before tax</span>}
          <Button type="button" disabled={selected.length === 0 || busy} onClick={() => void createDraft()}>
            <FilePlus2 className="mr-1 h-4 w-4" aria-hidden="true" /> Create draft invoice
          </Button>
        </div>
      )}

      {voiding && (
        <Dialog open onOpenChange={(open) => { if (!open) setVoiding(null) }}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>Void {voiding.itemName}</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground">The charge stays on record with your reason. It will not be billed.</p>
            <label htmlFor="void-reason" className="text-xs font-medium text-muted-foreground">Reason</label>
            <input id="void-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className={FIELD_CLASS} />
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setVoiding(null)}>Cancel</Button>
              <Button type="button" variant="destructive" disabled={reason.trim().length < 5 || busy} onClick={() => void confirmVoid()}>Void charge</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
