'use client'
// WS5 T3: receive a supplier delivery (goods received note). Each line is one batch; amounts are
// typed in rupees and sent in paise. On success the GRN number is shown in a toast with a link
// back to the stock view.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { sendJson } from '@/lib/client-fetch'
import { todayIsoIn } from '@/lib/india-time'
import { formatPaise, parseRupeesToPaise } from '@/lib/money'

interface LineDraft {
  key: number
  medicationId: string
  batchNo: string
  expiryDate: string
  quantity: string
  mrp: string
  rate: string
}

const BATCH_NO = /^[A-Za-z0-9\-/]+$/
const INPUT = 'w-full rounded-md border border-border px-2 py-1.5 text-sm'

let nextKey = 1
const emptyLine = (): LineDraft => ({ key: nextKey++, medicationId: '', batchNo: '', expiryDate: '', quantity: '', mrp: '', rate: '' })

function parseQuantity(v: string): number | null {
  const n = Number(v)
  return v.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : null
}

function lineValid(l: LineDraft): boolean {
  const batch = l.batchNo.trim()
  return l.medicationId !== '' && batch.length > 0 && batch.length <= 40 && BATCH_NO.test(batch) &&
    /^\d{4}-\d{2}-\d{2}$/.test(l.expiryDate) && parseQuantity(l.quantity) !== null &&
    parseRupeesToPaise(l.mrp) !== null && parseRupeesToPaise(l.rate) !== null
}

export function ReceiveStockDialog({ medications, onClose }: { medications: { id: number; name: string }[]; onClose: () => void }) {
  const router = useRouter()
  const toast = useToast()
  const [supplierName, setSupplierName] = useState('')
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState('')
  const [supplierInvoiceDate, setSupplierInvoiceDate] = useState(() => todayIsoIn())
  const [lines, setLines] = useState<LineDraft[]>(() => [emptyLine()])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const update = (key: number, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const totalPaise = lines.reduce((s, l) => s + (parseQuantity(l.quantity) ?? 0) * (parseRupeesToPaise(l.rate) ?? 0), 0)
  const canSubmit = supplierName.trim() !== '' && supplierInvoiceNo.trim() !== '' && /^\d{4}-\d{2}-\d{2}$/.test(supplierInvoiceDate) &&
    lines.length > 0 && lines.every(lineValid) && !submitting

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await sendJson<{ grnId: number; grnNumber: string }>('/api/pharmacy/grns', 'POST', {
      supplierName: supplierName.trim(),
      supplierInvoiceNo: supplierInvoiceNo.trim(),
      supplierInvoiceDate,
      lines: lines.map((l) => ({
        medicationId: Number(l.medicationId),
        batchNo: l.batchNo.trim(),
        expiryDate: l.expiryDate,
        quantity: parseQuantity(l.quantity),
        mrpPerUnitPaise: parseRupeesToPaise(l.mrp),
        purchaseRatePaise: parseRupeesToPaise(l.rate),
      })),
    })
    setSubmitting(false)
    if (!res.ok) { setError(res.error); return }
    toast.show({ title: `${res.data.grnNumber} received`, action: { label: 'View stock', href: '/pharmacy' } })
    router.refresh()
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Receive stock</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Supplier name</span>
              <input value={supplierName} maxLength={120} onChange={(e) => setSupplierName(e.target.value)} aria-label="Supplier name" className={INPUT} />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Supplier invoice number</span>
              <input value={supplierInvoiceNo} maxLength={60} onChange={(e) => setSupplierInvoiceNo(e.target.value)} aria-label="Supplier invoice number" className={INPUT} />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Supplier invoice date</span>
              <input type="date" value={supplierInvoiceDate} onChange={(e) => setSupplierInvoiceDate(e.target.value)} aria-label="Supplier invoice date" className={INPUT} />
            </label>
          </div>

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="p-2 font-semibold">Medication</th>
                  <th className="p-2 font-semibold">Batch no.</th>
                  <th className="p-2 font-semibold">Expiry</th>
                  <th className="p-2 font-semibold">Qty</th>
                  <th className="p-2 font-semibold">MRP/unit (₹)</th>
                  <th className="p-2 font-semibold">Rate/unit (₹)</th>
                  <th className="p-2"><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const n = i + 1
                  return (
                    <tr key={l.key} className="border-b border-border last:border-b-0">
                      <td className="p-2">
                        <select value={l.medicationId} onChange={(e) => update(l.key, { medicationId: e.target.value })} aria-label={`Medication, line ${n}`} className={INPUT}>
                          <option value="">Select</option>
                          {medications.map((m) => <option key={m.id} value={String(m.id)}>{m.name}</option>)}
                        </select>
                      </td>
                      <td className="p-2"><input value={l.batchNo} maxLength={40} onChange={(e) => update(l.key, { batchNo: e.target.value })} aria-label={`Batch number, line ${n}`} className={INPUT} /></td>
                      <td className="p-2"><input type="date" value={l.expiryDate} onChange={(e) => update(l.key, { expiryDate: e.target.value })} aria-label={`Expiry date, line ${n}`} className={INPUT} /></td>
                      <td className="p-2"><input type="number" min={1} max={100000} step={1} value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} aria-label={`Quantity, line ${n}`} className={INPUT} /></td>
                      <td className="p-2"><input inputMode="decimal" value={l.mrp} onChange={(e) => update(l.key, { mrp: e.target.value })} aria-label={`MRP per unit (₹), line ${n}`} className={INPUT} /></td>
                      <td className="p-2"><input inputMode="decimal" value={l.rate} onChange={(e) => update(l.key, { rate: e.target.value })} aria-label={`Purchase rate per unit (₹), line ${n}`} className={INPUT} /></td>
                      <td className="p-2">
                        <Button size="sm" variant="outline" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={`Remove line ${n}`}>Remove</Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between">
            <Button size="sm" variant="outline" disabled={lines.length >= 50} onClick={() => setLines((ls) => [...ls, emptyLine()])}>Add line</Button>
            <p className="text-sm font-semibold text-foreground">Total {formatPaise(totalPaise)}</p>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Receive stock</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
