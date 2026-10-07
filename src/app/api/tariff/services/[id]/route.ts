import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { TARIFF_MANAGE_ROLES } from '@/lib/role-policy'
import { TariffPackageIntegrityError, getService, updateService } from '@/lib/queries/tariff'
import { getDepartmentById } from '@/lib/queries/departments'
import { hsnSacProblem, serviceUpdateSchema } from '@/lib/tariff/validation'
import { badRequest, conflict, forbidden, invalid, notFound, parseId, serverError } from '@/lib/tariff/route-responses'

// `code` is immutable: serviceUpdateSchema omits it and is .strict(), so sending it is a 400.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!TARIFF_MANAGE_ROLES.includes(session.role)) return forbidden()

  const body = await request.json().catch(() => null)
  const parsed = serviceUpdateSchema.safeParse(body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid service update')

  const id = parseId((await params).id)
  if (id === null) return badRequest('Invalid service id')
  const patch = parsed.data

  try {
    const current = await getService(id)
    if (!current) return notFound('Service not found')
    // The schema can only cross-check HSN/SAC when both arrive; check a lone change against the stored value.
    if (patch.category !== undefined || patch.hsnSac !== undefined) {
      const problem = hsnSacProblem(patch.category ?? current.category, patch.hsnSac ?? current.hsnSac)
      if (problem) return badRequest(problem)
    }
    if (patch.departmentId !== undefined && !(await getDepartmentById(patch.departmentId))) return badRequest('Unknown department')

    const verb = patch.isActive === false ? 'deactivated' : 'updated'
    const row = await updateService(id, patch, { session, action: `tariff: ${verb} service ${current.code}` })
    if (!row) return notFound('Service not found')
    return NextResponse.json(row)
  } catch (err) {
    if (err instanceof TariffPackageIntegrityError) return conflict(err.message)
    return serverError('update service', err, 'Could not update service')
  }
}
