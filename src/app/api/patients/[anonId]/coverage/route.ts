import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import type { CoverageVerificationFacts } from '@/lib/insurance/coverage'
import { getCoverageSummary, type PolicyCoverage } from '@/lib/queries/coverage'
import { rcmError, rcmServerError } from '@/lib/rcm/route-responses'
import { COVERAGE_READ_ROLES } from '@/lib/role-policy'

// WS12 T2: what is known about a patient's insurance cover right now (verdict, current and
// recent verifications, limits). Dates leave as ISO strings; the insurer reference never
// leaves (R6), and verifications carry no document URL (only hasDocument) or NHCX check id here.
const querySchema = z.object({ context: z.enum(['view', 'opd_checkin', 'ipd_admission']).default('view') }).strict()

type PublicVerification = Omit<CoverageVerificationFacts, 'insurerReference'>
const publicVerification = ({ insurerReference: _ref, ...v }: CoverageVerificationFacts): PublicVerification => { void _ref; return v }
const publicCoverage = (c: PolicyCoverage) => ({ ...c, current: c.current ? publicVerification(c.current) : null, history: c.history.map(publicVerification) })

export async function GET(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!COVERAGE_READ_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const query = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams))
  if (!query.success) return rcmError(400, 'Choose a context: view, opd_checkin or ipd_admission')
  const { context } = query.data
  const { anonId } = await params

  try {
    const [patient] = await getDb().select({ id: patients.id }).from(patients).where(eq(patients.id, anonId)).limit(1)
    if (!patient) return rcmError(404, 'Not found')
    const summary = await getCoverageSummary(patient.id, context)
    await logAudit(session, 'insurance: viewed coverage', patient.id, `context=${context}`)
    return NextResponse.json(
      { primary: summary.primary ? publicCoverage(summary.primary) : null, policies: summary.policies.map(publicCoverage) },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    return rcmServerError('view coverage', err, 'Could not load the insurance cover')
  }
}
