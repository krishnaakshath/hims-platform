import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { TARIFF_MANAGE_ROLES } from '@/lib/role-policy'
import { getService, packageItemsProblem, replacePackageItems, type ServiceRow } from '@/lib/queries/tariff'
import { packageItemsSchema } from '@/lib/tariff/validation'
import { pgErrorCode } from '@/lib/db-errors'
import { badRequest, forbidden, invalid, notFound, parseId, serverError } from '@/lib/tariff/route-responses'

// Replace a package's whole item list (no nesting, no self-reference, active items only).
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!TARIFF_MANAGE_ROLES.includes(session.role)) return forbidden()

  const body = await request.json().catch(() => null)
  const parsed = packageItemsSchema.safeParse(body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid package items')

  const id = parseId((await params).id)
  if (id === null) return badRequest('Invalid package id')
  const { items } = parsed.data

  try {
    const pkg = await getService(id)
    if (!pkg) return notFound('Package not found')
    // At most 100 distinct ids (schema), so one lookup each is bounded.
    const found = await Promise.all(items.map((it) => getService(it.serviceId)))
    const servicesById = new Map<number, ServiceRow>(found.filter((s): s is ServiceRow => s !== null).map((s) => [s.id, s]))
    const problem = packageItemsProblem(pkg, items, servicesById)
    if (problem) return badRequest(problem)

    await replacePackageItems(id, items, { session, action: `tariff: updated package items for ${pkg.code}` })
    return NextResponse.json({ packageServiceId: id, items })
  } catch (err) {
    if (pgErrorCode(err) === '23503') return badRequest('Unknown service in package')
    return serverError('replace package items', err, 'Could not update the package items')
  }
}
