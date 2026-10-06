'use client'
import { useState } from 'react'
import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmploymentStatusPill } from '@/components/StaffDirectoryList'
import { AddCredentialModal } from '@/components/AddCredentialModal'
import { EditStaffMemberModal } from '@/components/EditStaffMemberModal'
import { EditCredentialModal } from '@/components/EditCredentialModal'
import type { staffMembers, staffCredentials } from '@/db/schema'

type StaffMember = typeof staffMembers.$inferSelect
type Credential = typeof staffCredentials.$inferSelect
export type StaffMemberWithCredentials = StaffMember & { credentials: Credential[] }

// Matches the 60-day cutoff computed server-side in
// listExpiringOrExpiredCredentials (src/lib/queries/staff-credentials.ts) --
// a credential expiring exactly 60 days out is "expiring soon", 61+ days out
// is "current". Recomputed here (rather than passed down) because this
// page loads every credential for one staff member, not just the
// already-expiring/expired global set that query returns.
type CredentialStatus = 'no_expiry' | 'current' | 'expiring_soon' | 'expired'

function classifyCredential(expiresOn: string | null): CredentialStatus {
  if (!expiresOn) return 'no_expiry'
  const todayStr = new Date().toISOString().slice(0, 10)
  const cutoffStr = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  if (expiresOn < todayStr) return 'expired'
  if (expiresOn <= cutoffStr) return 'expiring_soon'
  return 'current'
}

const CREDENTIAL_STATUS_CONFIG: Record<Exclude<CredentialStatus, 'no_expiry'>, { label: string; className: string; icon: React.ComponentType<{ className?: string }> }> = {
  current: { label: 'Current', className: 'border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400', icon: CheckCircle2 },
  expiring_soon: { label: 'Expiring Soon', className: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400', icon: AlertTriangle },
  expired: { label: 'Expired', className: 'border-destructive/30 bg-destructive/10 text-destructive', icon: XCircle },
}

function CredentialStatusPill({ status }: { status: CredentialStatus }) {
  if (status === 'no_expiry') return null
  const { label, className, icon: Icon } = CREDENTIAL_STATUS_CONFIG[status]
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}>
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      {label}
    </span>
  )
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2.5 last:border-b-0">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-sm text-foreground">{value}</span>
    </div>
  )
}

const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'
const SECTION_HEADING = 'mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

export function StaffMemberDetail({
  staffMember,
  linkedUserName,
  linkedProviderName,
  canWrite,
}: {
  staffMember: StaffMemberWithCredentials
  linkedUserName?: string | null
  linkedProviderName?: string | null
  canWrite: boolean
}) {
  const [addingCredential, setAddingCredential] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editingCredential, setEditingCredential] = useState<Credential | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{staffMember.name}</h1>
          <p className="text-sm text-muted-foreground">{staffMember.title} · {staffMember.department}</p>
        </div>
        {canWrite && <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit</Button>}
      </div>

      <section className={SECTION}>
        <h2 className={SECTION_HEADING}>Employment Info</h2>
        <div>
          <InfoRow label="Employment Status" value={<EmploymentStatusPill status={staffMember.employmentStatus} />} />
          <InfoRow label="Department" value={staffMember.department} />
          <InfoRow label="Title" value={staffMember.title} />
          {/* hireDate/terminationDate are plain YYYY-MM-DD date()-column
              strings -- never re-wrap in `new Date(...)` here, which parses
              at UTC midnight and can display the wrong day in any timezone
              west of UTC (the same bug class already fixed in
              AllAppointmentsReportTable.tsx / AllEncountersReportTable.tsx;
              final whole-branch review, Important #3). */}
          <InfoRow label="Hire Date" value={staffMember.hireDate} />
          {staffMember.terminationDate && (
            <InfoRow label="Termination Date" value={staffMember.terminationDate} />
          )}
          {staffMember.userId !== null && <InfoRow label="Linked User" value={linkedUserName ?? `User #${staffMember.userId}`} />}
          {staffMember.providerId !== null && <InfoRow label="Linked Provider" value={linkedProviderName ?? `Provider #${staffMember.providerId}`} />}
        </div>
      </section>

      <section className={SECTION}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className={SECTION_HEADING.replace('mb-3 ', '')}>Credentials</h2>
          {canWrite && <Button size="sm" onClick={() => setAddingCredential(true)}>Add Credential</Button>}
        </div>

        {staffMember.credentials.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No credentials on file.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/40 text-left">
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Type</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Number</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Expiry</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
                  {canWrite && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground" />}
                </tr>
              </thead>
              <tbody>
                {staffMember.credentials.map((c, i) => {
                  const status = classifyCredential(c.expiresOn)
                  return (
                    <tr key={c.id} className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''}`}>
                      <td className="p-3 font-medium text-foreground">{c.credentialType}</td>
                      <td className="p-3 text-foreground">{c.credentialNumber ?? '—'}</td>
                      {/* expiresOn is a plain YYYY-MM-DD date()-column string
                          -- rendered directly, never re-wrapped in
                          `new Date(...)` (see the Hire Date comment above). */}
                      <td className="p-3 text-foreground">{c.expiresOn ?? 'No expiry on file'}</td>
                      <td className="p-3"><CredentialStatusPill status={status} /></td>
                      {canWrite && (
                        <td className="p-3 text-right">
                          <Button size="sm" variant="outline" onClick={() => setEditingCredential(c)}>Edit</Button>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {addingCredential && <AddCredentialModal staffMemberId={staffMember.id} onClose={() => setAddingCredential(false)} />}
      {editingCredential && (
        <EditCredentialModal
          credential={{
            id: editingCredential.id,
            staffMemberId: editingCredential.staffMemberId,
            credentialType: editingCredential.credentialType,
            credentialNumber: editingCredential.credentialNumber,
            expiresOn: editingCredential.expiresOn,
          }}
          onClose={() => setEditingCredential(null)}
        />
      )}
      {editing && (
        <EditStaffMemberModal
          staffMember={{
            id: staffMember.id,
            department: staffMember.department,
            title: staffMember.title,
            employmentStatus: staffMember.employmentStatus,
            terminationDate: staffMember.terminationDate,
          }}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  )
}
