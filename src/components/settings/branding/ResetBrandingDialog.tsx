'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

// WL T8: "Reset to defaults" (spec §7). The admin must type RESET; the confirm button stays
// disabled until they do. The caller posts { confirm: 'RESET', revision }.
export function ResetBrandingDialog({ open, busy, error, onOpenChange, onConfirm }: {
  open: boolean
  busy: boolean
  error: string | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const [typed, setTyped] = useState('')
  // Clear the confirmation whenever the dialog closes, however it closes (Cancel, Escape, or the
  // parent closing it after a successful reset), so the next open never starts pre-confirmed.
  if (!open && typed !== '') setTyped('')
  const ready = typed === 'RESET' && !busy

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reset branding to defaults?</DialogTitle>
          <DialogDescription>
            This clears the name, colours, sign-in page, printout and message settings, and removes every uploaded logo and icon.
            Billing details are not affected.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-2"
          onSubmit={(e) => { e.preventDefault(); if (ready) onConfirm() }}
        >
          <label htmlFor="brand-reset-confirm" className="block text-sm font-medium">Type RESET to confirm</label>
          <Input id="brand-reset-confirm" value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="destructive" disabled={!ready}>Reset branding</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
