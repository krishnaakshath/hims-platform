import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { TARIFF_LOOKUP_ROLES, TARIFF_MANAGE_ROLES } from '@/lib/role-policy'
import { createService, listServices } from '@/lib/queries/tariff'
import { getDepartmentById } from '@/lib/queries/departments'
import { SERVICE_CATEGORIES, serviceCreateSchema, type ServiceCategory } from '@/lib/tariff/validation'
import { isUniqueViolation } from '@/lib/db-errors'
import { badRequest, conflict, forbidden, invalid, parseId, serverError } from '@/lib/tariff/route-responses'

const CATEGORY_CODES = SERVICE_CATEGORIES.map((c) => c.code) as [ServiceCategory, ...ServiceCategory[]]

// URLSearchParams values are strings; unknown params are rejected (.strict()).
const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  // Plain positive int4 digits only (same rule as /api/tariff/resolve): z.coerce alone accepts
  // '0x10', '1e3' and values beyond the column range.
  departmentId: z.string().transform((v, ctx) => parseId(v) ?? (ctx.addIssue({ code: 'custom', message: 'Invalid department' }), z.NEVER)).optional(),
  category: z.enum(CATEGORY_CODES).optional(),
  includeInactive: z.enum(['0', '1', 'true', 'false']).optional(),
}).strict()

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!TARIFF_LOOKUP_ROLES.includes(session.role)) return forbidden()

  const parsed = listQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams))
  if (!parsed.success) return badRequest('Invalid service search')
  const { q, departmentId, category } = parsed.data
  // Inactive services are a catalogue-management concern; lookup roles only ever see active ones.
  const wantsInactive = parsed.data.includeInactive === '1' || parsed.data.includeInactive === 'true'
  const includeInactive = wantsInactive && TARIFF_MANAGE_ROLES.includes(session.role)

  try {
    const rows = await listServices({ q, departmentId, category, includeInactive })
    return NextResponse.json({
      services: rows.map((s) => ({
        id: s.id, code: s.code, name: s.name, departmentId: s.departmentId, departmentName: s.departmentName,
        category: s.category, hsnSac: s.hsnSac, gstRateBp: s.gstRateBp, isActive: s.isActive,
      })),
    })
  } catch (err) {
    return serverError('list services', err, 'Could not load services')
  }
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!TARIFF_MANAGE_ROLES.includes(session.role)) return forbidden()

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const body = json.body
  const parsed = serviceCreateSchema.safeParse(body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid service')

  try {
    if (!(await getDepartmentById(parsed.data.departmentId))) return badRequest('Unknown department')
    const row = await createService(parsed.data, { session, action: `tariff: created service ${parsed.data.code}` })
    return NextResponse.json(row, { status: 201 })
  } catch (err) {
    if (isUniqueViolation(err, 'service_catalog_code_unique')) return conflict('Service code already exists')
    return serverError('create service', err, 'Could not create service')
  }
}
