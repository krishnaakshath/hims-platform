'use client'
// WS2 T10: the workspace Orders tab: the lab/imaging order form inline (lab and imaging tabs) and
// the orders placed from this visit, with status, priority, price and whether they are billed.
// Orders placed here are billed to the visit (or to the stay when the patient is admitted).
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { fetchJson } from '@/lib/client-fetch'
import { formatPaise } from '@/lib/money'
import { LAB_STATUS_LABEL } from '@/lib/labs/status'
import { DEFAULT_TIMEZONE, todayIsoIn } from '@/lib/india-time'
import type { EncounterLabOrderRow } from '@/lib/queries/lab-requisitions'
import { LabOrderForm, LabOrderPlacedSummary, type LabTestOption, type PlacedLabOrder } from '@/components/OrderLabTestModal'
import { BookHomeCollectionModal } from '@/components/home-collection/BookHomeCollectionModal'

type OrderRow = Omit<EncounterLabOrderRow, 'orderedAt'> & { orderedAt: string }

const BILLING_LABEL: Record<EncounterLabOrderRow['billing'], string> = { billed: 'On the bill', void: 'Charge voided', not_billed: 'Not billed' }

function PriorityChip({ priority }: { priority: EncounterLabOrderRow['priority'] }) {
  if (priority === 'stat') return <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">STAT</span>
  if (priority === 'urgent') return <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">Urgent</span>
  return null
}

export function OrdersPanel({ encounterId, patientId, labTests, canWrite }: { encounterId: number; patientId: string; labTests: LabTestOption[]; canWrite: boolean }) {
  const router = useRouter()
  const [orders, setOrders] = useState<OrderRow[] | null>(null)
  const [billTo, setBillTo] = useState<'self' | 'payer' | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [placed, setPlaced] = useState<PlacedLabOrder | null>(null)
  const [booking, setBooking] = useState(false)
  const [formKey, setFormKey] = useState(0)

  // Bumped after an order or a booking, to reload the list.
  const [reloadKey, setReloadKey] = useState(0)
  const load = useCallback(() => setReloadKey((k) => k + 1), [])

  useEffect(() => {
    let live = true
    fetchJson<{ orders: OrderRow[]; billTo: 'self' | 'payer' }>(`/api/patients/${patientId}/lab-orders?encounterId=${encounterId}`).then((r) => {
      if (!live) return
      if (!r.ok) { setLoadError(r.error); return }
      setLoadError(null)
      setOrders(r.data.orders)
      setBillTo(r.data.billTo)
    })
    return () => { live = false }
  }, [patientId, encounterId, reloadKey])

  function onPlaced(p: PlacedLabOrder) {
    setPlaced(p)
    setFormKey((k) => k + 1) // a fresh, empty form for the next order
    load()
    router.refresh()
  }

  return (
    <div className="space-y-4">
      {canWrite && (
        <section className="rounded-lg border border-border p-3">
          <h3 className="mb-2 text-sm font-semibold">Order tests</h3>
          {placed && (
            <div className="mb-3 rounded-md border border-success/30 bg-success/10 p-2">
              <LabOrderPlacedSummary placed={placed} onBook={() => setBooking(true)} />
            </div>
          )}
          <LabOrderForm key={formKey} patientId={patientId} labTests={labTests} originatingEncounterId={encounterId} billTo={billTo} layout="tabs" onPlaced={onPlaced} />
        </section>
      )}

      <section>
        <h3 className="mb-2 text-sm font-semibold">Orders from this visit</h3>
        {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
        {orders === null && !loadError && <p className="text-sm text-muted-foreground">Loading…</p>}
        {orders?.length === 0 && <p className="text-sm text-muted-foreground">No tests ordered from this visit.</p>}
        {orders && orders.length > 0 && (
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {orders.map((o) => (
              <li key={o.id} className={`flex flex-wrap items-center gap-2 px-3 py-2 ${o.status === 'cancelled' ? 'text-muted-foreground' : ''}`}>
                <span className="font-medium">{o.testName}</span>
                <span className="text-xs text-muted-foreground">{o.category === 'imaging' ? 'Imaging' : 'Lab'}</span>
                <PriorityChip priority={o.priority} />
                {o.fastingRequired && <span className="rounded-full border border-border px-2 py-0.5 text-[11px]">Fasting</span>}
                <span className="ml-auto text-xs">{LAB_STATUS_LABEL[o.status]}</span>
                {o.quotedPricePaise !== null && <span className="tabular-nums">{formatPaise(o.quotedPricePaise)}</span>}
                <span className={`text-xs ${o.billing === 'not_billed' ? 'text-warning' : 'text-muted-foreground'}`}>{BILLING_LABEL[o.billing]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {booking && placed && (
        <BookHomeCollectionModal
          date={todayIsoIn(DEFAULT_TIMEZONE)}
          initialPatient={patientId}
          initialOrderIds={placed.lines.map((l) => l.orderId)}
          onClose={() => { setBooking(false); load() }}
        />
      )}
    </div>
  )
}
