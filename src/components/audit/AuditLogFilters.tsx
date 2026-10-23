// WS8 T12 (spec D19): the audit log filter bar. A plain GET form, so the filters live in the URL
// (shareable, back-button safe) and it works without client JavaScript. Dates are IST calendar days.
import Link from 'next/link'
import { ALL_ROLES } from '@/lib/role-policy'
import type { Role } from '@/lib/auth'
import type { AuditLogFilters as Filters } from '@/lib/queries/audit-log'

// Same wording as the staff management panel.
export const AUDIT_ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  pi: 'PI',
  crc: 'Coordinator',
  frontdesk: 'Front Desk',
  pharmacy: 'Pharmacy',
  billing: 'Billing',
  labs: 'Labs',
  coder: 'Clinical Coder',
  collector: 'Sample Collector',
  rcm: 'Revenue Cycle (RCM)',
}

const FIELD = 'h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground'
const LABEL = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground'

export function AuditLogFilters({ filters }: { filters: Filters }) {
  return (
    <form method="get" action="/audit-log" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Audit log filters">
      <div>
        <label htmlFor="audit-q" className={LABEL}>Search</label>
        <input id="audit-q" name="q" type="search" defaultValue={filters.q ?? ''} maxLength={200} placeholder="User, action or details" className={FIELD} />
      </div>
      <div>
        <label htmlFor="audit-user" className={LABEL}>User</label>
        <input id="audit-user" name="user" type="text" defaultValue={filters.user ?? ''} maxLength={100} className={FIELD} />
      </div>
      <div>
        <label htmlFor="audit-role" className={LABEL}>Role</label>
        <select id="audit-role" name="role" defaultValue={filters.role ?? ''} className={FIELD}>
          <option value="">All roles</option>
          {ALL_ROLES.map((r) => <option key={r} value={r}>{AUDIT_ROLE_LABEL[r]}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="audit-patient" className={LABEL}>Patient UHID</label>
        <input id="audit-patient" name="patient" type="text" defaultValue={filters.patient ?? ''} maxLength={64} className={FIELD} />
      </div>
      <div>
        <label htmlFor="audit-action" className={LABEL}>Action contains</label>
        <input id="audit-action" name="action" type="text" defaultValue={filters.action ?? ''} maxLength={200} className={FIELD} />
      </div>
      <div>
        <label htmlFor="audit-from" className={LABEL}>From (IST)</label>
        <input id="audit-from" name="from" type="date" defaultValue={filters.from ?? ''} className={FIELD} />
      </div>
      <div>
        <label htmlFor="audit-to" className={LABEL}>To (IST)</label>
        <input id="audit-to" name="to" type="date" defaultValue={filters.to ?? ''} className={FIELD} />
      </div>
      <div className="flex items-end gap-2">
        <button type="submit" className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">Apply filters</button>
        <Link href="/audit-log" className="h-9 rounded-md border border-border px-4 text-sm font-medium leading-9 text-foreground hover:bg-secondary">Clear</Link>
      </div>
    </form>
  )
}
