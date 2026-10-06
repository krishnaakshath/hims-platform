import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { listFormSubmissions } from '@/lib/queries/form-submissions'
import { ClientFormsTable } from '@/components/ClientFormsTable'

// Same elevated-card treatment ReportTable.tsx and the rest of the app's
// data surfaces already use.
const SECTION = 'rounded-md border border-border bg-card p-5 shadow-none'

export default async function ClientFormsPage({ searchParams }: { searchParams: Promise<{ status?: string; diagnosisTag?: string }> }) {
  const session = await requireSessionOrRedirect()
  // Matches LeftNav's roles for this route -- previously nav-hidden only,
  // with no actual server-side check, so a role the nav hides this from
  // could still reach it by URL.
  if (!CLINICAL_ROLES.includes(session.role)) redirect('/')
  const { status, diagnosisTag } = await searchParams
  const submissions = await listFormSubmissions({ status: status as 'sent' | 'partial' | 'completed' | undefined, diagnosisTag })
  await logAudit(session, 'viewed client forms', null)

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Client Forms</h1>
      <div className={SECTION}>
        {submissions.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No records found.</p>
        ) : (
          <ClientFormsTable submissions={submissions} />
        )}
      </div>
    </div>
  )
}
