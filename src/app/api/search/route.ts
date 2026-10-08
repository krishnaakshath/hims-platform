import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { hasSearchScope, searchScopesFor, PATIENT_PICKER_PHONE_ROLES, TARIFF_MANAGE_ROLES } from '@/lib/role-policy'
import { searchAll } from '@/lib/queries/search'

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!hasSearchScope(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const q = new URL(request.url).searchParams.get('q') ?? ''
  const role = session.role
  const results = await searchAll(q, searchScopesFor(role), {
    // Wave G: only roles that may see a mobile may find a patient by it.
    matchPhone: PATIENT_PICKER_PHONE_ROLES.includes(role),
    serviceHref: TARIFF_MANAGE_ROLES.includes(role) ? undefined : (id) => `/price-lookup?serviceId=${id}`,
  })
  if (q.trim().length > 0) await logAudit(session, `searched for "${maskDigits(q.slice(0, 200))}"`, null)
  return NextResponse.json(results)
}

// Wave G: a query is often a mobile number (or, by mistake, a national ID number), so
// any run of 5+ digits (the shortest mobile fragment search matches) is masked; a chart id like RD-0001 stays readable before it reaches the audit log.
function maskDigits(q: string): string {
  return q.replace(/\d[\d\s-]{2,}\d/g, (run) => (run.replace(/\D/g, '').length >= 5 ? '[digits]' : run))
}
