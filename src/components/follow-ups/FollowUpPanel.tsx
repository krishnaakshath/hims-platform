'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import type { FollowUpView } from '@/lib/follow-ups/view'
import type { EncounterListRow } from '@/lib/queries/encounters'
import { isOpenFollowUp, followUpVisitReason } from '@/lib/follow-ups/rules'
import { cancelFollowUp, checkInForAppointment, unbookFollowUpSlot } from './api'
import { BookFollowUpModal } from './BookFollowUpModal'
import { ContactAttemptModal } from './ContactAttemptModal'
import { EncounterList } from './EncounterList'
import { FollowUpPlanModal } from './FollowUpPlanModal'
import { FollowUpStatusChip } from './FollowUpStatusChip'
import { ReasonDialog } from './ReasonDialog'
import { CHANNEL_LABEL, OUTCOME_LABEL, formatIsoDate, formatIstDateTime, istDateIso } from './format'

export interface FollowUpPanelProps {
  patientId: string
  followUps: FollowUpView[]
  encounters: EncounterListRow[]
  providers: { id: number; name: string }[]
  departments: { id: number; name: string }[]
  todayIso: string
  can: { plan: boolean; book: boolean; checkIn: boolean; startOrComplete: boolean; cancelVisit: boolean }
  isPi: boolean
  /** The signed-in doctor's own provider id (pi only; null for admin or an unlinked login). */
  selfProviderId: number | null
}

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; fu: FollowUpView }
  | { kind: 'cancel'; fu: FollowUpView }
  | { kind: 'book'; fu: FollowUpView }
  | { kind: 'unbook'; fu: FollowUpView }
  | { kind: 'contact'; fu: FollowUpView }

