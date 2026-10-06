'use client'
import { useState } from 'react'
import { UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CheckInModal } from '@/components/CheckInModal'

export function CheckInButton({ providers, rooms }: { providers: { id: number; name: string }[]; rooms: { id: number; ward: string; roomNumber: string; bedNumber: string }[] }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}><UserPlus className="h-4 w-4" aria-hidden="true" /> Check In</Button>
      {open && <CheckInModal providers={providers} rooms={rooms} onClose={() => setOpen(false)} />}
    </>
  )
}
