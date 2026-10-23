'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import type { EncounterListRow } from '@/lib/queries/encounters'
import type { EncounterStatus } from '@/lib/encounters/status'
import { changeEncounterStatus } from './api'
import { ReasonDialog } from './ReasonDialog'
import { formatIsoDate } from './format'

const STATUS_LABEL: Record<EncounterStatus, string> = {
  checked_in: 'Checked in', in_consultation: 'In consultation', completed: 'Completed', cancelled: 'Cancelled',
}
const TYPE_LABEL: Record<EncounterListRow['encounterType'], string> = { opd: 'Outpatient', ipd: 'Inpatient', lab: 'Home sample collection' /* SP5 */ }
const VISIT_LABEL: Record<EncounterListRow['visitType'], string> = { new: 'New', follow_up: 'Follow-up', review: 'Review', emergency: 'Emergency' }

// WS1 T5: doctors (admin, pi) start and complete visits in the consultation workspace, where the
// diagnosis prompt and vitals live, so the list links there instead of moving the status itself.
// Any pi may read a visit's workspace (spec ruling 3); the workspace offers writes only to its own doctor.
export function EncounterList({
  encounters, can,
}: {
  encounters: EncounterListRow[]
  can: { startOrComplete: boolean; cancelVisit: boolean }
}) {
  const router = useRouter()
  const [cancelling, setCancelling] = useState<EncounterListRow | null>(null)

  if (encounters.length === 0) {
    return <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No visits recorded yet.</p>
  }

  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Visits</caption>
          <thead>
            <tr className="border-b border-border bg-secondary/40 text-left">
              {['Date', 'Token', 'Type', 'Doctor', 'Department', 'Status', 'Actions'].map((h) => (
                <th key={h} scope="col" className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {encounters.map((e) => {
              return (
                <tr key={e.id} className="border-b border-border last:border-b-0">
                  <td className="p-3">{formatIsoDate(e.encounterDate)}</td>
                  <td className="p-3 tabular-nums">{e.opdToken ?? '—'}</td>
                  <td className="p-3">{TYPE_LABEL[e.encounterType]}, {VISIT_LABEL[e.visitType].toLowerCase()}</td>
                  <td className="p-3">{e.providerName}</td>
                  <td className="p-3">{e.departmentName ?? '—'}</td>
                  <td className="p-3">{STATUS_LABEL[e.status]}</td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-2">
                      {can.startOrComplete && e.status !== 'cancelled' && (
                        <Link href={`/encounters/${e.id}`} className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium text-primary hover:bg-secondary">Open workspace</Link>
                      )}
                      {can.cancelVisit && e.status === 'checked_in' && (
                        <Button size="sm" variant="destructive" onClick={() => setCancelling(e)}>Cancel visit</Button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {cancelling && (
        <ReasonDialog
          title="Cancel this visit?"
          description={`The ${formatIsoDate(cancelling.encounterDate)} visit with ${cancelling.providerName} will be cancelled. This cannot be undone.`}
          confirmLabel="cancel visit"
          onSubmit={(reason) => changeEncounterStatus(cancelling.id, { to: 'cancelled', cancelReason: reason })}
          onClose={() => setCancelling(null)}
          onDone={() => { setCancelling(null); router.refresh() }}
        />
      )}
    </div>
  )
}
