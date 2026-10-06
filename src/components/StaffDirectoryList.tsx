'use client'
import { useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AddStaffMemberModal, type UserOption, type ProviderOption } from '@/components/AddStaffMemberModal'
import type { staffMembers } from '@/db/schema'
import type { ExpiringCredential } from '@/lib/queries/staff-credentials'

type StaffMember = typeof staffMembers.$inferSelect
type EmploymentStatus = StaffMember['employmentStatus']

const EMPLOYMENT_STATUS_STYLES: Record<EmploymentStatus, string> = {
  active: 'border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400',
  on_leave: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  terminated: 'border-destructive/30 bg-destructive/10 text-destructive',
}

const EMPLOYMENT_STATUS_LABELS: Record<EmploymentStatus, string> = {
  active: 'Active',
  on_leave: 'On Leave',
  terminated: 'Terminated',
}

export function EmploymentStatusPill({ status }: { status: EmploymentStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${EMPLOYMENT_STATUS_STYLES[status]}`}>
      {EMPLOYMENT_STATUS_LABELS[status]}
    </span>
  )
}

function SoonestExpiringIndicator({ credential }: { credential: ExpiringCredential }) {
  const expired = credential.status === 'expired'
  const Icon = expired ? AlertTriangle : Clock
  const label = expired
    ? `${credential.credentialType} expired ${Math.abs(credential.daysUntilExpiry)}d ago`
    : `${credential.credentialType} expires in ${credential.daysUntilExpiry}d`
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${expired ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'}`}>
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      {label}
    </span>
  )
}

export function StaffDirectoryList({
  staffMembers: staff,
  expiringCredentials,
  users,
  providers,
  canWrite,
}: {
  staffMembers: StaffMember[]
  expiringCredentials: ExpiringCredential[]
  users: UserOption[]
  providers: ProviderOption[]
  canWrite: boolean
}) {
  const [adding, setAdding] = useState(false)

  function soonestFor(staffMemberId: number): ExpiringCredential | undefined {
    return expiringCredentials.find((c) => c.staffMemberId === staffMemberId)
  }

  return (
    <div className="rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Staff Directory</h1>
        {canWrite && <Button onClick={() => setAdding(true)}>Add Staff Member</Button>}
      </div>

      {staff.length === 0 ? (
        <p className="mt-2 rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No staff members on file.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-left">
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Name</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Department</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Title</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Credential Watch</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((s, i) => {
                const soonest = soonestFor(s.id)
                return (
                  <tr key={s.id} className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''} transition-colors hover:bg-secondary`}>
                    <td className="p-3">
                      <Link href={`/staff/${s.id}`} className="font-medium text-foreground hover:text-primary hover:underline">{s.name}</Link>
                    </td>
                    <td className="p-3 text-foreground">{s.department}</td>
                    <td className="p-3 text-foreground">{s.title}</td>
                    <td className="p-3"><EmploymentStatusPill status={s.employmentStatus} /></td>
                    <td className="p-3">{soonest && <SoonestExpiringIndicator credential={soonest} />}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {adding && <AddStaffMemberModal users={users} providers={providers} onClose={() => setAdding(false)} />}
    </div>
  )
}
