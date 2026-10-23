'use client'
// WS7 T16: the payers list comes first; adding an insurer or TPA happens in a right-side drawer,
// and a successful save says so in a toast whose next step opens the new payer.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { PayerProfileForm } from './PayerProfileForm'
import { EMPTY_PROFILE } from './payer-profile-values'

const DRAWER_CLASS =
  'top-0 right-0 left-auto h-dvh max-h-dvh w-full max-w-2xl translate-x-0 translate-y-0 content-start overflow-y-auto rounded-none sm:max-w-2xl data-open:zoom-in-100 data-closed:zoom-out-100'

export function AddPayerDrawer() {
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)

  function created(payerId: number) {
    setOpen(false)
    router.refresh()
    toast.show({ title: 'Insurer or TPA added', action: { label: 'Open payer', href: `/rcm/payers/${payerId}` } })
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        Add insurer or TPA
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className={DRAWER_CLASS}>
          <DialogHeader>
            <DialogTitle>Add insurer or TPA</DialogTitle>
            <DialogDescription>Contacts, TPA links and required documents are added on the payer&apos;s page after saving.</DialogDescription>
          </DialogHeader>
          {open && <PayerProfileForm payerId={null} initial={EMPTY_PROFILE} onCreated={created} />}
        </DialogContent>
      </Dialog>
    </>
  )
}
