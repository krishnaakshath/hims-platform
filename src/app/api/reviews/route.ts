import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { reviews, formSubmissions } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listReviews, invalidateReviewsList } from '@/lib/queries/reviews'

const sendSurveySchema = z.object({ formSubmissionId: z.number().int().positive() }).strict()

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  // LeftNav.tsx:63 — { href: '/experience-surveys', roles: ['admin', 'crc'] }
  if (!['admin', 'crc'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const url = new URL(request.url)
  const statusParam = url.searchParams.get('status')
  const filters = {
    // `?:` result inferred as an object-literal property widens the narrowed
    // literal union back to `string` -- cast to keep the runtime check but
    // match ReviewFilters['status'], same pattern as
    // src/app/api/form-submissions/route.ts.
    status: (statusParam === 'sent' || statusParam === 'completed' ? statusParam : undefined) as 'sent' | 'completed' | undefined,
    dateFrom: url.searchParams.get('dateFrom') ?? undefined,
    dateTo: url.searchParams.get('dateTo') ?? undefined,
    sortBy: url.searchParams.get('sortBy') === 'ratingOverall' ? ('ratingOverall' as const) : ('sentAt' as const),
    sortDir: url.searchParams.get('sortDir') === 'asc' ? ('asc' as const) : ('desc' as const),
  }
  await logAudit(session, 'viewed experience surveys list', null)
  return NextResponse.json(await listReviews(filters))
}

// Sends a (simulated) survey invite to a patient — LeftNav.tsx:63 —
// { href: '/experience-surveys', roles: ['admin', 'crc'] }
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = sendSurveySchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid send-survey payload', details: parsed.error.flatten() }, { status: 400 })

  const [submission] = await getDb().select().from(formSubmissions).where(eq(formSubmissions.id, parsed.data.formSubmissionId))
  if (!submission) return NextResponse.json({ error: 'Form submission not found' }, { status: 404 })
  if (submission.status !== 'completed') return NextResponse.json({ error: 'Can only survey a completed intake submission' }, { status: 400 })

  const [existing] = await getDb().select().from(reviews).where(eq(reviews.formSubmissionId, parsed.data.formSubmissionId))
  if (existing) return NextResponse.json({ error: 'A survey has already been sent for this submission' }, { status: 409 })

  const [created] = await getDb()
    .insert(reviews)
    .values({ patientId: submission.patientId, formSubmissionId: submission.id, sentBy: session.name })
    .returning()

  await invalidateReviewsList()
  await logAudit(session, 'sent pre-screening experience survey', submission.patientId)
  return NextResponse.json(created, { status: 201 })
}
