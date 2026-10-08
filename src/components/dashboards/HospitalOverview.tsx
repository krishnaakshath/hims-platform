// Wave E (P1-06, P1-07): the live hospital KPI row, bed occupancy by ward and,
// for roles on the RCM desk, insurer claim ageing. Shared by the admin,
// coordinator and front-desk homes; every link is filtered by the viewing
// role's page access in hospitalTiles().
import Link from 'next/link'
import type { Role } from '@/lib/auth'
import { hospitalTiles, type HospitalSnapshot } from '@/lib/dashboard-tiles'
import { formatPaise } from '@/lib/format'
import { DashSection, KpiGrid, KpiTile, WardOccupancy } from '@/components/dashboards/KpiTile'

export function HospitalKpiRow({ role, hospital }: { role: Role; hospital: HospitalSnapshot }) {
  const tiles = hospitalTiles(role, hospital)
  if (tiles.length === 0) return null
  return (
    <KpiGrid>
      {tiles.map(({ id, ...t }) => <KpiTile key={id} {...t} />)}
    </KpiGrid>
  )
}

export function ClaimAgeing({ aging, outstandingPaise }: { aging: { label: string; paise: number }[]; outstandingPaise: number }) {
  const max = Math.max(1, ...aging.map((b) => b.paise))
  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">Outstanding with insurers: <span className="font-semibold tabular-nums text-foreground">{formatPaise(outstandingPaise)}</span></p>
      <ul className="space-y-2">
        {aging.map((b) => (
          <li key={b.label} className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-2 text-xs">
            <span className="text-muted-foreground">{b.label} days</span>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-warning" style={{ width: `${Math.round((b.paise / max) * 100)}%` }} /></div>
            <span className="tabular-nums text-foreground">{formatPaise(b.paise)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function HospitalOverview({ role, hospital }: { role: Role; hospital: HospitalSnapshot }) {
  return (
    <>
      <HospitalKpiRow role={role} hospital={hospital} />
      <div className={`mb-4 grid grid-cols-1 gap-4 ${hospital.claims ? 'lg:grid-cols-2' : ''}`}>
        <DashSection title={`Bed occupancy by ward (${hospital.ipd.occupied}/${hospital.ipd.beds - hospital.ipd.blocked})`} href="/inpatient/beds" linkLabel="Bed board">
          <WardOccupancy wards={hospital.ipd.wards} />
        </DashSection>
        {hospital.claims && (
          <DashSection title="Claim ageing" href="/rcm" linkLabel="RCM desk">
            <ClaimAgeing aging={hospital.claims.aging} outstandingPaise={hospital.claims.outstandingPaise} />
            <p className="mt-3 text-xs text-muted-foreground">
              {hospital.claims.queried} claims queried · <Link href="/rcm/preauths" className="text-primary hover:underline">{hospital.claims.preauthsOverdue} pre-auth decisions overdue</Link>
            </p>
          </DashSection>
        )}
      </div>
    </>
  )
}
