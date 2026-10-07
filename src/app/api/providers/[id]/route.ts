import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { MASTER_DATA_ADMIN_ROLES } from '@/lib/role-policy'
import { getProviderById, updateProviderProfile } from '@/lib/queries/providers'
import { getDepartmentById } from '@/lib/queries/departments'
import { providerProfileSchema } from '@/lib/validation/provider-profile'
import { formatPaise } from '@/lib/money'
import { isUniqueViolation, pgConstraint, pgErrorCode } from '@/lib/db-errors'

const feeText = (paise: number | null | undefined) => (paise == null ? 'none' : formatPaise(paise))

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!MASTER_DATA_ADMIN_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const providerId = Number(id)
  if (!Number.isInteger(providerId)) return NextResponse.json({ error: 'Invalid provider id' }, { status: 400 })

  const body = await request.json().catch(() => null)
  const parsed = providerProfileSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  try {
    if (parsed.data.departmentId != null) {
      const dept = await getDepartmentById(parsed.data.departmentId)
      if (!dept) return NextResponse.json({ error: 'Unknown department' }, { status: 400 })
      if (!dept.isActive) return NextResponse.json({ error: 'Department is inactive' }, { status: 400 })
    }
    const existing = await getProviderById(providerId)
    if (!existing) return NextResponse.json({ error: 'Provider not found' }, { status: 404 })

    // A state change without a council in the payload is judged against the stored council.
    if (parsed.data.registrationCouncil === undefined && parsed.data.registrationStateCode !== undefined) {
      const stateGivenOk = parsed.data.registrationStateCode !== null
      if (existing.registrationCouncil !== 'smc' ? stateGivenOk : !stateGivenOk) {
        return NextResponse.json({ error: 'A state applies only to a State Medical Council, which requires one' }, { status: 400 })
      }
    }

    const updated = await updateProviderProfile(providerId, parsed.data)
    if (!updated) return NextResponse.json({ error: 'Provider not found' }, { status: 404 })

    await logAudit(session, 'updated provider profile', null)
    const newFee = parsed.data.consultationFeePaise
    if (newFee !== undefined && (newFee ?? null) !== (existing.consultationFeePaise ?? null)) {
      await logAudit(session, 'changed provider consultation fee', null, `${feeText(existing.consultationFeePaise)} → ${feeText(newFee)}`)
    }
    return NextResponse.json(updated)
  } catch (err) {
    if (isUniqueViolation(err)) return NextResponse.json({ error: 'Conflicts with an existing provider' }, { status: 409 })
    console.error(`[providers] update failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
    return NextResponse.json({ error: 'Could not update provider' }, { status: 500 })
  }
}
