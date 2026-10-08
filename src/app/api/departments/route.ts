import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { ALL_ROLES, MASTER_DATA_ADMIN_ROLES } from '@/lib/role-policy'
import { createDepartment, listDepartments, DEPARTMENT_CODE_PATTERN } from '@/lib/queries/departments'
import { isUniqueViolation, pgConstraint, pgErrorCode } from '@/lib/db-errors'

const createSchema = z.object({
  code: z.string().trim().toUpperCase().regex(DEPARTMENT_CODE_PATTERN, 'Invalid department code'),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['clinical', 'diagnostic', 'support', 'administrative']),
}).strict()

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!(ALL_ROLES as readonly string[]).includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const activeOnly = request.nextUrl.searchParams.get('active') === '1'
  return NextResponse.json(await listDepartments({ activeOnly }))
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!MASTER_DATA_ADMIN_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const body = json.body
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  try {
    const row = await createDepartment(parsed.data)
    await logAudit(session, `created department ${row.code}`, null)
    return NextResponse.json(row, { status: 201 })
  } catch (err) {
    if (isUniqueViolation(err, 'departments_code_unique')) {
      return NextResponse.json({ error: 'Department code already exists' }, { status: 409 })
    }
    console.error(`[departments] create failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
    return NextResponse.json({ error: 'Could not create department' }, { status: 500 })
  }
}
