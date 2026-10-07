// /coding/service-codes (SP6 Task 14, CODING_ROLES): map service-catalogue procedures, packages and
// investigations to procedure codes. SP4 charge capture checks a charge's procedure codes against
// this map when a service has one (ruling 15). Lists services whose category can carry codes,
// searchable by code or name. Not audited: no patient data; each save is audited by the query.
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CODING_ROLES } from '@/lib/role-policy'
import { MAPPABLE_CATEGORY_LABEL, SERVICE_CODE_KINDS_BY_CATEGORY } from '@/lib/coding/service-codes'
import { DEFAULT_TIMEZONE, todayIsoIn } from '@/lib/india-time'
import { SERVICE_LIST_LIMIT, listMappableServices, listServiceProcedureCodes } from '@/lib/queries/service-procedure-codes'
import { ServiceCodeEditor, type ServiceView } from '@/components/coding/ServiceCodeEditor'

export default async function ServiceCodesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSessionOrRedirect()
  if (!CODING_ROLES.includes(session.role)) redirect('/')

  const raw = (await searchParams).q
  const q = (Array.isArray(raw) ? raw[0] ?? '' : raw ?? '').trim().slice(0, 60)
  const services = await listMappableServices(q)
  const codes = await listServiceProcedureCodes(services.map((s) => s.id))
  const todayIso = todayIsoIn(DEFAULT_TIMEZONE)

  // Only the listed view fields reach the client.
  const views: ServiceView[] = services.map((s) => ({
    id: s.id,
    code: s.code,
    name: s.name,
    categoryLabel: MAPPABLE_CATEGORY_LABEL[s.category] ?? s.category,
    isActive: s.isActive,
    kinds: SERVICE_CODE_KINDS_BY_CATEGORY[s.category] ?? [],
    codes: (codes.get(s.id) ?? []).map((c) => ({ kind: c.kind, code: c.code, isPrimary: c.isPrimary, display: c.display, isSample: c.isSample })),
  }))

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Service codes</h1>
          <p className="text-sm text-muted-foreground">
            Procedure and package codes for each billable procedure, package and investigation. A service with no codes is not checked at charge capture.
          </p>
        </div>
        <Link href="/coding" className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted">Back to worklist</Link>
      </div>

      <form method="get" role="search" className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-64 flex-col gap-1 text-xs font-medium">
          Search services by code or name
          <input type="search" name="q" defaultValue={q} maxLength={60} className="h-9 rounded-lg border border-input bg-background px-2 text-sm" />
        </label>
        <button type="submit" className="h-9 rounded-lg border border-border px-3 text-sm hover:bg-muted">Search</button>
      </form>

      {views.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {q ? 'No procedure, package or investigation services match that search.' : 'No procedure, package or investigation services in the catalogue yet.'}
        </p>
      ) : (
        <>
          {views.length === SERVICE_LIST_LIMIT && (
            <p role="status" className="text-sm text-muted-foreground">{`Showing the first ${SERVICE_LIST_LIMIT} services; search to narrow the list.`}</p>
          )}
          <div className="space-y-3">
            {views.map((s) => <ServiceCodeEditor key={s.id} service={s} todayIso={todayIso} canEdit />)}
          </div>
        </>
      )}
    </div>
  )
}
