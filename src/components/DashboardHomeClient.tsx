'use client'
import { useState } from 'react'
import { AddClientModal } from './AddClientModal'
import { SendFormModal } from './SendFormModal'

export function DashboardHomeClient({ templates, patients, canAddPatient = true }: {
  templates: { id: number; name: string }[]
  patients: { id: string; name: string }[]
  // POST /api/patients restricts registration to admin/frontdesk exclusively
  // (explicit product direction) -- crc must not see a button that just
  // 403s. Defaults true since AdminDashboard always passes it explicitly.
  canAddPatient?: boolean
}) {
  const [openModal, setOpenModal] = useState<'client' | 'form' | null>(null)

  return (
    <div className="mb-6 flex gap-3">
      <button onClick={() => setOpenModal('form')} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90">Send Form to Client</button>
      {canAddPatient && (
        <button onClick={() => setOpenModal('client')} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary">Add New Patient</button>
      )}
      {openModal === 'client' && <AddClientModal onClose={() => setOpenModal(null)} />}
      {openModal === 'form' && <SendFormModal templates={templates} patients={patients} onClose={() => setOpenModal(null)} />}
    </div>
  )
}
