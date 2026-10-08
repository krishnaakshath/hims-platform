import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { ENCOUNTER_REGISTER_EXPORT_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { todayIsoIn } from '@/lib/india-time'
import { encounterRegisterCsv, parseRegisterFilters, registerQueryString } from '@/lib/encounters/register'
import { listEncounterRegister } from '@/lib/queries/encounter-register'

// Wave F P1-04: CSV export of the OPD register. ENCOUNTER_REGISTER_EXPORT_ROLES
// (admin, crc) only -- narrower than the /encounters page -- gated before the
// query string is read. Same filters as the page; every export is audited
// with its filters and row count. The CSV is the register's minimal
// projection: no phone, address, ABHA or national ID.
export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ENCOUNTER_REGISTER_EXPORT_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = parseRegisterFilters(Object.fromEntries(request.nextUrl.searchParams), todayIsoIn())
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const f = parsed.filters

  const register = await listEncounterRegister(f)
  await logAudit(session, 'exported OPD register', null, `${registerQueryString(f)}&rows=${register.rows.length}${register.truncated ? '&truncated=1' : ''}`)

  // A UTF-8 BOM so spreadsheet apps read names in Indian scripts correctly.
  return new NextResponse(`\uFEFF${encounterRegisterCsv(register.rows)}\r\n`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="opd-register-${f.from}-to-${f.to}.csv"`,
      'Cache-Control': 'no-store',
      ...(register.truncated ? { 'X-Register-Truncated': '1' } : {}),
    },
  })
}
