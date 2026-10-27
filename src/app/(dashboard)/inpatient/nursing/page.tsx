import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { todayIsoIn } from '@/lib/india-time'
import { listAdmittedForNursing, listMedicationRound } from '@/lib/queries/medication-round'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { NursingStation } from '@/components/inpatient/NursingStation'

// WS3 T7: the nursing station (spec 3.2 item 15) -- CLINICAL_ROLES (crc is the ward-staff stand-in;
// there is no nurse role). Doses are charted through the existing administer route, which stays
// pi/admin, so the round's Give/Hold/Refuse buttons follow that route's roles.
export default async function NursingStationPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const session = await requireSessionOrRedirect()
  if (!CLINICAL_ROLES.includes(session.role)) redirect('/')

  const sp = await searchParams
  const rawWard = typeof sp.ward === 'string' ? sp.ward.trim() : ''
  const ward = rawWard && rawWard.length <= 100 ? rawWard : null
  const date = todayIsoIn()
  const [round, admitted] = await Promise.all([listMedicationRound(date, ward), listAdmittedForNursing()])
  await logAudit(session, 'viewed nursing station', null)

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Nursing station</h1>
      <NursingStation
        date={date}
        initialWard={ward}
        initialRound={round}
        admitted={admitted}
        canChartDoses={['pi', 'admin'].includes(session.role)}
      />
    </div>
  )
}
