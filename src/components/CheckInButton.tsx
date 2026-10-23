'use client'
import { useState } from 'react'
import { UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CheckInModal } from '@/components/CheckInModal'
import type { PickedPatient } from '@/components/PatientPicker'

// Wave C: `initialPatient` (check-in page ?patient=) opens the modal with that patient preselected.
// WS3 T3: no room list -- an inpatient choice opens the admission dialog, which loads the free beds.
export function CheckInButton({ providers, initialPatient = null }: { providers: { id: number; name: string }[]; initialPatient?: PickedPatient | null }) {
  const [open, setOpen] = useState(initialPatient !== null)
  return (
    <>
      <Button onClick={() => setOpen(true)}><UserPlus className="h-4 w-4" aria-hidden="true" /> Check In</Button>
      {open && <CheckInModal providers={providers} initialPatient={initialPatient} onClose={() => setOpen(false)} />}
    </>
  )
}
