import Link from 'next/link'
import { CalendarPlus, IdCard, UserCheck } from 'lucide-react'

// Wave C front-desk quick path from the patient page. Plain links (no client
// state): check-in and booking open their modal with this patient
// preselected; the UHID card opens the printable registration slip. Each is
// shown only to the roles whose page/route would accept it.
const LINK = 'inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary'

export function PatientQuickActions({ patientId, can }: { patientId: string; can: { checkIn: boolean; book: boolean; printCard: boolean } }) {
  if (!can.checkIn && !can.book && !can.printCard) return null
  const id = encodeURIComponent(patientId)
  return (
    <nav aria-label="Patient actions" className="flex flex-wrap gap-2">
      {can.checkIn && (
        <Link href={`/front-desk/check-in?patient=${id}`} className={LINK}>
          <UserCheck className="h-4 w-4" aria-hidden="true" />Check in
        </Link>
      )}
      {can.book && (
        <Link href={`/calendar?book=${id}`} className={LINK}>
          <CalendarPlus className="h-4 w-4" aria-hidden="true" />Book appointment
        </Link>
      )}
      {can.printCard && (
        <a href={`/print/registration/${id}`} target="_blank" rel="noopener noreferrer" className={LINK}>
          <IdCard className="h-4 w-4" aria-hidden="true" />Print UHID card
        </a>
      )}
    </nav>
  )
}

export function RegisteredBanner({ patientId, uhid, canCheckIn }: { patientId: string; uhid: string | null; canCheckIn: boolean }) {
  const id = encodeURIComponent(patientId)
  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-success/30 bg-success/10 px-4 py-3 text-sm">
      <p className="text-foreground">
        Patient registered{uhid ? <> — UHID <span className="font-mono font-semibold">{uhid}</span></> : null}.
      </p>
      <div className="flex flex-wrap gap-2">
        <a href={`/print/registration/${id}`} target="_blank" rel="noopener noreferrer" className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90">Print registration slip</a>
        {canCheckIn && <Link href={`/front-desk/check-in?patient=${id}`} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary">Check in now</Link>}
      </div>
    </div>
  )
}
