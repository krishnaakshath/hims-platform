'use client'
import { useState } from 'react'
import { UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CheckInModal, type CheckInDepartment, type CheckInDoctor } from '@/components/CheckInModal'
import type { PickedPatient } from '@/components/PatientPicker'

// Wave C: `initialPatient` (check-in page ?patient=) opens the modal with that patient preselected.
// WS6 T9: `providers` are the clinical doctors, chosen by `departments`.
// WS3 T3: no room list -- an inpatient choice opens the admission dialog, which loads the free beds.
export function CheckInButton({ providers, departments, initialPatient = null }: { providers: CheckInDoctor[]; departments: CheckInDepartment[]; initialPatient?: PickedPatient | null }) {
  const [open, setOpen] = useState(initialPatient !== null)
  return (
    <>
      <Button onClick={() => setOpen(true)}><UserPlus className="h-4 w-4" aria-hidden="true" /> Check In</Button>
      {open && <CheckInModal providers={providers} departments={departments} initialPatient={initialPatient} onClose={() => setOpen(false)} />}
    </>
  )
}
