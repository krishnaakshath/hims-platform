'use client'
import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EligibilityCheckModal } from '@/components/EligibilityCheckModal'

export function EligibilityCheckButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}><ShieldCheck className="h-4 w-4" aria-hidden="true" /> Verify Insurance</Button>
      {open && <EligibilityCheckModal onClose={() => setOpen(false)} />}
    </>
  )
}
