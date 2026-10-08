import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { REPORTS_ROLES } from '@/lib/role-policy'
import { reportLeavesFor } from '@/lib/reports/catalog'

// Wave I (P1-23): the Reports landing page -- REPORTS_ROLES (LeftNav /reports),
// listing only the reports this role can open (src/lib/reports/catalog.ts).
export default async function ReportsIndexPage() {
  const session = await requireSessionOrRedirect()
  if (!REPORTS_ROLES.includes(session.role)) redirect('/')
  const leaves = reportLeavesFor(session.role)
  const groups = [...new Set(leaves.map((l) => l.group))]

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Reports</h1>
      {groups.map((g) => (
        <section key={g} className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{g}</h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {leaves.filter((l) => l.group === g).map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="block rounded-lg border border-border bg-card p-4 hover:bg-muted">
                  <span className="font-medium text-foreground">{l.label}</span>
                  <span className="mt-1 block text-sm text-muted-foreground">{l.description}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
