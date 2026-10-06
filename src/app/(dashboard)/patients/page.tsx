import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { PATIENT_DIRECTORY_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { listPatientsWithStatus } from '@/lib/queries/patients'
import { listAllTrials } from '@/lib/queries/trials'
import { PatientsTable } from '@/components/PatientsTable'
import { AddPatientButton } from '@/components/AddPatientButton'

export default async function PatientsPage({ searchParams }: { searchParams: Promise<{ trialId?: string }> }) {
  // Must be the first statement: a final security review proved that relying
  // on the (dashboard) layout's redirect() alone lets this page's full PHI
  // content render and stream into the response body even on an
  // unauthenticated request (the top-level status becomes a redirect, but
  // the body isn't discarded server-side). Checking here, before any data
  // fetch, is what actually stops that.
  const session = await requireSessionOrRedirect()
  if (!PATIENT_DIRECTORY_ROLES.includes(session.role)) redirect('/')

  // Front desk gets the directory (names, DOB, provider, registration) but
  // no trial-eligibility evidence: no trial filter, no verdicts, no
  // criteria counts. listPatientsWithStatus returns one row per screening,
  // so the unfiltered list is deduped to one card per patient.
  const isFrontDesk = session.role === 'frontdesk'
  const { trialId: requestedTrialId } = await searchParams
  const trialId = isFrontDesk ? undefined : requestedTrialId
  const [rows, trials] = await Promise.all([listPatientsWithStatus(trialId ?? null), isFrontDesk ? Promise.resolve([]) : listAllTrials()])
  const patients = isFrontDesk ? [...new Map(rows.map((p) => [p.id, p])).values()] : rows
  await logAudit(session, 'viewed patient list', null)

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Patients</h1>
        <div className="flex items-center gap-3">
          {/* Same dead-button reasoning as the export link just below --
              POST /api/patients now restricts registration to admin/frontdesk
              exclusively (explicit product direction), so crc/pi must not see
              a button that would just 403. */}
          {['admin', 'frontdesk'].includes(session.role) && <AddPatientButton />}
          {/* The export link is scoped to the same allowlist as the route it
              points at (LeftNav.tsx:33 / workbook/export/route.ts) -- /patients
              itself stays open to every role (spec §6.1, §10), but leaving
              this visible to a role the route now 403s would just be a dead
              button. */}
          {['admin', 'crc'].includes(session.role) && (
            <a href="/api/workbook/export" className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground shadow-none transition-opacity hover:opacity-90">Download Verification Workbook</a>
          )}
        </div>
      </div>

      {!isFrontDesk && (
        <div className="mb-4 flex items-center gap-1 rounded-lg border border-primary/10 bg-card p-1 text-sm">
          <Link href="/patients" className={`rounded-md px-3 py-1.5 font-medium transition-colors ${!trialId ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}>All Trials</Link>
          {trials.map((t) => (
            <Link key={t.id} href={`/patients?trialId=${t.id}`} className={`rounded-md px-3 py-1.5 font-medium transition-colors ${trialId === t.id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}>{t.condition}</Link>
          ))}
        </div>
      )}

      {/* Project down to only what PatientsTable renders before crossing
          the Server->Client Component boundary -- the full row includes
          clinician notes and every other contact field, none of which this
          table shows, but all of which would otherwise ship into the
          client bundle. Front desk's projection drops the verdict and
          criteria summary entirely, so they never reach the client. */}
      <PatientsTable
        patients={patients.map((p) => ({
          id: p.id,
          name: p.name,
          dob: p.dob,
          currentProvider: p.currentProvider,
          referralType: p.referralType,
          lastCommunication: p.lastCommunication,
          ...(isFrontDesk ? {} : { overallStatus: p.overallStatus, criteriaSummary: p.criteriaSummary }),
        }))}
        // Front desk sees patients, not charts -- the medical-record page
        // redirects them (CLINICAL_ROLES gate).
        showMedicalRecordLink={!isFrontDesk}
        showScreening={!isFrontDesk}
      />
    </div>
  )
}
