import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { getStaffMemberDetail, updateStaffMember } from '@/lib/queries/staff-members'

// Fix B: matches this module's existing admin-only write gate (see POST
// /api/staff, POST /api/staff/[id]/credentials). Scoped to the fields a real
// HR change would touch -- not name/hireDate/userId/providerId, which are
// treated as set-at-creation elsewhere in this module.
const updateStaffSchema = z.object({
  employmentStatus: z.enum(['active', 'on_leave', 'terminated']).optional(),
  terminationDate: z.string().nullable().optional(),
  department: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
}).strict()

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const staffId = Number(id)
  if (!Number.isInteger(staffId)) return NextResponse.json({ error: 'Invalid staff id' }, { status: 400 })

  const detail = await getStaffMemberDetail(staffId)
  if (!detail) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await logAudit(session, 'viewed staff member detail', null)
  return NextResponse.json(detail)
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const { id } = await params
  const staffId = Number(id)
  if (!Number.isInteger(staffId)) return NextResponse.json({ error: 'Invalid staff id' }, { status: 400 })

  const parsed = updateStaffSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  const result = await updateStaffMember(staffId, parsed.data)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 })

  await logAudit(session, 'updated a staff member', null)
  return NextResponse.json(result.staffMember)
}
