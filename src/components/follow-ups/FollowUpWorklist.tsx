'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { FollowUpStatusChip } from './FollowUpStatusChip'
import { BookFollowUpModal } from './BookFollowUpModal'
import { ContactAttemptModal } from './ContactAttemptModal'
import { ReasonDialog } from './ReasonDialog'
import { unbookFollowUpSlot } from './api'
import { CHANNEL_LABEL, FIELD, LABEL, OUTCOME_LABEL, formatIsoDate, formatIstDateTime } from './format'
import type { WorklistBucket, WorklistFilters, WorklistRow } from '@/lib/follow-ups/worklist'
import { MISSED_ROW_CAP, WORKLIST_ROW_CAP } from '@/lib/follow-ups/worklist'

const BASE = '/front-desk/follow-ups'
const TABS: { bucket: WorklistBucket; label: string }[] = [
  { bucket: 'due', label: 'Due' },
  { bucket: 'overdue', label: 'Overdue' },
  { bucket: 'upcoming', label: 'Upcoming' },
  { bucket: 'scheduled', label: 'Booked' },
  { bucket: 'missed', label: 'Missed' },
]

function href(bucket: string, departmentId: number | null, providerId: number | null): string {
  const q = new URLSearchParams({ bucket })
  if (departmentId !== null) q.set('departmentId', String(departmentId))
  if (providerId !== null) q.set('providerId', String(providerId))
  return `${BASE}?${q.toString()}`
}

type Dialog = { kind: 'book' | 'contact' | 'unbook'; row: WorklistRow }

export interface FollowUpWorklistProps {
  rows: WorklistRow[]
  counts: Record<WorklistBucket, number>
  filters: WorklistFilters
  providers: { id: number; name: string }[]
  departments: { id: number; name: string }[]
  todayIso: string
  canAct: boolean
  /** The live query hit its row cap (raw count), so the live buckets may be incomplete. */
  capped: boolean
  /** True when the separate missed list hit its own cap (only the most recent missed are shown). */
  missedCapped: boolean
}

export function FollowUpWorklist({ rows, counts, filters, providers, departments, todayIso, canAct, capped, missedCapped }: FollowUpWorklistProps) {
  const router = useRouter()
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const close = () => setDialog(null)
  const done = () => { setDialog(null); router.refresh() }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="wl-dept" className={LABEL}>Department</label>
          <select id="wl-dept" className={`${FIELD} !w-52`} value={filters.departmentId ?? ''}
            onChange={(e) => router.push(href(filters.bucket, e.target.value ? Number(e.target.value) : null, filters.providerId))}>
            <option value="">All departments</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="wl-doc" className={LABEL}>Doctor</label>
          <select id="wl-doc" className={`${FIELD} !w-52`} value={filters.providerId ?? ''}
            onChange={(e) => router.push(href(filters.bucket, filters.departmentId, e.target.value ? Number(e.target.value) : null))}>
            <option value="">All doctors</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>

      <nav aria-label="Follow-up buckets" className="flex gap-1 overflow-x-auto rounded-lg border border-border bg-card p-1 text-sm">
        {TABS.map((t) => (
          <Link
            key={t.bucket}
            href={href(t.bucket, filters.departmentId, filters.providerId)}
            aria-current={filters.bucket === t.bucket ? 'page' : undefined}
            className={`shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 font-medium ${filters.bucket === t.bucket ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {`${t.label} (${counts[t.bucket]})`}
          </Link>
        ))}
      </nav>

      {capped && (
        <p role="status" className="rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Showing first {WORKLIST_ROW_CAP} — refine filters to see the rest.
        </p>
      )}
      {missedCapped && (filters.bucket === 'missed' || filters.bucket === 'all_open') && (
        <p role="status" className="rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Showing first {MISSED_ROW_CAP} missed follow-ups (most recent first) — refine filters to see the rest.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No follow-ups in this list.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Follow-up recall list</caption>
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-left">
                {['Patient', 'Phone', 'Due / window', 'Doctor', 'Department', 'Status', 'Last contact', 'Actions'].map((h) => (
                  <th key={h} scope="col" className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const booked = r.status === 'scheduled' && r.appointment?.status === 'scheduled' ? r.appointment : null
                return (
                  <tr key={r.id} className="border-b border-border align-top last:border-b-0">
                    <td className="p-3">
                      <Link href={`/patients/${r.patientId}`} className="font-medium text-primary hover:underline">{r.patientName}</Link>
                      {r.uhid && <div className="font-mono text-xs text-muted-foreground">UHID {r.uhid}</div>}
                      <div className="text-xs text-muted-foreground">{r.reason}</div>
                    </td>
                    <td className="p-3">{r.phone ? <a href={`tel:${r.phone.replace(/[^+\d]/g, '')}`} className="text-primary hover:underline">{r.phone}</a> : '—'}</td>
                    <td className="p-3">
                      <div>{formatIsoDate(r.dueDate)}</div>
                      <div className="text-xs text-muted-foreground">{formatIsoDate(r.windowStart)} to {formatIsoDate(r.windowEnd)}</div>
                    </td>
                    <td className="p-3">{r.prescribedBy.name}</td>
                    <td className="p-3">{r.department?.name ?? '—'}</td>
                    <td className="p-3">
                      <FollowUpStatusChip status={r.status} bucket={r.bucket} />
                      {booked && <div className="mt-1 text-xs text-muted-foreground">{formatIstDateTime(booked.startsAt)} with {booked.providerName}</div>}
                    </td>
                    <td className="p-3 text-xs">
                      {r.lastContact
                        ? <>{CHANNEL_LABEL[r.lastContact.channel]}, {OUTCOME_LABEL[r.lastContact.outcome].toLowerCase()}<br />{formatIstDateTime(r.lastContact.attemptedAt)} ({r.contactAttemptCount} {r.contactAttemptCount === 1 ? 'attempt' : 'attempts'})</>
                        : 'None yet'}
                    </td>
                    <td className="p-3">
                      {canAct && (
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'book', row: r })}>{booked ? 'Reschedule' : 'Book'}</Button>
                          <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'contact', row: r })}>Log contact</Button>
                          {booked && <Button size="sm" variant="destructive" onClick={() => setDialog({ kind: 'unbook', row: r })}>Cancel booking</Button>}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {dialog?.kind === 'book' && <BookFollowUpModal followUp={dialog.row} providers={providers} todayIso={todayIso} onClose={close} />}
      {dialog?.kind === 'contact' && <ContactAttemptModal followUpId={dialog.row.id} patientLabel={dialog.row.patientName} onClose={close} />}
      {dialog?.kind === 'unbook' && (
        <ReasonDialog
          title="Cancel this booking?"
          description={`${dialog.row.patientName}'s appointment will be cancelled and the follow-up goes back to not booked.`}
          confirmLabel="cancel booking"
          onSubmit={(reason) => unbookFollowUpSlot(dialog.row.id, reason)}
          onClose={close}
          onDone={done}
        />
      )}
    </div>
  )
}
