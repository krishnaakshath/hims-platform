'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export interface BoardRoom {
  id: number
  ward: string
  roomNumber: string
  bedNumber: string
  status: 'available' | 'occupied' | 'dirty' | 'blocked'
  blockedReason: string | null
  occupantName: string | null
  occupantPatientId: string | null
  attendingProviderName: string | null
  admittedAt: Date | null
}

const STATUS_STYLES: Record<BoardRoom['status'], string> = {
  available: 'border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400',
  occupied: 'border-primary/30 bg-primary/10 text-primary',
  dirty: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  blocked: 'border-destructive/30 bg-destructive/10 text-destructive',
}

const STATUS_LABELS: Record<BoardRoom['status'], string> = {
  available: 'Available',
  occupied: 'Occupied',
  dirty: 'Needs cleaning',
  blocked: 'Blocked',
}

// Grouped-grid-with-persistent-legend layout, following Deputy's Schedule
// grid (https://mobbin.com/screens/42d9229d-2df6-4245-a3c1-0802e8c89350):
// rows grouped by area (here, ward) with color-coded cells, and a fixed
// bottom legend mapping every color to its label -- status is never shown
// by color alone.
export function BedBoard({ rooms, canManageFacilities, canBlock, canAdmit }: { rooms: BoardRoom[]; canManageFacilities: boolean; canBlock: boolean; canAdmit: boolean }) {
  const router = useRouter()
  const [selected, setSelected] = useState<BoardRoom | null>(null)
  const [blockReason, setBlockReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const wards = Array.from(new Set(rooms.map((r) => r.ward))).sort()

  async function callAction(path: string, body?: object) {
    setBusy(true)
    setError(null)
    const res = await fetch(path, { method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
    setBusy(false)
    if (!res.ok) {
      const b = await res.json().catch(() => null)
      setError(b?.error ?? 'Action failed.')
      return false
    }
    router.refresh()
    setSelected(null)
    return true
  }

  return (
    <div className="space-y-6">
      {wards.map((ward) => (
        <div key={ward}>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{ward}</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {rooms.filter((r) => r.ward === ward).map((r) => (
              <button
                key={r.id}
                onClick={() => { setSelected(r); setBlockReason(''); setError(null) }}
                className={`rounded-lg border p-3 text-left text-xs transition-colors hover:opacity-80 ${STATUS_STYLES[r.status]}`}
              >
                <p className="font-semibold">Room {r.roomNumber} · Bed {r.bedNumber}</p>
                <p className="mt-1">{STATUS_LABELS[r.status]}</p>
                {r.occupantName && <p className="mt-1 truncate opacity-80">{r.occupantName}</p>}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-secondary/40 p-3 text-xs">
        {(Object.keys(STATUS_LABELS) as BoardRoom['status'][]).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-full border ${STATUS_STYLES[s]}`} aria-hidden="true" />
            {STATUS_LABELS[s]}
          </span>
        ))}
      </div>

      <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null) }}>
        {selected && (
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Room {selected.roomNumber} · Bed {selected.bedNumber} — {selected.ward}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">Status: <span className="font-medium text-foreground">{STATUS_LABELS[selected.status]}</span></p>
              {selected.occupantName && (
                <div className="rounded-md border border-border bg-secondary/40 p-3">
                  <p className="text-foreground">
                    <span className="font-medium">{selected.occupantName}</span>
                    {selected.occupantPatientId && <span className="font-mono text-xs text-muted-foreground"> ({selected.occupantPatientId})</span>}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Attending: {selected.attendingProviderName ?? 'Unassigned'}
                  </p>
                  {selected.admittedAt && (
                    <p className="mt-0.5 text-xs text-muted-foreground">Admitted {new Date(selected.admittedAt).toLocaleString()}</p>
                  )}
                  {selected.occupantPatientId && (
                    <a href={`/patients/${selected.occupantPatientId}`} className="mt-1.5 inline-block text-xs font-medium text-primary hover:underline">View patient →</a>
                  )}
                </div>
              )}
              {selected.status === 'blocked' && selected.blockedReason && <p className="text-muted-foreground">Reason: {selected.blockedReason}</p>}

              {selected.status === 'dirty' && canManageFacilities && (
                <Button onClick={() => callAction(`/api/inpatient/rooms/${selected.id}/mark-clean`)} disabled={busy}>Mark clean</Button>
              )}

              {selected.status === 'available' && canBlock && (
                <div className="space-y-2">
                  <input value={blockReason} onChange={(e) => setBlockReason(e.target.value)} placeholder="Reason for blocking, e.g. Plumbing repair" aria-label="Block reason" className="w-full rounded-md border border-border px-2 py-1.5 text-sm" />
                  <Button variant="outline" onClick={() => callAction(`/api/inpatient/rooms/${selected.id}/block`, { reason: blockReason })} disabled={busy || !blockReason}>Block room</Button>
                </div>
              )}

              {selected.status === 'blocked' && canBlock && (
                <Button variant="outline" onClick={() => callAction(`/api/inpatient/rooms/${selected.id}/unblock`)} disabled={busy}>Unblock room</Button>
              )}

              {selected.status === 'occupied' && canAdmit && (
                <p className="text-xs text-muted-foreground">Transfer and discharge actions for this patient&apos;s admission are on their Patient Detail page.</p>
              )}

              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSelected(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}
