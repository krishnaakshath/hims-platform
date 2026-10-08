import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { RCM_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { toCsv } from '@/lib/rcm/csv'
import { claimRegisterRows, rangeProblem } from '@/lib/queries/rcm-reports'
import { rcmError, rcmServerError } from '@/lib/rcm/route-responses'

// SP7: the claim register as CSV (formula-safe; no policy, member, UTR, diagnosis or identity numbers).
export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!RCM_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const from = request.nextUrl.searchParams.get('from') ?? ''
  const to = request.nextUrl.searchParams.get('to') ?? ''
  const problem = rangeProblem(from, to)
  if (problem) return rcmError(400, problem)
  try {
    const rows = await claimRegisterRows({ from, to })
    await logAudit(session, 'rcm: exported claim register', null, `from=${from} to=${to} rows=${rows.length - 1}`)
    return new NextResponse(toCsv(rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="claim-register-${from}-to-${to}.csv"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    return rcmServerError('claim register', err, 'Could not export the claim register')
  }
}
