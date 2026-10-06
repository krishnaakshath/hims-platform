import Link from 'next/link'
import { redirect } from 'next/navigation'
import { FlaskConical, Users } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { listAllTrials } from '@/lib/queries/trials'

export default async function TrialsPage() {
  // Must be the first statement — see the comment in patients/page.tsx.
  const session = await requireSessionOrRedirect()
  // Matches LeftNav's roles for this route -- previously nav-hidden only,
  // with no actual server-side check, so a role the nav hides this from
  // could still reach it by URL.
  if (!CLINICAL_ROLES.includes(session.role)) redirect('/')
  const trials = await listAllTrials()

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Trials & Protocols</h1>
      {trials.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No trials found.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {trials.map((t) => (
            <Link
              key={t.id}
              href={`/trials/${t.id}`}
              className="group flex flex-col gap-3 rounded-md border border-border bg-card p-5 shadow-none"
            >
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
                  <FlaskConical className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <p className="truncate font-semibold text-foreground group-hover:text-primary">{t.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">{t.nctNumber}</p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded-full bg-secondary px-2.5 py-1 font-medium text-secondary-foreground">{t.condition}</span>
                <span className="rounded-full bg-secondary px-2.5 py-1 font-medium text-secondary-foreground">{t.site}</span>
                <span className="rounded-full bg-secondary px-2.5 py-1 font-medium text-secondary-foreground">Age {t.ageMin}–{t.ageMax}</span>
              </div>

              <div className="flex items-center gap-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
                <Users className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{t.studyDrug}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