export function FollowUpPanel({ patientId, followUps, encounters, providers, departments, todayIso, can, isPi, selfProviderId }: FollowUpPanelProps) {
  const router = useRouter()
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Server rule: only the prescribing doctor (or an admin) changes or cancels a plan.
  // A pi with no linked provider profile cannot prescribe at all.
  const canCreate = can.plan && (!isPi || selfProviderId !== null)
  const ownsPlan = (fu: FollowUpView) => can.plan && (!isPi || fu.prescribedBy.providerId === selfProviderId)

  const ordered = [...followUps.filter((f) => isOpenFollowUp(f.status)), ...followUps.filter((f) => !isOpenFollowUp(f.status))]
  const close = () => setDialog(null)
  const done = () => { setDialog(null); router.refresh() }

  async function checkIn(fu: FollowUpView) {
    if (!fu.appointment) return
    setBusyId(fu.id); setError(null)
    const res = await checkInForAppointment({ patientId, providerId: fu.appointment.providerId, appointmentId: fu.appointment.id, reason: followUpVisitReason(fu.reason) })
    setBusyId(null)
    if (!res.ok) { setError(res.error); return }
    router.refresh()
  }

  return (
    <div className="space-y-8">
      <section aria-labelledby="fu-heading">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id="fu-heading" className="border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Follow-ups</h2>
          {canCreate && <Button size="sm" onClick={() => setDialog({ kind: 'create' })}>Set follow-up</Button>}
        </div>
        {error && <p role="alert" className="mb-2 text-sm text-destructive">{error}</p>}
        {ordered.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No follow-ups planned for this patient.</p>
        ) : (
          <ul className="space-y-3">
            {ordered.map((fu) => {
              const open = isOpenFollowUp(fu.status)
              const booked = fu.status === 'scheduled' && fu.appointment?.status === 'scheduled' ? fu.appointment : null
              const owner = ownsPlan(fu)
              const checkInToday = !!booked && istDateIso(booked.startsAt) === todayIso && !encounters.some((e) => e.appointmentId === booked.id)
              return (
                <li key={fu.id} className="rounded-lg border border-border bg-card p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">Due {formatIsoDate(fu.dueDate)}</span>
                    <FollowUpStatusChip status={fu.status} bucket={fu.bucket} />
                  </div>
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                    <Row label="Window">{formatIsoDate(fu.windowStart)} to {formatIsoDate(fu.windowEnd)}</Row>
                    <Row label="Reason">{fu.reason}</Row>
                    {fu.planNotes !== null && <Row label="Plan notes">{fu.planNotes}</Row>}
                    <Row label="Prescribed by">{fu.prescribedBy.name}</Row>
                    <Row label="Department">{fu.department?.name ?? '—'}</Row>
                    <Row label="Booking">
                      {fu.appointment
                        ? `${formatIstDateTime(fu.appointment.startsAt)} with ${fu.appointment.providerName}${fu.appointment.status === 'scheduled' ? '' : ` (${fu.appointment.status.replace('_', ' ')})`}`
                        : 'Not booked'}
                    </Row>
                    <Row label="Last contact">
                      {fu.lastContact
                        ? `${CHANNEL_LABEL[fu.lastContact.channel]}, ${OUTCOME_LABEL[fu.lastContact.outcome].toLowerCase()} on ${formatIstDateTime(fu.lastContact.attemptedAt)} by ${fu.lastContact.attemptedByName}`
                        : 'None yet'}
                    </Row>
                    {fu.cancelReason !== null && fu.status === 'cancelled' && <Row label="Cancel reason">{fu.cancelReason}</Row>}
                  </dl>
                  {open && can.plan && !owner && (
                    <p className="mt-3 text-xs text-muted-foreground">Prescribed by {fu.prescribedBy.name}. Only they or an admin can change this plan.</p>
                  )}
                  {open && (owner || can.book || can.checkIn) && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {can.checkIn && checkInToday && <Button size="sm" disabled={busyId === fu.id} onClick={() => void checkIn(fu)}>Check in</Button>}
                      {can.book && <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'book', fu })}>{booked ? 'Reschedule' : 'Book'}</Button>}
                      {can.book && booked && <Button size="sm" variant="destructive" onClick={() => setDialog({ kind: 'unbook', fu })}>Cancel booking</Button>}
                      {can.book && <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'contact', fu })}>Log contact</Button>}
                      {owner && <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'edit', fu })}>Change plan</Button>}
                      {owner && <Button size="sm" variant="destructive" onClick={() => setDialog({ kind: 'cancel', fu })}>Cancel follow-up</Button>}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="visits-heading">
        <h2 id="visits-heading" className="mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Visits</h2>
        <EncounterList encounters={encounters} can={{ startOrComplete: can.startOrComplete, cancelVisit: can.cancelVisit }} ownProviderOnly={isPi} selfProviderId={selfProviderId} />
      </section>

      {dialog?.kind === 'create' && (
        <FollowUpPlanModal mode="create" patientId={patientId} providers={providers} departments={departments} encounters={encounters} isPi={isPi} todayIso={todayIso} onClose={close} />
      )}
      {dialog?.kind === 'edit' && (
        <FollowUpPlanModal mode="edit" patientId={patientId} initial={dialog.fu} providers={providers} departments={departments} encounters={encounters} isPi={isPi} todayIso={todayIso} onClose={close} />
      )}
      {dialog?.kind === 'book' && <BookFollowUpModal followUp={dialog.fu} providers={providers} todayIso={todayIso} onClose={close} />}
      {dialog?.kind === 'contact' && <ContactAttemptModal followUpId={dialog.fu.id} onClose={close} />}
      {dialog?.kind === 'cancel' && (
        <ReasonDialog
          title="Cancel this follow-up?"
          description={`The follow-up due ${formatIsoDate(dialog.fu.dueDate)} will be cancelled${dialog.fu.appointment?.status === 'scheduled' ? ' and its booked appointment will be cancelled too' : ''}.`}
          confirmLabel="cancel follow-up"
          onSubmit={(reason) => cancelFollowUp(dialog.fu.id, reason)}
          onClose={close}
          onDone={done}
        />
      )}
      {dialog?.kind === 'unbook' && (
        <ReasonDialog
          title="Cancel this booking?"
          description="The appointment will be cancelled and the follow-up goes back to not booked."
          confirmLabel="cancel booking"
          onSubmit={(reason) => unbookFollowUpSlot(dialog.fu.id, reason)}
          onClose={close}
          onDone={done}
        />
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}:</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  )
}
