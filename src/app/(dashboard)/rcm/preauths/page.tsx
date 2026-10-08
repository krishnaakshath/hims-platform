// /rcm/preauths: pre-authorisations (RCM_ROLES), 50 per page, with a decision-overdue badge.
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { RCM_ROLES } from '@/lib/role-policy'
import { formatPaise } from '@/lib/format'
import { formatIsoDate } from '@/lib/india-time'
import { PREAUTH_STATUSES, PREAUTH_STATUS_LABEL, type PreauthStatus } from '@/lib/rcm/preauth-status'
import { listPreauths } from '@/lib/queries/preauths'

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function PreauthsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSessionOrRedirect()
  if (!RCM_ROLES.includes(session.role)) redirect('/')

  const sp = await searchParams
  const statusRaw = one(sp.status)
  const status = (PREAUTH_STATUSES as readonly string[]).includes(statusRaw ?? '') ? (statusRaw as PreauthStatus) : undefined
  const q = (one(sp.q) ?? '').slice(0, 40)
  const page = /^\d{1,4}$/.test(one(sp.page) ?? '') ? Math.max(1, Number(one(sp.page))) : 1
  const { rows, total } = await listPreauths({ status, q: q || undefined, page })
  await logAudit(session, 'rcm: viewed pre-authorisation list', null)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold text-foreground">Pre-authorisations</h1>
        <Link href="/rcm/preauths/new" className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground">New pre-authorisation</Link>
      </div>
      <form className="flex flex-wrap gap-2" action="/rcm/preauths">
        <select name="status" defaultValue={status ?? ''} className="rounded-md border border-border bg-background px-2 py-1.5 text-sm">
          <option value="">Any status</option>{PREAUTH_STATUSES.map((s) => <option key={s} value={s}>{PREAUTH_STATUS_LABEL[s]}</option>)}
        </select>
        <input name="q" defaultValue={q} placeholder="PA number, patient or UHID" className="w-64 rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
        <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">Filter</button>
      </form>
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">No pre-authorisations.</p> : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr><th className="px-3 py-2">Number</th><th className="px-3 py-2">Patient</th><th className="px-3 py-2">Insurer</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Requested</th><th className="px-3 py-2 text-right">Approved</th><th className="px-3 py-2">Valid until</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2"><Link href={`/rcm/preauths/${r.id}`} className="font-medium text-primary hover:underline">{r.preauthNumber}</Link></td>
                  <td className="px-3 py-2">{r.patientName}<div className="text-xs text-muted-foreground">{r.uhid ?? '—'}</div></td>
                  <td className="px-3 py-2">{r.insurerName}</td>
                  <td className="px-3 py-2">{PREAUTH_STATUS_LABEL[r.status]}{r.decisionOverdue && <span className="ml-1 rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-700">Decision overdue</span>}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPaise(r.requestedPaise)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.approvedPaise === null ? '—' : formatPaise(r.approvedPaise)}</td>
                  <td className="px-3 py-2">{r.validUntil ? formatIsoDate(r.validUntil) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-sm text-muted-foreground">Showing {total === 0 ? 0 : (page - 1) * 50 + 1}–{Math.min(total, page * 50)} of {total}</p>
    </div>
  )
}
