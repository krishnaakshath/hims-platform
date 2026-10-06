import { redirect } from 'next/navigation'
import { ShieldCheck } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listAuditLog } from '@/lib/queries/audit-log'

const SECTION = 'rounded-md border border-border bg-card p-5 shadow-none'

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin',
  pi: 'PI',
  crc: 'Coordinator',
}

export default async function AuditLogPage() {
  const session = await requireSessionOrRedirect()
  // Admin-only: this page surfaces every staff action across the app,
  // including other users' activity, so it must never render for a
  // non-admin session even though the nav already hides the link.
  if (session.role !== 'admin') redirect('/')

  const entries = await listAuditLog(200)
  await logAudit(session, 'viewed audit log', null)

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
          <ShieldCheck className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Audit Log</h1>
          <p className="text-sm text-muted-foreground">Every recorded action across the system, most recent first — the last {entries.length} entries.</p>
        </div>
      </div>

      <div className={SECTION}>
        {entries.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No activity recorded yet.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/40 text-left">
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Time</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">User</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Role</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Action</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={e.id} className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''} transition-colors hover:bg-secondary`}>
                    <td className="whitespace-nowrap p-3 text-muted-foreground">{new Date(e.timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</td>
                    <td className="p-3 font-medium text-foreground">{e.userName}</td>
                    <td className="p-3 text-foreground">{e.role ? (ROLE_LABEL[e.role] ?? e.role) : '—'}</td>
                    <td className="p-3 text-foreground">{e.action}</td>
                    <td className="p-3 text-muted-foreground">{e.patientId ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
