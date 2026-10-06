'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

const EMPLOYMENT_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'on_leave', label: 'On Leave' },
  { value: 'terminated', label: 'Terminated' },
] as const

export interface EditableStaffMember {
  id: number
  department: string
  title: string
  employmentStatus: 'active' | 'on_leave' | 'terminated'
  terminationDate: string | null
}

// Fix B: closest precedent is AddStaffMemberModal -- same Dialog-modal
// pattern, same fetch-then-router.refresh()-then-onClose flow. Pre-filled
// with the current row (not blank) since this is an edit, not a create.
// Only the fields PATCH /api/staff/[id] accepts are editable here --
// name/hireDate/userId/providerId are treated as set-at-creation.
export function EditStaffMemberModal({ staffMember, onClose }: { staffMember: EditableStaffMember; onClose: () => void }) {
  const router = useRouter()
  const [department, setDepartment] = useState(staffMember.department)
  const [title, setTitle] = useState(staffMember.title)
  const [employmentStatus, setEmploymentStatus] = useState<'active' | 'on_leave' | 'terminated'>(staffMember.employmentStatus)
  const [terminationDate, setTerminationDate] = useState(staffMember.terminationDate ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await fetch(`/api/staff/${staffMember.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        department,
        title,
        employmentStatus,
        terminationDate: terminationDate ? terminationDate : null,
      }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not update this staff member.')
  }

  const canSubmit = Boolean(department.trim()) && Boolean(title.trim()) && !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Staff Member</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Department" aria-label="Department" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <select value={employmentStatus} onChange={(e) => setEmploymentStatus(e.target.value as 'active' | 'on_leave' | 'terminated')} aria-label="Employment status" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            {EMPLOYMENT_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Termination date (optional)</label>
            <input value={terminationDate} onChange={(e) => setTerminationDate(e.target.value)} type="date" aria-label="Termination date" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Save Changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
