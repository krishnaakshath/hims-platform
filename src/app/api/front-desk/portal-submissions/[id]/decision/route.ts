// WS7 T9 (spec D15): a reviewer approves or rejects a portal self-service submission.
// - policy approve: { decision: 'approve', insurerPayerId, tpaPayerId? } -> the real policy (createPolicy)
// - ABHA approve:   { decision: 'approve' } -> recorded on the chart, not verified with ABDM
// - reject:         { decision: 'reject', reason } -> the patient sees the reason
// The gate runs before the body is read. An ABHA already on another chart is a 409.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { readJsonBody } from '@/lib/http'
import { PORTAL_SUBMISSION_REVIEW_ROLES } from '@/lib/role-policy'
import { decidePortalSubmission } from '@/lib/queries/portal-submissions'
import { invalidateCache, invalidateCacheByPrefix, patientDetailCacheKey, patientListCacheKey, patientListCachePrefix, workbookListCacheKey, documentsListCacheKey } from '@/lib/cache'

const payerId = z.number().int().positive().max(2_147_483_647)
const schema = z.union([
  z.object({ decision: z.literal('approve'), insurerPayerId: payerId, tpaPayerId: payerId.nullable().optional() }).strict(),
  z.object({ decision: z.literal('approve') }).strict(),
  z.object({ decision: z.literal('reject'), reason: z.string().trim().min(5).max(300) }).strict(),
])

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!PORTAL_SUBMISSION_REVIEW_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id: raw } = await params
  const id = /^\d{1,10}$/.test(raw) ? Number(raw) : NaN
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) return NextResponse.json({ error: 'Submission not found' }, { status: 404 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = schema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid decision: approve, or reject with a reason of 5 to 300 characters' }, { status: 400 })

  try {
    const result = await decidePortalSubmission(id, parsed.data, session)
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: result.status })
    try {
      await invalidateCache(patientDetailCacheKey(result.patientId))
      await invalidateCache(patientListCacheKey(null))
      await invalidateCacheByPrefix(patientListCachePrefix())
      await invalidateCache(workbookListCacheKey())
      await invalidateCache(documentsListCacheKey())
    } catch (err) {
      console.error(`[portal-submissions] cache invalidation failed (${err instanceof Error ? err.name : typeof err})`)
    }
    return NextResponse.json(result.policyId === undefined ? { ok: true } : { ok: true, policyId: result.policyId })
  } catch (err) {
    // Never log the error itself (drizzle messages carry the query params).
    console.error(`[portal-submissions] decision failed (${err instanceof Error ? err.name : 'unknown'})`)
    return NextResponse.json({ error: 'Could not record the decision. Please try again.' }, { status: 500 })
  }
}
