'use client'
// SP5: the home-collection day board. One IST day: window cards with capacity bars, the visit
// table (patient, area, phone, tests with sample IDs, collector, status, actions), filters and a
// "New booking" button. Dates are YYYY-MM-DD business dates shown with formatIsoDate (no
// toLocale* calls). Phone numbers are shown here because every role on this page books visits.
import { useId, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import type { BoardVisit, WindowAvailability } from '@/lib/queries/home-collections'
import { formatIsoDate } from '@/lib/india-time'
import { addDaysIso } from '@/lib/follow-ups/rules'
import { displaySampleId } from '@/lib/labs/sample-id'
import { HOME_COLLECTION_STATUSES, type HomeCollectionStatus } from '@/lib/home-collection/rules'
import { assignVisitCollector, labelsHref } from '@/components/home-collection/api'
import { BookHomeCollectionModal } from '@/components/home-collection/BookHomeCollectionModal'
import { RescheduleVisitModal } from '@/components/home-collection/RescheduleVisitModal'
import { CancelVisitDialog } from '@/components/home-collection/CancelVisitDialog'
import { FIELD } from '@/components/home-collection/WindowSelect'

const STATUS_LABEL: Record<HomeCollectionStatus, string> = { booked: 'Booked', collected: 'Collected', cancelled: 'Cancelled' }
const STATUS_CLASS: Record<HomeCollectionStatus, string> = {
  booked: 'bg-primary/10 text-primary',
  collected: 'bg-success/10 text-success',
  cancelled: 'bg-muted text-muted-foreground',
}

export interface HomeCollectionBoardProps {
  date: string
  windows: WindowAvailability[]
  visits: BoardVisit[]
  totalVisits: number
  collectors: { id: number; name: string }[]
  canDispatch: boolean
}

function CapacityCard({ w }: { w: WindowAvailability }) {
  const pct = w.capacity > 0 ? Math.min(100, Math.round((w.booked / w.capacity) * 100)) : 0
  return (
    <li className="rounded-lg border border-border bg-card p-3">
      <p className="text-sm font-medium">{w.label} · {w.booked}/{w.capacity}</p>
      <p className="text-xs text-muted-foreground">{w.startTime}–{w.endTime}{w.closed ? ' · closed for booking' : w.remaining === 0 ? ' · full' : ` · ${w.remaining} left`}</p>
      <div
        role="progressbar" aria-label={`${w.label} booked`} aria-valuemin={0} aria-valuemax={w.capacity} aria-valuenow={w.booked}
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className={`h-full ${w.remaining === 0 ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
      </div>
    </li>
  )
}

export function HomeCollectionBoard({ date, windows, visits, totalVisits, collectors, canDispatch }: HomeCollectionBoardProps) {
  const router = useRouter()
  const id = useId()
  const [booking, setBooking] = useState(false)
  const [rescheduling, setRescheduling] = useState<BoardVisit | null>(null)
  const [cancelling, setCancelling] = useState<BoardVisit | null>(null)
  const [statusFilter, setStatusFilter] = useState<HomeCollectionStatus | ''>('')
  const [windowFilter, setWindowFilter] = useState('')
  const [unassignedOnly, setUnassignedOnly] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)
  const [savingVisit, setSavingVisit] = useState<number | null>(null)

  const windowOptions = useMemo(() => {
    const seen = new Map<number, string>()
    for (const w of windows) seen.set(w.windowId, w.label)
    for (const v of visits) if (!seen.has(v.windowId)) seen.set(v.windowId, v.windowLabel)
    return [...seen.entries()]
  }, [windows, visits])

  const shown = visits.filter((v) =>
    (statusFilter === '' || v.status === statusFilter)
    && (windowFilter === '' || String(v.windowId) === windowFilter)
    && (!unassignedOnly || v.collector === null))

  async function assign(v: BoardVisit, value: string) {
    setMessage(null)
    setSavingVisit(v.id)
    const r = await assignVisitCollector(v.id, value === '' ? null : Number(value))
    setSavingVisit(null)
    if (!r.ok) { setMessage({ kind: 'error', text: r.error }); return }
    setMessage({ kind: 'ok', text: `Collector updated for ${v.patientName}.` })
    router.refresh()
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Home Collection</h1>
          <p className="text-sm text-muted-foreground">{formatIsoDate(date)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/home-collections?date=${addDaysIso(date, -1)}`} aria-label="Previous day" className="rounded-md border border-border px-3 py-2 text-sm">‹ Prev</Link>
          <form method="get" action="/home-collections" className="flex items-center gap-1">
            <label htmlFor={`${id}-date`} className="sr-only">Board date</label>
            <input id={`${id}-date`} type="date" name="date" defaultValue={date} className="rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
            <Button type="submit" variant="outline" size="sm">Go</Button>
          </form>
          <Link href={`/home-collections?date=${addDaysIso(date, 1)}`} aria-label="Next day" className="rounded-md border border-border px-3 py-2 text-sm">Next ›</Link>
          <Button onClick={() => setBooking(true)}>New booking</Button>
        </div>
      </div>

      <section aria-labelledby={`${id}-windows`}>
        <h2 id={`${id}-windows`} className="mb-2 text-sm font-semibold">Collection windows</h2>
        {windows.length === 0
          ? <p className="text-sm text-muted-foreground">No collection windows are set up. An admin can add them in Settings → Lab setup.</p>
          : <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">{windows.map((w) => <CapacityCard key={w.windowId} w={w} />)}</ul>}
      </section>

      <section aria-labelledby={`${id}-visits`} className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id={`${id}-visits`} className="text-sm font-semibold">Visits</h2>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor={`${id}-fstatus`} className="block text-xs text-muted-foreground">Status</label>
              <select id={`${id}-fstatus`} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as HomeCollectionStatus | '')} className={`${FIELD} !w-36`}>
                <option value="">All</option>
                {HOME_COLLECTION_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={`${id}-fwindow`} className="block text-xs text-muted-foreground">Window</label>
              <select id={`${id}-fwindow`} value={windowFilter} onChange={(e) => setWindowFilter(e.target.value)} className={`${FIELD} !w-44`}>
                <option value="">All windows</option>
                {windowOptions.map(([wid, label]) => <option key={wid} value={String(wid)}>{label}</option>)}
              </select>
            </div>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" checked={unassignedOnly} onChange={(e) => setUnassignedOnly(e.target.checked)} />
              Unassigned only
            </label>
          </div>
        </div>

        {totalVisits > visits.length && (
          <p className="text-xs text-muted-foreground">Showing the first {visits.length} of {totalVisits} visits for this day.</p>
        )}
        <div aria-live="polite">
          {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={`text-sm ${message.kind === 'error' ? 'text-destructive' : 'text-success'}`}>{message.text}</p>}
        </div>

        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">{visits.length === 0 ? 'No home collections on this day.' : 'No visits match these filters.'}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">Home collection visits on {formatIsoDate(date)}</caption>
              <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2">Window</th>
                  <th scope="col" className="px-3 py-2">Patient</th>
                  <th scope="col" className="px-3 py-2">Area</th>
                  <th scope="col" className="px-3 py-2">Phone</th>
                  <th scope="col" className="px-3 py-2">Tests</th>
                  <th scope="col" className="px-3 py-2">Collector</th>
                  <th scope="col" className="px-3 py-2">Status</th>
                  <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((v) => {
                  const booked = v.status === 'booked'
                  const orderIds = v.tests.map((t) => t.orderId)
                  const collectorKnown = v.collector === null || collectors.some((c) => c.id === v.collector!.userId)
                  return (
                    <tr key={v.id} className="border-t border-border align-top">
                      <td className="px-3 py-2">{v.windowLabel}</td>
                      <th scope="row" className="px-3 py-2 text-left font-medium">
                        {v.patientName}
                        {v.uhid && <span className="block text-xs font-normal text-muted-foreground">UHID {v.uhid}</span>}
                      </th>
                      <td className="px-3 py-2">{v.city} · {v.pinCode}</td>
                      <td className="px-3 py-2"><a href={`tel:${v.contactPhone}`} className="underline">{v.contactPhone}</a></td>
                      <td className="px-3 py-2">
                        {v.tests.length === 0 ? <span className="text-muted-foreground">None</span> : (
                          <ul className="space-y-0.5">
                            {v.tests.map((t) => (
                              <li key={t.orderId}>
                                {t.testName}{' '}
                                {t.sampleId
                                  ? <span className="font-mono text-xs">{displaySampleId(t.sampleId)}</span>
                                  : <span className="text-xs text-muted-foreground">No sample ID</span>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {canDispatch && booked ? (
                          <select
                            aria-label={`Collector for ${v.patientName}`}
                            value={v.collector ? String(v.collector.userId) : ''}
                            disabled={savingVisit === v.id}
                            onChange={(e) => assign(v, e.target.value)}
                            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                          >
                            <option value="">Unassigned</option>
                            {!collectorKnown && v.collector && <option value={String(v.collector.userId)}>{v.collector.name}</option>}
                            {collectors.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
                          </select>
                        ) : (
                          <span>{v.collector ? v.collector.name : 'Unassigned'}</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[v.status]}`}>{STATUS_LABEL[v.status]}</span>
                        {v.rescheduleCount > 0 && <span className="block text-xs text-muted-foreground">Rescheduled {v.rescheduleCount}×</span>}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-2">
                          {booked && <Button size="sm" variant="outline" onClick={() => setRescheduling(v)} aria-label={`Reschedule visit for ${v.patientName}`}>Reschedule</Button>}
                          {booked && <Button size="sm" variant="destructive" onClick={() => setCancelling(v)} aria-label={`Cancel visit for ${v.patientName}`}>Cancel</Button>}
                          {orderIds.length > 0 && <Link href={labelsHref(orderIds)} className="self-center text-xs font-medium text-primary underline">Print labels</Link>}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {booking && <BookHomeCollectionModal date={date} onClose={() => setBooking(false)} />}
      {rescheduling && <RescheduleVisitModal visit={rescheduling} onClose={() => setRescheduling(null)} />}
      {cancelling && <CancelVisitDialog visit={cancelling} onClose={() => setCancelling(null)} />}
    </div>
  )
}
