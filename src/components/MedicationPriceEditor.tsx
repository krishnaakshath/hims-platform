'use client'
// WS2 T8 (spec ruling 7): the stock table's MRP cell. Shows the GST-inclusive MRP per unit and, for
// the pricing roles, edits it (with an optional own GST slab and HSN; blank = the billing defaults).
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { sendJson } from '@/lib/client-fetch'
import { formatPaise, parseRupeesToPaise } from '@/lib/format'

const SLABS = [0, 500, 1200, 1800, 2800, 4000] as const
const INPUT = 'w-full rounded-md border border-border px-2 py-1 text-sm'

export interface MedicationPrice { id: number; name: string; unit: string; mrpPerUnitPaise: number | null; gstRateBp: number | null; hsn: string | null }

export function MedicationPriceEditor({ medication, canEdit }: { medication: MedicationPrice; canEdit: boolean }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [mrp, setMrp] = useState(medication.mrpPerUnitPaise === null ? '' : (medication.mrpPerUnitPaise / 100).toFixed(2))
  const [gst, setGst] = useState(medication.gstRateBp === null ? '' : String(medication.gstRateBp))
  const [hsn, setHsn] = useState(medication.hsn ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const label = medication.mrpPerUnitPaise === null
    ? <span className="text-warning">No price</span>
    : <span className="text-foreground">{formatPaise(medication.mrpPerUnitPaise)}<span className="text-xs text-muted-foreground"> / {medication.unit.replace(/s$/, '')}</span></span>

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        {label}
        {canEdit && <Button size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label={`Edit price of ${medication.name}`}>Edit</Button>}
      </div>
    )
  }

  const mrpPaise = parseRupeesToPaise(mrp)
  const hsnValid = hsn.trim() === '' || /^\d{4,8}$/.test(hsn.trim())

  async function save() {
    if (mrpPaise === null) return
    setSaving(true)
    setError(null)
    const res = await sendJson(`/api/pharmacy/medications/${medication.id}/price`, 'PATCH', {
      mrpPerUnitPaise: mrpPaise,
      gstRateBp: gst === '' ? null : Number(gst),
      hsn: hsn.trim() === '' ? null : hsn.trim(),
    })
    setSaving(false)
    if (res.ok) { setEditing(false); router.refresh(); return }
    setError(res.error)
  }

  return (
    <div className="min-w-48 space-y-1.5">
      <input value={mrp} onChange={(e) => setMrp(e.target.value)} inputMode="decimal" placeholder="MRP per unit (₹)" aria-label="MRP per unit in rupees, GST included" className={INPUT} />
      <select value={gst} onChange={(e) => setGst(e.target.value)} aria-label="GST rate" className={INPUT}>
        <option value="">GST: pharmacy default</option>
        {SLABS.map((s) => <option key={s} value={s}>GST {s / 100}%</option>)}
      </select>
      <input value={hsn} onChange={(e) => setHsn(e.target.value)} placeholder="HSN (default if blank)" aria-label="HSN code" className={INPUT} />
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-1.5">
        <Button size="sm" onClick={save} disabled={saving || mrpPaise === null || !hsnValid}>{saving ? 'Saving…' : 'Save'}</Button>
        <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
      </div>
    </div>
  )
}
