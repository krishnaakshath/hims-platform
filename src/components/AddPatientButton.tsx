'use client'
import { useState } from 'react'
import { AddClientModal } from './AddClientModal'

export function AddPatientButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary">Add New Patient</button>
      {open && <AddClientModal onClose={() => setOpen(false)} />}
    </>
  )
}
