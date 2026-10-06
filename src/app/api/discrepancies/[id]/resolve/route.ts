import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/db/client'
import { formChartDiscrepancies } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { resolveDiscrepancy } from '@/lib/queries/discrepancies'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const [existing] = await getDb().select().from(formChartDiscrepancies).where(eq(formChartDiscrepancies.id, Number(id)))
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await resolveDiscrepancy(Number(id), session.name)
  await invalidateCache(patientDetailCacheKey(existing.patientId))
  await logAudit(session, `resolved form-vs-chart discrepancy: ${existing.questionLabel}`, existing.patientId)

  return NextResponse.json({ ok: true })
}
