import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'
import { stopPrescription } from '@/lib/queries/prescriptions'

const stopPrescriptionSchema = z.object({
  stopDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict()

// This is the only mutation offered on a written prescription -- there is
// no edit-the-drug-or-dose path, because changing a written prescription in
// place would rewrite a record another party may already be holding on
// paper; the correct action is to stop it and write a new one.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ anonId: string; id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'pi'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId, id } = await params

  // Every field is optional and the Stop button sends no body at all, so a
  // bare `request.json()` would throw on an empty payload.
  const body = await request.json().catch(() => ({}))
  const parsed = stopPrescriptionSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid stop-prescription payload', details: parsed.error.flatten() }, { status: 400 })

  // An unparseable id addresses no row, so it's a 404, not a 400.
  const episodeId = Number(id)
  if (!Number.isFinite(episodeId) || episodeId <= 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const stopDate = parsed.data.stopDate ?? new Date().toISOString().slice(0, 10)

  const result = await stopPrescription(anonId, episodeId, stopDate)
  if (!result.ok) {
    if (result.reason === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ error: 'This prescription has already been stopped.' }, { status: 409 })
  }

  await invalidateCache(patientDetailCacheKey(anonId))
  await logAudit(session, `stopped prescription ${episodeId}`, anonId)
  return NextResponse.json(result.episode, { status: 200 })
}
