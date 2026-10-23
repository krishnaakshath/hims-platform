import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { RETRY_MESSAGE, isRetryableConflict, pgErrorCode } from '@/lib/db-errors'
import { parseId, readJsonBody } from '@/lib/http'
import { setRoomGenderRestriction } from '@/lib/queries/rooms'
import { MASTER_DATA_ADMIN_ROLES } from '@/lib/role-policy'

// WS3 T4: a bed's ward-gender restriction (spec 3.1 item 10). null = mixed ward. Fixed messages.
const schema = z.object({ genderRestriction: z.enum(['male', 'female']).nullable() }).strict()

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!MASTER_DATA_ADMIN_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const roomId = parseId(id)
  if (roomId === null) return NextResponse.json({ error: 'Invalid room id' }, { status: 400 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = schema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })
  const { genderRestriction } = parsed.data

  try {
    const result = await setRoomGenderRestriction(roomId, genderRestriction)
    if (!result.ok) {
      if (result.error === 'room_not_found') return NextResponse.json({ error: 'Bed not found', code: 'room_not_found' }, { status: 404 })
      return NextResponse.json({
        error: 'The patient in this bed would not match that restriction. Transfer them first, or choose another setting.',
        code: 'room_occupied_conflict',
      }, { status: 409 })
    }
    await logAudit(session, 'changed bed gender restriction', null, `room=${roomId}`)
    return NextResponse.json({ ok: true, genderRestriction })
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    console.error(`[room gender] failed (${err instanceof Error ? err.constructor.name : 'unknown'}, code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not change the bed setting' }, { status: 500 })
  }
}
