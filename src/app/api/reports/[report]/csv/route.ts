import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { hospitalReport } from '@/lib/reports/catalog'
import { parseReportRange } from '@/lib/reports/range'
import { reportCsv } from '@/lib/reports/table'
import { HOSPITAL_REPORT_QUERIES } from '@/lib/queries/hospital-reports'

// Wave I (P1-23): a hospital report as CSV. Gated per report (the catalogue's
// roles, REPORTS_ROLES at most) right after the session check, before the
// range is read; an unknown report is the same 403. Every export is audited
// with its range and row count. Patient columns are UHID and name only (no
// phone, address, Aadhaar or ABHA); amounts are plain rupees, formula-safe.
export async function GET(request: NextRequest, { params }: { params: Promise<{ report: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const def = hospitalReport((await params).report)
  if (!def || !def.roles.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = parseReportRange(request.nextUrl.searchParams.get('from') ?? '', request.nextUrl.searchParams.get('to') ?? '')
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const { range } = parsed

  try {
    const result = await HOSPITAL_REPORT_QUERIES[def.key](range)
    const rowCount = result.sections.reduce((a, s) => a + s.rows.length, 0)
    await logAudit(session, `exported report: ${def.label}`, null, `from=${range.from}&to=${range.to}&rows=${rowCount}`)
    // A UTF-8 BOM so spreadsheet apps read names in Indian scripts correctly.
    return new NextResponse(`﻿${reportCsv(def.label, range, result)}`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${def.key}-${range.from}-to-${range.to}.csv"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    console.error(`[reports] ${def.key} export failed: ${err instanceof Error ? err.name : 'unknown error'}`)
    return NextResponse.json({ error: 'Could not export the report' }, { status: 500 })
  }
}
