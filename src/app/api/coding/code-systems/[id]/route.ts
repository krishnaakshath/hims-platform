// PATCH /api/coding/code-systems/[id] `{ isCurrent: true }`: make this version the kind's current
// one (admin only). The query serialises on the kind's advisory lock and audits inside its
// transaction; a sample never replaces a licensed set (ruling 1).
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { CODE_SYSTEM_ADMIN_ROLES } from '@/lib/role-policy'
import { readJsonBody } from '@/lib/follow-ups/route-responses'
import { parseId } from '@/lib/tariff/route-responses'
import { RETRY_MESSAGE, isRetryableConflict, pgConstraint, pgErrorCode } from '@/lib/db-errors'
import { setCurrentCodeSystem } from '@/lib/queries/code-systems'

const setCurrentSchema = z.object({ isCurrent: z.literal(true) }).strict()
const json = (status: number, error: string) => NextResponse.json({ error }, { status })

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CODE_SYSTEM_ADMIN_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const read = await readJsonBody(request)
  if (!read.ok) return read.response
  if (!setCurrentSchema.safeParse(read.body).success) return json(400, 'Invalid request')
  const id = parseId((await params).id)
  if (id === null) return json(400, 'Invalid code system id')

  try {
    const r = await setCurrentCodeSystem(id, session)
    if (r === 'not_found') return json(404, 'Code system not found')
    if (r === 'sample_over_licensed') return json(409, 'A sample code set cannot replace a licensed one')
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (isRetryableConflict(err)) return json(409, RETRY_MESSAGE)
    console.error(`[coding] set current code system failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
    return json(500, 'Could not change the current version')
  }
}
