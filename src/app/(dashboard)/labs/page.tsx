import { redirect } from 'next/navigation'
import { ClipboardList, Beaker, CheckCircle2, Truck, Users, ListChecks } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CountUp } from '@/components/CountUp'
import { logAudit } from '@/lib/audit'
import { listWorklist, listPatientsWithLabOrders } from '@/lib/queries/lab-orders'
import { listLabTests } from '@/lib/queries/lab-tests'
import { LabWorklist } from '@/components/LabWorklist'
import { LabsPatientReports } from '@/components/LabsPatientReports'
import { Tabs } from '@/components/Tabs'
import { LAB_WORKLIST_ROLES } from '@/lib/role-policy' // SP5

function StatTile({ value, label, icon: Icon, tone }: { value: number; label: string; icon: React.ComponentType<{ className?: string }>; tone: string }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-card p-4">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone}`} aria-hidden="true">
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div>
        <p className="text-2xl font-bold tabular-nums text-foreground"><CountUp to={value} /></p>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

export default async function LabsPage() {
  const session = await requireSessionOrRedirect()
  // Matches GET /api/lab-orders's own role gate (SP5: LAB_WORKLIST_ROLES). frontdesk removed per
  // explicit product direction (registration/check-in only, no lab access).
  if (!LAB_WORKLIST_ROLES.includes(session.role)) redirect('/')

  const [orders, labTests, patientRoster] = await Promise.all([listWorklist(), listLabTests(), listPatientsWithLabOrders()])
  await logAudit(session, session.role === 'labs' ? 'viewed labs dashboard' : 'viewed lab worklist', null)

  // Same trimmed-nonempty rule as the FHIR webhook; only the boolean reaches
  // the markup, never the token.
  const lisConfigured = Boolean(process.env.LIS_INTEGRATION_TOKEN?.trim())

  // SP5: one tile per bench stage.
  const awaitingCollection = orders.filter((o) => o.status === 'ordered' || o.status === 'scheduled').length
  const inTransit = orders.filter((o) => o.status === 'collected').length
  const atBench = orders.filter((o) => o.status === 'received').length
  const toVerify = orders.filter((o) => o.status === 'resulted').length

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

      {session.role === 'labs' && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile value={awaitingCollection} label="Awaiting collection" icon={ClipboardList} tone="bg-warning/10 text-warning" />
          <StatTile value={inTransit} label="In transit" icon={Truck} tone="bg-primary/10 text-primary" />
          <StatTile value={atBench} label="At the bench" icon={Beaker} tone="bg-accent/10 text-accent" />
          <StatTile value={toVerify} label="To verify" icon={CheckCircle2} tone="bg-success/10 text-success" />
        </div>
      )}

      {/* Patient-first by default (explicit product direction): click a
          patient, see their reports as cards; the flat worklist (needed to
          actually process collection/results) stays available as a second
          tab, not the default landing view. */}
      <Tabs tabs={[
        { id: 'by-patient', label: <><Users className="h-4 w-4 text-primary" aria-hidden="true" />By Patient</>, content: <LabsPatientReports roster={patientRoster} /> },
        { id: 'worklist', label: <><ListChecks className="h-4 w-4 text-primary" aria-hidden="true" />Worklist</>, content: <LabWorklist orders={orders} labTests={labTests} role={session.role} /> },
      ]} />
    </div>
  )
}

