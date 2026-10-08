// Wave I (P1-23): a hospital report page body -- dates form, CSV export link and
// one table per section. Server component; money in INR, dates in IST.
import type { HospitalReportDef } from '@/lib/reports/catalog'
import type { ReportRange } from '@/lib/reports/range'
import { cellText, type ReportResult, type ReportSection } from '@/lib/reports/table'
import { formatIsoDate } from '@/lib/india-time'

const wrap = 'overflow-x-auto rounded-lg border border-border bg-card'
const isNumeric = (kind: string) => kind !== 'text' && kind !== 'date' && kind !== 'datetime'

function SectionTable({ section }: { section: ReportSection }) {
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold text-foreground">{section.title}</h2>
      {section.note && <p className="text-xs text-amber-700">{section.note}</p>}
      {section.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{section.empty}</p>
      ) : (
        <div className={wrap}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>{section.columns.map((c) => <th key={c.label} scope="col" className={`px-3 py-2 ${isNumeric(c.kind) ? 'text-right' : ''}`}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {section.rows.map((row, i) => (
                <tr key={i} className="border-t border-border">
                  {row.map((v, j) => <td key={j} className={`px-3 py-2 ${isNumeric(section.columns[j].kind) ? 'text-right tabular-nums' : ''}`}>{cellText(section.columns[j].kind, v)}</td>)}
                </tr>
              ))}
            </tbody>
            {section.totals && (
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  {section.totals.map((v, j) => <td key={j} className={`px-3 py-2 ${j > 0 && isNumeric(section.columns[j].kind) ? 'text-right tabular-nums' : ''}`}>{j === 0 ? String(v ?? '') : cellText(section.columns[j].kind, v)}</td>)}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </section>
  )
}

export function HospitalReportView({ def, range, problem, result }: { def: HospitalReportDef; range: ReportRange; problem: string | null; result: ReportResult }) {
  const csvHref = `/api/reports/${def.key}/csv?from=${range.from}&to=${range.to}`
  const asOf = def.dates === 'asOf'
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{def.label}</h1>
          <p className="text-sm text-muted-foreground">
            {asOf ? `As of ${formatIsoDate(range.to)} (IST).` : `${formatIsoDate(range.from)} to ${formatIsoDate(range.to)} (IST).`}
          </p>
          {problem && <p role="alert" className="text-xs text-amber-700">{problem}; showing {asOf ? 'today' : 'this month'}.</p>}
        </div>
        <form className="flex flex-wrap items-end gap-2 text-sm" action={def.href}>
          {asOf ? (
            <>
              <label className="text-xs">As of<input type="date" name="to" defaultValue={range.to} className="block rounded-md border border-border bg-background px-2 py-1" /></label>
            </>
          ) : (
            <>
              <label className="text-xs">From<input type="date" name="from" defaultValue={range.from} className="block rounded-md border border-border bg-background px-2 py-1" /></label>
              <label className="text-xs">To<input type="date" name="to" defaultValue={range.to} className="block rounded-md border border-border bg-background px-2 py-1" /></label>
            </>
          )}
          <button type="submit" className="rounded-md border border-border px-3 py-1.5 hover:bg-muted">Show</button>
          <a href={csvHref} className="rounded-md bg-primary px-3 py-1.5 font-semibold text-primary-foreground">Download CSV</a>
        </form>
      </div>
      {result.note && <p className="text-xs text-muted-foreground">{result.note}</p>}
      {result.sections.map((s) => <SectionTable key={s.title} section={s} />)}
    </div>
  )
}
