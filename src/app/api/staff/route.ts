import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { listStaffMembers, createStaffMember } from '@/lib/queries/staff-members'

const createStaffSchema = z.object({
  userId: z.number().int().nullable().optional(),
  providerId: z.number().int().nullable().optional(),
  name: z.string().trim().min(1),
  department: z.string().trim().min(1),
  title: z.string().trim().min(1),
  employmentStatus: z.enum(['active', 'on_leave', 'terminated']).optional(),
  hireDate: z.string().min(1),
  terminationDate: z.string().nullable().optional(),
}).strict()

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  await logAudit(session, 'viewed staff directory', null)
  return NextResponse.json(await listStaffMembers())
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const parsed = createStaffSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  const result = await createStaffMember({
    userId: parsed.data.userId ?? null,
    providerId: parsed.data.providerId ?? null,
    name: parsed.data.name,
    department: parsed.data.department,
    title: parsed.data.title,
    employmentStatus: parsed.data.employmentStatus,
    hireDate: parsed.data.hireDate,
    terminationDate: parsed.data.terminationDate ?? null,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })

  await logAudit(session, 'added a staff member', null)
  return NextResponse.json(result.staffMember, { status: 201 })
}
