'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { UserPlus, Copy, Check } from 'lucide-react'

export interface StaffRow {
  id: number
  name: string
  email: string
  role: 'admin' | 'pi' | 'crc' | 'frontdesk' | 'pharmacy' | 'billing' | 'labs' | 'coder' // SP6: + coder
  mfaEnabled: boolean
}

const ROLE_LABEL: Record<StaffRow['role'], string> = { admin: 'Administrator', pi: 'Principal Investigator', crc: 'Coordinator', frontdesk: 'Front Desk', pharmacy: 'Pharmacy', billing: 'Billing', labs: 'Labs', coder: 'Clinical Coder' /* SP6 */ }
const ROLE_BADGE: Record<StaffRow['role'], string> = {
  admin: 'bg-accent/10 text-accent',
  pi: 'bg-primary/10 text-primary',
  crc: 'bg-sky-500/10 text-sky-700',
  frontdesk: 'bg-emerald-500/10 text-emerald-700',
  pharmacy: 'bg-violet-500/10 text-violet-700',
  billing: 'bg-amber-500/10 text-amber-700',
  labs: 'bg-rose-500/10 text-rose-700',
  coder: 'bg-teal-500/10 text-teal-700', // SP6
}

function AddStaffForm({ onCreated }: { onCreated: (row: StaffRow, password: string) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<StaffRow['role']>('crc')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const result = await sendJson<{ id: number; name: string; email: string; role: StaffRow['role']; password: string }>('/api/users', 'POST', { name, email, role })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    const created = result.data
    onCreated({ id: created.id, name: created.name, email: created.email, role: created.role, mfaEnabled: false }, created.password)
    setName('')
    setEmail('')
    setRole('crc')
    setOpen(false)
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
      >
        <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
        Add Staff Member
      </button>
    )
  }

  return (
    <form onSubmit={submit} className="mb-4 space-y-3 rounded-lg border border-border bg-secondary/40 p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Full name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required className="w-full rounded-md border border-border px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-full rounded-md border border-border px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Role</label>
          <select value={role} onChange={(e) => setRole(e.target.value as StaffRow['role'])} className="w-full rounded-md border border-border px-2 py-1.5 text-sm">
            <option value="crc">Coordinator</option>
            <option value="pi">Principal Investigator</option>
            <option value="admin">Administrator</option>
            <option value="frontdesk">Front Desk</option>
            <option value="pharmacy">Pharmacy</option>
            <option value="billing">Billing</option>
            <option value="labs">Labs</option>
            {/* SP6 */}
            <option value="coder">Clinical Coder</option>
          </select>
        </div>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={saving} className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
          {saving ? 'Creating…' : 'Create account'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs font-medium text-muted-foreground hover:text-foreground">Cancel</button>
      </div>
    </form>
  )
}

function NewCredentialBanner({ row, password, onDismiss }: { row: StaffRow; password: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    await navigator.clipboard.writeText(password)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm">
      <p className="font-medium text-foreground">Account created for {row.name}</p>
      <p className="mt-1 text-xs text-muted-foreground">This password is shown once and cannot be retrieved again — share it with {row.name} now.</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="rounded-md border border-border bg-card px-2 py-1 font-mono text-sm">{password}</code>
        <button onClick={copy} className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <button onClick={onDismiss} className="mt-2 text-xs font-medium text-muted-foreground hover:text-foreground">Dismiss</button>
    </div>
  )
}

export function StaffManagementPanel({ staff, isAdmin }: { staff: StaffRow[]; isAdmin: boolean }) {
  const router = useRouter()
  const [newCredential, setNewCredential] = useState<{ row: StaffRow; password: string } | null>(null)
  const [resetting, setResetting] = useState<number | null>(null)
  const [resetError, setResetError] = useState<string | null>(null)

  function handleCreated(row: StaffRow, password: string) {
    setNewCredential({ row, password })
    router.refresh()
  }

  async function resetMfa(id: number) {
    setResetting(id)
    setResetError(null)
    const result = await sendJson(`/api/users/${id}/reset-mfa`, 'POST')
    setResetting(null)
    if (!result.ok) { setResetError(result.error); return }
    router.refresh()
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{staff.length} staff account{staff.length === 1 ? '' : 's'}</p>
        {isAdmin && <AddStaffForm onCreated={handleCreated} />}
      </div>
      {resetError && <p role="alert" className="mb-3 text-xs text-destructive">{resetError}</p>}
      {newCredential && <NewCredentialBanner row={newCredential.row} password={newCredential.password} onDismiss={() => setNewCredential(null)} />}
      {staff.length === 0 ? (
        <p className="text-sm text-muted-foreground">No staff accounts yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {staff.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{s.name}</p>
                <p className="truncate text-xs text-muted-foreground">{s.email}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${ROLE_BADGE[s.role]}`}>{ROLE_LABEL[s.role]}</span>
                {isAdmin && s.mfaEnabled && (
                  <button onClick={() => resetMfa(s.id)} disabled={resetting === s.id} className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-50">
                    {resetting === s.id ? 'Resetting…' : 'Reset MFA'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
