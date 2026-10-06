'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export interface UserOption { id: number; name: string }
export interface ProviderOption { id: number; name: string }

const EMPLOYMENT_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'on_leave', label: 'On Leave' },
  { value: 'terminated', label: 'Terminated' },
] as const

export function AddStaffMemberModal({ users, providers, onClose }: { users: UserOption[]; providers: ProviderOption[]; onClose: () => void }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [department, setDepartment] = useState('')
  const [title, setTitle] = useState('')
  const [employmentStatus, setEmploymentStatus] = useState<'active' | 'on_leave' | 'terminated'>('active')
  const [hireDate, setHireDate] = useState('')
  const [userId, setUserId] = useState<number | ''>('')
  const [providerId, setProviderId] = useState<number | ''>('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await fetch('/api/staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        department,
        title,
        employmentStatus,
        hireDate,
        userId: userId === '' ? null : userId,
        providerId: providerId === '' ? null : providerId,
      }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not add this staff member.')
  }

  const canSubmit = Boolean(name.trim()) && Boolean(department.trim()) && Boolean(title.trim()) && Boolean(hireDate) && !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Staff Member</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" aria-label="Name" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Department" aria-label="Department" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <select value={employmentStatus} onChange={(e) => setEmploymentStatus(e.target.value as 'active' | 'on_leave' | 'terminated')} aria-label="Employment status" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            {EMPLOYMENT_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Hire date</label>
            <input value={hireDate} onChange={(e) => setHireDate(e.target.value)} type="date" aria-label="Hire date" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Linked user (optional)</label>
            <select value={userId} onChange={(e) => setUserId(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Linked user" className="w-full rounded-md border border-border px-3 py-2 text-sm">
              <option value="">None</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Linked provider (optional)</label>
            <select value={providerId} onChange={(e) => setProviderId(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Linked provider" className="w-full rounded-md border border-border px-3 py-2 text-sm">
              <option value="">None</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Add Staff Member</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
