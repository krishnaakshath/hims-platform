import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { MASTER_DATA_ADMIN_ROLES } from '@/lib/role-policy'
import { isValidUhidPrefix } from '@/lib/uhid'
import { setUhidPrefix } from '@/lib/queries/uhid'
import { pgConstraint, pgErrorCode } from '@/lib/db-errors'

const schema = z.object({ prefix: z.string().refine(isValidUhidPrefix, 'Invalid prefix') }).strict()

export async function PUT(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!MASTER_DATA_ADMIN_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const body = json.body
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  try {
    await setUhidPrefix(parsed.data.prefix)
    await logAudit(session, 'changed UHID prefix', null)
    return NextResponse.json({ ok: true, prefix: parsed.data.prefix })
  } catch (err) {
    console.error(`[settings] uhid prefix update failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
    return NextResponse.json({ error: 'Could not update UHID prefix' }, { status: 500 })
  }
}
