'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2 } from 'lucide-react'
import { DeletePatientDialog } from '@/components/DeletePatientDialog'

export function DeletePatientButton({ patientId, patientName }: { patientId: string; patientName: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-md border border-destructive/30 px-3 py-1.5 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        Delete Patient
      </button>
      {open && (
        <DeletePatientDialog
          target={{ id: patientId, name: patientName }}
          onClose={() => setOpen(false)}
          onDeleted={() => router.push('/patients')}
        />
      )}
    </>
  )
}
