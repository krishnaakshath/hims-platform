'use client'
import { useState } from 'react'
import { NewEventModal } from './NewEventModal'
import type { PickedPatient } from './PatientPicker'

// Wave C: `initialPatient` (calendar ?book=<chart id>) opens the modal with
// that patient preselected.
export function CalendarNewEventButton({ providers, defaultDate, initialPatient = null }: {
  providers: { id: number; name: string }[]
  defaultDate: string
  initialPatient?: PickedPatient | null
}) {
  const [open, setOpen] = useState(initialPatient !== null)
  return (
    <>
      <button onClick={() => setOpen(true)} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90">New Event</button>
      {open && <NewEventModal providers={providers} defaultDate={defaultDate} initialPatient={initialPatient} onClose={() => setOpen(false)} />}
    </>
  )
}
