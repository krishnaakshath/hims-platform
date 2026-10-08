// Wave I (P1-23): the shared body of every /reports/hospital/* page. Session,
// then the report's own role gate (redirect('/') before any read), then the
// IST range, the query and a view audit row.
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { todayIsoIn } from '@/lib/india-time'
import { hospitalReport, type HospitalReportKey } from '@/lib/reports/catalog'
import { parseReportRange, resolveReportRange } from '@/lib/reports/range'
import { HOSPITAL_REPORT_QUERIES } from '@/lib/queries/hospital-reports'
import { HospitalReportView } from '@/components/reports/HospitalReportView'

type SearchParams = Promise<Record<string, string | string[] | undefined>>

export async function hospitalReportPage(key: HospitalReportKey, searchParams: SearchParams) {
  const session = await requireSessionOrRedirect()
  const def = hospitalReport(key)
  if (!def || !def.roles.includes(session.role)) redirect('/')

  const sp = await searchParams
  const today = todayIsoIn()
  let resolved: ReturnType<typeof resolveReportRange>
  if (def.dates === 'asOf') {
    // A single date: the range's `to`, defaulting to today.
    const on = Array.isArray(sp.to) ? sp.to[0] : sp.to
    const parsed = on === undefined ? null : parseReportRange(on, on)
    resolved = parsed === null ? { range: { from: today, to: today }, problem: null }
      : parsed.ok ? { range: parsed.range, problem: null } : { range: { from: today, to: today }, problem: parsed.error }
  } else {
    resolved = resolveReportRange(sp, today)
  }

  const result = await HOSPITAL_REPORT_QUERIES[def.key](resolved.range)
  await logAudit(session, `viewed report: ${def.label}`, null, `from=${resolved.range.from}&to=${resolved.range.to}`)
  return <HospitalReportView def={def} range={resolved.range} problem={resolved.problem} result={result} />
}
