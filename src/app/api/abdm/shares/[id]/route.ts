import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { invalidIdResponse, parseId, readJsonBody } from '@/lib/http'
import { ABDM_SHARE_QUEUE_ROLES } from '@/lib/role-policy'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'
import { getSharePrefill, resolveShare } from '@/lib/queries/abdm-profile-shares'

// The Scan & Share registration queue (ABDM_SHARE_QUEUE_ROLES). GET: the
// registration prefill of one pending share. POST: register (after the
// patient was created from it), link to an existing patient, or dismiss.

const resolveSchema = z.object({
  action: z.enum(['registered', 'linked', 'dismissed']),
  patientId: z.string().trim().min(1).max(40).optional(),
}).strict()

const ERROR: Record<string, [number, string]> = {
  not_found: [404, 'Not found'],
  already_resolved: [409, 'This share was already handled'],
  patient_required: [400, 'Choose the patient'],
  abha_conflict: [409, 'This ABHA is already linked to another patient'],
  abha_missing: [400, 'This share has no ABHA number to link'],
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ABDM_SHARE_QUEUE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const id = parseId((await params).id)
  if (id === null) return invalidIdResponse()
  const prefill = await getSharePrefill(id)
  if (!prefill) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(prefill)
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ABDM_SHARE_QUEUE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const id = parseId((await params).id)
  if (id === null) return invalidIdResponse()

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = resolveSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  const r = await resolveShare(id, parsed.data, session)
  if (!r.ok) {
    const [status, error] = ERROR[r.error]
    return NextResponse.json({ error }, { status })
  }
  if (parsed.data.patientId) {
    try {
      await invalidateCache(patientDetailCacheKey(parsed.data.patientId))
    } catch {
      // The detail cache expires on its own.
    }
  }
  return NextResponse.json({ ok: true })
}
