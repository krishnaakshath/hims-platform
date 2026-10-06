'use client'
import { useState } from 'react'
import { NewEventModal } from './NewEventModal'

export function CalendarNewEventButton({ patients, providers, defaultDate }: {
  patients: { id: string; name: string }[]
  providers: { id: number; name: string }[]
  defaultDate: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90">New Event</button>
      {open && <NewEventModal patients={patients} providers={providers} defaultDate={defaultDate} onClose={() => setOpen(false)} />}
    </>
  )
}
