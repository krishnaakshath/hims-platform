'use client'
import { useState } from 'react'
import { Beaker, Image as ImageIcon, Clock } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ImagingAttachmentStrip, type AttachmentView } from '@/components/ImagingAttachmentStrip'
import type { LabPatientRosterRow } from '@/lib/queries/lab-orders'

// The view arrives via fetch().json(), so every Date on the server-side
// PatientLabOrderRow (and its nested ImagingAttachment) is really a
// JSON-serialized string by the time it lands here -- same reasoning as
// PharmacyPatientLookup's PharmacyDispense mirror type.
interface ReportAttachment extends Omit<AttachmentView, 'filedAt'> { filedAt: string | null }
interface ReportOrder {
  id: number
  status: 'ordered' | 'collected' | 'resulted' | 'cancelled'
  orderedAt: string
  collectedAt: string | null
  testId: number
  testName: string
  testCode: string
  category: 'lab' | 'imaging'
  defaultUnit: string | null
  referenceRange: string | null
  attachments: ReportAttachment[]
  result: {
    value: string
    unit: string | null
    referenceRange: string | null
    flag: 'normal' | 'abnormal' | 'critical'
    resultedByName: string
    resultedAt: string
    notes: string | null
  } | null
}
interface PatientReportsView {
  id: string
  name: string
  dob: string
  orders: ReportOrder[]
}

const FLAG_STYLES: Record<'normal' | 'abnormal' | 'critical', string> = {
  normal: 'border-border bg-secondary/50 text-muted-foreground',
  abnormal: 'border-amber-500/30 bg-amber-500/10 text-amber-700',
  critical: 'border-destructive/30 bg-destructive/10 text-destructive',
}
const FLAG_LABEL: Record<'normal' | 'abnormal' | 'critical', string> = { normal: 'Normal', abnormal: 'Abnormal', critical: 'Critical' }
const STATUS_LABEL: Record<ReportOrder['status'], string> = { ordered: 'Ordered', collected: 'Collected', resulted: 'Resulted', cancelled: 'Cancelled' }

function toAttachmentView(attachments: ReportAttachment[]): AttachmentView[] {
  return attachments.map((a) => ({ ...a, filedAt: a.filedAt ? new Date(a.filedAt) : null }))
}

function ReportCard({ order, onOpen }: { order: ReportOrder; onOpen: () => void }) {
  const isImaging = order.category === 'imaging'
  return (
    <button
      onClick={onOpen}
      className="flex flex-col items-start gap-2 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/30 hover:bg-secondary/40"
    >
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${isImaging ? 'bg-accent/10 text-accent' : 'bg-primary/10 text-primary'}`} aria-hidden="true">
        {isImaging ? <ImageIcon className="h-4.5 w-4.5" /> : <Beaker className="h-4.5 w-4.5" />}
      </span>
      <div className="min-w-0 w-full">
        <p className="truncate text-sm font-semibold text-foreground">{order.testName}</p>
        <p className="font-mono text-xs text-muted-foreground">{order.testCode}</p>
      </div>
      <div className="flex w-full items-center justify-between gap-2">
        {order.result ? (
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${FLAG_STYLES[order.result.flag]}`}>{FLAG_LABEL[order.result.flag]}</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><Clock className="h-3 w-3" aria-hidden="true" />{STATUS_LABEL[order.status]}</span>
        )}
        <span className="text-[11px] text-muted-foreground">{new Date(order.orderedAt).toLocaleDateString()}</span>
      </div>
    </button>
  )
}

function ReportDetailDialog({ order, onClose }: { order: ReportOrder; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{order.testName} <span className="font-mono text-xs font-normal text-muted-foreground">({order.testCode})</span></DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {order.result ? (
            <>
              <div className="flex items-center justify-between">
                <p className="text-foreground">
                  <span className="text-lg font-bold">{order.result.value}</span>{order.result.unit ? ` ${order.result.unit}` : ''}
                </p>
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${FLAG_STYLES[order.result.flag]}`}>{FLAG_LABEL[order.result.flag]}</span>
              </div>
              {order.result.referenceRange && <p className="text-xs text-muted-foreground">Reference range: {order.result.referenceRange}</p>}
              <p className="text-xs text-muted-foreground">Resulted {new Date(order.result.resultedAt).toLocaleString()} by {order.result.resultedByName}</p>
              {order.result.notes && <p className="rounded-md bg-secondary/40 p-2 text-xs text-foreground">{order.result.notes}</p>}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {STATUS_LABEL[order.status]}{order.orderedAt ? ` on ${new Date(order.orderedAt).toLocaleDateString()}` : ''} — no result on file yet.
            </p>
          )}
          {order.attachments.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Images</p>
              <ImagingAttachmentStrip attachments={toAttachmentView(order.attachments)} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function LabsPatientReports({ roster }: { roster: LabPatientRosterRow[] }) {
  const [patientId, setPatientId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<PatientReportsView | null>(null)
  const [openOrder, setOpenOrder] = useState<ReportOrder | null>(null)

  async function lookup(idOverride?: string) {
    const id = (idOverride ?? patientId).trim()
    if (!id) return
    setPatientId(id)
    setLoading(true)
    setError(null)
    setView(null)
    const res = await fetch(`/api/labs/patients/${encodeURIComponent(id)}`)
    setLoading(false)
    if (res.ok) { setView(await res.json()); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not look up this patient.')
  }

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patients with Lab Activity ({roster.length})</h2>
        {roster.length === 0 ? (
          <p className="text-sm text-muted-foreground">No patients have any lab orders on file.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {roster.map((r) => (
              <button
                key={r.id}
                onClick={() => lookup(r.id)}
                className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${view?.id === r.id ? 'border-primary bg-primary/10 text-primary' : 'border-border text-foreground hover:bg-secondary'}`}
              >
                {r.name} <span className="text-xs text-muted-foreground">· {r.resultedCount} resulted{r.pendingCount > 0 ? `, ${r.pendingCount} pending` : ''}</span>
              </button>
            ))}
          </div>
        )}
      </Card>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label htmlFor="labs-lookup-id" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient ID</label>
          <input
            id="labs-lookup-id"
            value={patientId}
            onChange={(e) => setPatientId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') lookup() }}
            placeholder="Anonymous #, e.g. RD-0001"
            aria-label="Patient ID"
            className="w-full rounded-md border border-border px-3 py-2 text-sm"
          />
        </div>
        <button
          onClick={() => lookup()}
          disabled={!patientId.trim() || loading}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {loading ? 'Looking up…' : 'Look up'}
        </button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {view && (
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-foreground">{view.name}</h2>
              <p className="font-mono text-xs text-muted-foreground">{view.id} · DOB {view.dob}</p>
            </div>
          </div>
          {view.orders.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No lab reports on file for this patient.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {view.orders.map((o) => <ReportCard key={o.id} order={o} onOpen={() => setOpenOrder(o)} />)}
            </div>
          )}
        </Card>
      )}

      {openOrder && <ReportDetailDialog order={openOrder} onClose={() => setOpenOrder(null)} />}
    </div>
  )
}
