import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getReview } from '@/lib/queries/reviews'
import { RecordSurveyResponseForm } from '@/components/RecordSurveyResponseForm'
import { BackLink } from '@/components/BackLink'

const SECTION = 'rounded-md border border-border bg-card p-5 shadow-none'

export default async function ExperienceSurveyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionOrRedirect()
  // LeftNav.tsx:63 — { href: '/experience-surveys', roles: ['admin', 'crc'] }.
  // Must precede notFound() below, not follow it.
  if (!['admin', 'crc'].includes(session.role)) redirect('/')
  const { id } = await params
  const review = await getReview(Number(id))
  if (!review) notFound()
  await logAudit(session, `viewed pre-screening experience survey ${id}`, review.patientId)

  return (
    <div className="max-w-xl space-y-4">
      <BackLink href="/experience-surveys" label="Back to Experience Surveys" />
      <div className={SECTION}>
        <h1 className="text-xl font-bold text-foreground">{review.patientName}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{review.templateName} · Sent {new Date(review.sentAt).toLocaleDateString()}</p>
      </div>

      {review.status === 'completed' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className={`${SECTION} text-center`}>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Overall</p>
              <p className="mt-1 text-2xl font-bold text-foreground">{review.ratingOverall}/5</p>
            </div>
            <div className={`${SECTION} text-center`}>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Forms Clarity</p>
              <p className="mt-1 text-2xl font-bold text-foreground">{review.ratingFormsClarity}/5</p>
            </div>
            <div className={`${SECTION} text-center`}>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Communication</p>
              <p className="mt-1 text-2xl font-bold text-foreground">{review.ratingCommunication}/5</p>
            </div>
          </div>
          {review.comments && (
            <div className={SECTION}>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Comments</p>
              <p className="mt-1 text-sm text-foreground">{review.comments}</p>
            </div>
          )}
          <p className="text-xs text-muted-foreground">Responded {new Date(review.respondedAt!).toLocaleDateString()}</p>
        </div>
      ) : (
        <div className={SECTION}>
          <RecordSurveyResponseForm reviewId={review.id} />
        </div>
      )}
    </div>
  )
}
