'use client'
// Encounter coding status actions. A button shows only when the status machine allows the action
// from the current status (nextCodingStatus) AND the role may take it (CODING_ACTION_ROLES; assign
// is admin-only), so a coder never sees Assign. Claim shows only while unclaimed and Release only
// while claimed. Every other action needs the claim (ruling 7; admin is exempt), and nothing shows
// before the visit is completed, so no button is offered that the server would refuse. Reopen asks for a reason in a dialog. A refusal (409 incl. the retry message, 422
// with the blocking rule issues, 403) is shown in an alert.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Role } from '@/lib/auth'
import type { CodingIssue } from '@/lib/coding/rules'
import { codingActionAvailable, type CodingAction, type EncounterCodingStatus } from '@/lib/coding/status'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { postCodingAction } from './codingApi'

type SimpleAction = Exclude<CodingAction, 'assign' | 'reopen' | 'raise_query'>
const SIMPLE_ACTIONS: { action: SimpleAction; label: string }[] = [
  { action: 'claim', label: 'Claim' },
  { action: 'release', label: 'Release' },
  { action: 'resume', label: 'Resume coding' },
  { action: 'mark_coded', label: 'Mark coded' },
  { action: 'finalise', label: 'Finalise' },
]

export function CodingActions({ encounterId, status, role, assignedToUserId, holdsClaim, hasAccount, isCompleted, coders }: {
  encounterId: number
  status: EncounterCodingStatus
  role: Role
  assignedToUserId: number | null
  /** Admin, or the coder the encounter is assigned to. */
  holdsClaim: boolean
  /** The login has a staff user account; claiming needs one (the env-only admin cannot claim). */
  hasAccount: boolean
  /** Coding actions apply to completed visits only. */
  isCompleted: boolean
  /** Staff with the coder role (id and name only); loaded for an admin only. */
  coders: { id: number; name: string }[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; issues: CodingIssue[] } | null>(null)
  const [assignee, setAssignee] = useState('')
  const [reopenOpen, setReopenOpen] = useState(false)
  const [reason, setReason] = useState('')

  const available = (a: CodingAction) => {
    if (!isCompleted || !codingActionAvailable(status, a, role)) return false
    if (a === 'claim') return assignedToUserId === null && hasAccount
    if (a === 'assign') return true
    if (!holdsClaim) return false
    if (a === 'release') return assignedToUserId !== null
    return true
  }

  async function run(req: Parameters<typeof postCodingAction>[1]): Promise<boolean> {
    setBusy(true)
    setError(null)
    const r = await postCodingAction(encounterId, req)
    setBusy(false)
    if (r.ok) { router.refresh(); return true }
    setError({ message: r.error, issues: r.issues ?? [] })
    return false
  }

  const simple = SIMPLE_ACTIONS.filter((a) => available(a.action))
  const canAssign = available('assign') && coders.length > 0
  const canReopen = available('reopen')
  if (simple.length === 0 && !canAssign && !canReopen) return null

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        {simple.map((a) => (
          <Button key={a.action} type="button" size="sm" variant={a.action === 'finalise' || a.action === 'mark_coded' ? 'default' : 'outline'} disabled={busy} onClick={() => run({ action: a.action })}>
            {a.label}
          </Button>
        ))}
        {canAssign && (
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1 text-xs font-medium">
              Assign to
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="h-7 rounded-lg border border-input bg-background px-2 text-sm">
                <option value="">Choose a coder</option>
                {coders.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <Button type="button" size="sm" variant="outline" disabled={busy || !assignee} onClick={() => run({ action: 'assign', assigneeUserId: Number(assignee) })}>
              Assign
            </Button>
          </div>
        )}
        {canReopen && (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setReason(''); setError(null); setReopenOpen(true) }}>
            Reopen
          </Button>
        )}
      </div>

      {error && !reopenOpen && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <p>{error.message}</p>
          {error.issues.length > 0 && (
            <ul className="mt-1 list-disc ps-5">
              {error.issues.map((i, n) => <li key={`${i.code}-${n}`}>{i.message}</li>)}
            </ul>
          )}
        </div>
      )}

      {reopenOpen && (
        <Dialog open onOpenChange={(open) => { if (!open) setReopenOpen(false) }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Reopen coding</DialogTitle>
              <DialogDescription>Finalised codes become editable again. The reason is kept in the coding history.</DialogDescription>
            </DialogHeader>
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault()
                if (await run({ action: 'reopen', reason: reason.trim() })) setReopenOpen(false)
              }}
            >
              <label className="flex flex-col gap-1 text-sm font-medium">
                Reason for reopening
                <textarea
                  required
                  maxLength={500}
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm"
                />
              </label>
              {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setReopenOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={busy || reason.trim() === ''}>Reopen coding</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
