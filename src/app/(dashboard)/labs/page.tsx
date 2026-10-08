import { redirect } from 'next/navigation'
import { ClipboardList, Beaker, CheckCircle2, Truck, Users, ListChecks, Siren, FileCheck2, Timer } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listWorklist, listPatientsWithLabOrders } from '@/lib/queries/lab-orders'
import { listLabTests } from '@/lib/queries/lab-tests'
import { LabWorklist } from '@/components/LabWorklist'
import { LabsPatientReports } from '@/components/LabsPatientReports'
import { Tabs } from '@/components/Tabs'
import { LAB_WORKLIST_ROLES } from '@/lib/role-policy' // SP5
// Wave E P1-15: tiles drill into the worklist section; day figures from the KPI loader.
import { LAB_STAGE_STATUSES, parseLabStage, type LabStage } from '@/lib/labs/worklist-stage'
import { getLabKpis } from '@/lib/queries/hospital-kpis'
import { KpiTile, formatMinutes } from '@/components/dashboards/KpiTile'

export default async function LabsPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  const session = await requireSessionOrRedirect()
  // Matches GET /api/lab-orders's own role gate (SP5: LAB_WORKLIST_ROLES). frontdesk removed per
  // explicit product direction (registration/check-in only, no lab access).
  if (!LAB_WORKLIST_ROLES.includes(session.role)) redirect('/')

  const stageParam = parseLabStage((await searchParams)?.stage)
  const [orders, labTests, patientRoster, kpis] = await Promise.all([listWorklist(), listLabTests(), listPatientsWithLabOrders(), getLabKpis()])
  await logAudit(session, session.role === 'labs' ? 'viewed labs dashboard' : 'viewed lab worklist', null)

  // Same trimmed-nonempty rule as the FHIR webhook; only the boolean reaches
  // the markup, never the token.
  const lisConfigured = Boolean(process.env.LIS_INTEGRATION_TOKEN?.trim())

  // SP5 + Wave E: one tile per bench stage, counted from the same orders the worklist sections list.
  const inStage = (stage: LabStage) => orders.filter((o) => LAB_STAGE_STATUSES[stage].includes(o.status)).length
  const stage = stageParam === 'all' ? null : stageParam

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{session.role === 'labs' ? `Hello, ${session.name}!` : 'Labs'}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Manage internal collections and external reference lab results.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex flex-col items-end">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">LIS Integration</span>
            {lisConfigured ? (
              <span className="flex items-center gap-1.5 text-xs text-success">
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" aria-hidden="true"></span>
                Webhook ready
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="relative inline-flex h-2 w-2 rounded-full bg-muted-foreground/50" aria-hidden="true"></span>
                Not configured
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile label="Awaiting collection" value={inStage('to-collect')} href="/labs?stage=to-collect" icon={ClipboardList} tone="warning" />
        <KpiTile label="In transit" value={inStage('in-transit')} href="/labs?stage=in-transit" icon={Truck} />
        <KpiTile label="At the bench" value={inStage('at-bench')} href="/labs?stage=at-bench" icon={Beaker} />
        <KpiTile label="To verify" value={inStage('to-verify')} href="/labs?stage=to-verify" icon={CheckCircle2} tone="success" />
        <KpiTile label="Critical today" value={kpis.criticalToday} sub={`${kpis.criticalUnverified} critical awaiting verification`} href="/labs?stage=to-verify" icon={Siren} tone={kpis.criticalUnverified > 0 ? 'danger' : 'muted'} />
        <KpiTile label="Resulted today" value={kpis.resultedToday} href="/labs?stage=all" icon={FileCheck2} tone="muted" />
        <KpiTile label="Median TAT today" value={formatMinutes(kpis.medianTatMinutes)} sub="Sample collection to result" href="/labs?stage=all" icon={Timer} tone="muted" />
        <KpiTile label="To report" value={inStage('to-report')} href="/labs?stage=to-report" icon={ListChecks} tone="muted" />
      </div>

      {/* Patient-first by default (explicit product direction): click a
          patient, see their reports as cards; the flat worklist (needed to
          actually process collection/results) stays available as a second
          tab, not the default landing view. */}
      <Tabs initialId={stageParam ? 'worklist' : undefined} tabs={[
        { id: 'by-patient', label: <><Users className="h-4 w-4 text-primary" aria-hidden="true" />By Patient</>, content: <LabsPatientReports roster={patientRoster} /> },
        { id: 'worklist', label: <><ListChecks className="h-4 w-4 text-primary" aria-hidden="true" />Worklist</>, content: <LabWorklist orders={orders} labTests={labTests} role={session.role} stage={stage} /> },
      ]} />
    </div>
  )
}

