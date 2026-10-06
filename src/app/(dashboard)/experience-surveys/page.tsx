import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Star, MessagesSquare, Send } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listReviews, listSurveyableSubmissions } from '@/lib/queries/reviews'
import { SendSurveyButton } from '@/components/SendSurveyButton'

const SECTION = 'rounded-md border border-border bg-card p-5 shadow-none'
const FIELD = 'rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground transition-colors focus:outline-none focus:ring-2 focus:ring-ring'
const STATUS_DOT: Record<string, string> = { sent: 'bg-warning', completed: 'bg-success' }
const STATUS_LABEL: Record<string, string> = { sent: 'Sent', completed: 'Completed' }

export default async function ExperienceSurveysPage({ searchParams }: { searchParams: Promise<{ status?: string; dateFrom?: string; dateTo?: string; sortBy?: string; sortDir?: string }> }) {
  const session = await requireSessionOrRedirect()
  // LeftNav.tsx:63 — { href: '/experience-surveys', roles: ['admin', 'crc'] }
  if (!['admin', 'crc'].includes(session.role)) redirect('/')
  const sp = await searchParams
  const filters = {
    status: sp.status === 'sent' || sp.status === 'completed' ? (sp.status as 'sent' | 'completed') : undefined,
    dateFrom: sp.dateFrom,
    dateTo: sp.dateTo,
    sortBy: sp.sortBy === 'ratingOverall' ? ('ratingOverall' as const) : ('sentAt' as const),
    sortDir: sp.sortDir === 'asc' ? ('asc' as const) : ('desc' as const),
  }
  const [reviewsList, surveyable] = await Promise.all([
    listReviews(filters),
    listSurveyableSubmissions(),
  ])
  await logAudit(session, 'viewed pre-screening experience surveys', null)

  // Derived from the same (filtered) reviewsList the table below renders,
  // rather than a separate DB-wide average -- otherwise applying a filter
  // shows a rating that doesn't describe the rows actually on screen (e.g.
  // "4.0 / 5 across 0 responses" when filtering to Sent-only surveys).
  const completedRatings = reviewsList.filter((r) => r.status === 'completed' && r.ratingOverall !== null).map((r) => r.ratingOverall!)
  const averageRating = completedRatings.length > 0 ? completedRatings.reduce((a, b) => a + b, 0) / completedRatings.length : null

  const completedCount = reviewsList.filter((r) => r.status === 'completed').length
  const sentCount = reviewsList.filter((r) => r.status === 'sent').length

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Pre-Screening Experience Surveys</h1>
        <SendSurveyButton candidates={surveyable} />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex items-center gap-3 rounded-xl border border-primary/10 bg-card p-4 shadow-none">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-700" aria-hidden="true">
            <Star className="h-4.5 w-4.5" />
          </span>
          <div>
            <p className="text-xl font-bold tabular-nums text-foreground">{averageRating !== null ? averageRating.toFixed(1) : '—'}<span className="text-sm font-medium text-muted-foreground">/5</span></p>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Avg. rating ({completedRatings.length} responses)</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-primary/10 bg-card p-4 shadow-none">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-success/10 text-success" aria-hidden="true">
            <MessagesSquare className="h-4.5 w-4.5" />
          </span>
          <div>
            <p className="text-xl font-bold tabular-nums text-foreground">{completedCount}</p>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Completed</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-primary/10 bg-card p-4 shadow-none">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-warning/10 text-warning" aria-hidden="true">
            <Send className="h-4.5 w-4.5" />
          </span>
          <div>
            <p className="text-xl font-bold tabular-nums text-foreground">{sentCount}</p>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Awaiting response</p>
          </div>
        </div>
      </div>

      <form className={`mb-6 flex flex-wrap items-end gap-3 text-sm ${SECTION}`} action="/experience-surveys">
        <div>
          <label htmlFor="survey-status" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filter By</label>
          <select id="survey-status" name="status" defaultValue={filters.status ?? ''} className={FIELD}>
            <option value="">All statuses</option>
            <option value="sent">Sent</option>
            <option value="completed">Completed</option>
          </select>
        </div>
        <div>
          <label htmlFor="survey-date-from" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">From</label>
          <input id="survey-date-from" type="date" name="dateFrom" defaultValue={filters.dateFrom ?? ''} className={FIELD} />
        </div>
        <div>
          <label htmlFor="survey-date-to" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">To</label>
          <input id="survey-date-to" type="date" name="dateTo" defaultValue={filters.dateTo ?? ''} className={FIELD} />
        </div>
        <div>
          <label htmlFor="survey-sort-by" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sort By</label>
          <select id="survey-sort-by" name="sortBy" defaultValue={filters.sortBy} className={FIELD}>
            <option value="sentAt">Date Sent</option>
            <option value="ratingOverall">Rating</option>
          </select>
        </div>
        <button type="submit" className="rounded-md border border-border px-4 py-2 font-medium text-foreground transition-colors hover:bg-secondary">Apply</button>
      </form>

      {reviewsList.length === 0 ? (
        <div className="rounded-md border border-border bg-card p-8 text-center shadow-none">
          <p className="text-sm text-muted-foreground">No records found.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-card shadow-none">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-left">
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Form</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Rating</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sent</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Responded</th>
              </tr>
            </thead>
            <tbody>
              {reviewsList.map((r, i) => (
                <tr key={r.id} className={`group border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''} transition-colors hover:bg-secondary`}>
                  <td className="p-3">
                    <Link href={`/experience-surveys/${r.id}`} className="font-medium text-foreground group-hover:text-primary group-hover:underline">{r.patientName}</Link>
                  </td>
                  <td className="p-3 text-foreground">{r.templateName}</td>
                  <td className="p-3">
                    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
                      <span className={`h-2 w-2 rounded-full ${STATUS_DOT[r.status] ?? 'bg-muted-foreground'}`} aria-hidden="true" />
                      {STATUS_LABEL[r.status] ?? r.status}
                    </span>
                  </td>
                  <td className="p-3 text-foreground">{r.ratingOverall !== null ? `${r.ratingOverall}/5` : '—'}</td>
                  <td className="p-3 text-muted-foreground">{new Date(r.sentAt).toLocaleDateString()}</td>
                  <td className="p-3 text-muted-foreground">{r.respondedAt ? new Date(r.respondedAt).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
