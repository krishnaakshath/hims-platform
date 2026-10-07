import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { MASTER_DATA_ADMIN_ROLES } from '@/lib/role-policy'
import { updateDepartment } from '@/lib/queries/departments'
import { pgConstraint, pgErrorCode } from '@/lib/db-errors'

// `code` is immutable: .strict() rejects it.
const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(['clinical', 'diagnostic', 'support', 'administrative']).optional(),
  isActive: z.boolean().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, 'At least one field is required')

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!MASTER_DATA_ADMIN_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await request.json().catch(() => null)
  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  const { id } = await params
  const deptId = Number(id)
  if (!Number.isInteger(deptId)) return NextResponse.json({ error: 'Invalid department id' }, { status: 400 })

  try {
    const row = await updateDepartment(deptId, parsed.data)
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const deactivated = parsed.data.isActive === false
    await logAudit(session, `${deactivated ? 'deactivated' : 'updated'} department ${row.code}`, null)
    return NextResponse.json(row)
  } catch (err) {
    console.error(`[departments] update failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
    return NextResponse.json({ error: 'Could not update department' }, { status: 500 })
  }
}
