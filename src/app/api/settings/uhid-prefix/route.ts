import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { MASTER_DATA_ADMIN_ROLES } from '@/lib/role-policy'
import { isValidUhidPrefix } from '@/lib/uhid'
import { setUhidPrefix } from '@/lib/queries/uhid'

const schema = z.object({ prefix: z.string().refine(isValidUhidPrefix, 'Invalid prefix') }).strict()

export async function PUT(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!MASTER_DATA_ADMIN_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await request.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  await setUhidPrefix(parsed.data.prefix)
  await logAudit(session, 'changed UHID prefix', null)
  return NextResponse.json({ ok: true, prefix: parsed.data.prefix })
}
