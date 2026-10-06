import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { FileText, Stethoscope, ShieldAlert, BedDouble } from 'lucide-react'
import { BackLink } from '@/components/BackLink'
import { StatusChip } from '@/components/StatusChip'
import { EvidenceCard } from '@/components/EvidenceCard'
import { ConfirmEligibilityButton } from '@/components/ConfirmEligibilityButton'
import { PatientPortalAccessPanel } from '@/components/PatientPortalAccessPanel'
import { PatientAvatar } from '@/components/PatientAvatar'
import { PatientQuickGlance } from '@/components/PatientQuickGlance'
import { DiscrepancyList } from '@/components/DiscrepancyList'
import { Tabs } from '@/components/Tabs'
import { DeletePatientButton } from '@/components/DeletePatientButton'
import { InpatientHistoryPanel } from '@/components/InpatientHistoryPanel'
import { requireSessionOrRedirect } from '@/lib/auth'
import { PATIENT_DIRECTORY_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { getPatientDetail } from '@/lib/queries/patients'
import { listAdmissionsForPatient } from '@/lib/queries/admissions'
import { listAvailableRooms } from '@/lib/queries/rooms'

const SECTION = 'rounded-md border border-border bg-card p-5 shadow-none'
const SECTION_HEADING = 'mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

function SummaryTile({ icon: Icon, value, label }: { icon: React.ComponentType<{ className?: string }>; value: number; label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div>
        <p className="text-lg font-bold tabular-nums text-foreground">{value}</p>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

export default async function PatientDetailPage({ params }: { params: Promise<{ anonId: string }> }) {
  // Must be the first statement — see the comment in patients/page.tsx.
  const session = await requireSessionOrRedirect()
  if (!PATIENT_DIRECTORY_ROLES.includes(session.role)) redirect('/')

  // Front desk gets a reduced, non-clinical view (RBAC ruling 2): header,
  // identity verification, portal access and inpatient history (transfers
  // only, discharge clinical fields nulled). No screening, eligibility
  // verdict, chart summary, quick glance or form-vs-chart discrepancies.
  const isFrontDesk = session.role === 'frontdesk'

  const { anonId } = await params
  const patient = await getPatientDetail(anonId)
  if (!patient) notFound()
  await logAudit(session, 'viewed patient detail', anonId)

  const [admissionHistory, availableRooms] = await Promise.all([listAdmissionsForPatient(anonId), listAvailableRooms()])

  const name = patient.name

  const overviewTab = (
    <section className={SECTION}>
      <h2 className={SECTION_HEADING}>Medical Record Summary</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Diagnoses, medications, and allergies live on this patient&apos;s Medical Record page.
      </p>
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <SummaryTile icon={Stethoscope} value={patient.diagnoses.length} label="Diagnoses" />
        <SummaryTile icon={FileText} value={patient.medications.length} label="Medications" />
        <SummaryTile icon={ShieldAlert} value={patient.allergies.length} label="Allergies" />
      </div>
      <Link
        href={`/patients/${patient.id}/medical-record`}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
      >
        <FileText className="h-4 w-4" aria-hidden="true" />
        View Full Medical Record
      </Link>
    </section>
  )

  const screeningTab = (
    <section className={SECTION}>
      <h2 className={SECTION_HEADING}>Screening Evidence</h2>
      {patient.criteria.length === 0 ? (
        <p className="text-sm text-muted-foreground">No screening evidence yet.</p>
      ) : (
        <div className="space-y-5">
          <div>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-success">Inclusion criteria</h3>
            <div className="space-y-3">
              {patient.criteria.filter((c) => c.criterionType !== 'exclusion').map((c) => <EvidenceCard key={c.id} criterion={c} />)}
            </div>
          </div>
          {patient.criteria.some((c) => c.criterionType === 'exclusion') && (
            <div>
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-destructive">Exclusion criteria</h3>
              <div className="space-y-3">
                {patient.criteria.filter((c) => c.criterionType === 'exclusion').map((c) => <EvidenceCard key={c.id} criterion={c} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )

  const identityAndPortalTab = (
    <div className="space-y-6">
      <section className={SECTION}>
        <h2 className={SECTION_HEADING}>Identity Verification</h2>
        {patient.identityVerification?.verified ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="h-2 w-2 rounded-full bg-emerald-600" aria-hidden="true" />
            <span className="text-foreground">Verified by {patient.identityVerification.verifiedBy} on {new Date(patient.identityVerification.verifiedAt!).toLocaleDateString()}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm">
            <span className="h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" />
            <span className="text-foreground">Verification pending{patient.identityVerification ? ` (${patient.identityVerification.idType.replace('_', ' ')} on file)` : ' — no ID on file'}</span>
          </div>
        )}
      </section>

      {!isFrontDesk && (
        <section className={SECTION}>
          <h2 className={SECTION_HEADING}>Form vs. Chart Discrepancies</h2>
          <p className="mb-3 text-xs text-muted-foreground">Dual verification between what the patient self-reported on their intake form and what their actual chart shows.</p>
          <DiscrepancyList discrepancies={patient.discrepancies.map((d) => ({
            id: d.id,
            questionLabel: d.questionLabel,
            patientAnswer: d.patientAnswer,
            chartFinding: d.chartFinding,
            resolved: d.resolved,
            resolvedBy: d.resolvedBy,
            createdAt: d.createdAt.toString(),
          }))} />
        </section>
      )}

      <section className={SECTION}>
        <h2 className={SECTION_HEADING}>Patient Portal Access</h2>
        <PatientPortalAccessPanel anonId={patient.id} initialConfigured={patient.portalConfigured} mfaEnabled={patient.mfaEnabled} isAdmin={session.role === 'admin'} />
      </section>
    </div>
  )

  const inpatientTab = (
    <InpatientHistoryPanel
      admissions={admissionHistory.map((a) => ({
        id: a.id,
        status: a.status,
        admissionType: a.admissionType,
        admittedAt: a.admittedAt.toString(),
        dischargedAt: a.dischargedAt?.toString() ?? null,
        // Discharge clinical fields never reach front desk.
        dischargeDiagnosis: isFrontDesk ? null : a.dischargeDiagnosis,
        dischargeDrugs: isFrontDesk ? null : a.dischargeDrugs,
        dischargeDevices: isFrontDesk ? null : a.dischargeDevices,
        dischargeDiet: isFrontDesk ? null : a.dischargeDiet,
        dischargeSummaryNotes: isFrontDesk ? null : a.dischargeSummaryNotes,
        transfers: a.transfers.map((t) => ({ id: t.id, fromRoomId: t.fromRoomId, toRoomId: t.toRoomId, reason: t.reason, transferredByName: t.transferredByName, transferredAt: t.transferredAt.toString() })),
        dischargeSignature: a.dischargeSignature ? { signerTypedName: a.dischargeSignature.signerTypedName, signedAt: a.dischargeSignature.signedAt.toString() } : null,
      }))}
      availableRooms={availableRooms}
      canTransfer={['frontdesk', 'admin', 'crc', 'pi'].includes(session.role)}
      canDischarge={['pi', 'admin'].includes(session.role)}
      canManageMedications={['pi', 'admin'].includes(session.role)}
    />
  )

  return (
    <div className="max-w-4xl space-y-6">
      <BackLink href="/patients" label="Back to Patients" />
      <div className={`${SECTION} flex items-center justify-between`}>
        <div className="flex items-center gap-4">
          <PatientAvatar name={name} size="lg" />
          <div>
            <h1 className="text-xl font-bold text-foreground">{name}</h1>
            <p className="font-mono text-xs text-muted-foreground">{patient.id} · DOB {patient.dob}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {session.role === 'admin' && <DeletePatientButton patientId={patient.id} patientName={name} />}
          {isFrontDesk ? null : patient.selectionConfirmedAt ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />
              <span>
                Eligibility confirmed by {patient.selectionConfirmedByName} on {new Date(patient.selectionConfirmedAt).toLocaleDateString()} — patient notified {new Date(patient.selectionNotifiedAt!).toLocaleDateString()}.
              </span>
            </p>
          ) : patient.overallStatus === 'green' && ['admin', 'pi', 'crc'].includes(session.role) ? (
            <ConfirmEligibilityButton anonId={patient.id} />
          ) : null}
          {!isFrontDesk && <StatusChip status={patient.overallStatus ?? 'yellow'} />}
        </div>
      </div>
      {!isFrontDesk && !patient.overallStatus && (
        <p className="text-xs text-muted-foreground">Not currently enrolled in a trial — assign this patient to a trial to run an eligibility check.</p>
      )}

      {!isFrontDesk && (
        <PatientQuickGlance
          provider={patient.currentProvider}
          chartDataAsOf={patient.chartDataAsOf.toString()}
          identityVerified={!!patient.identityVerification?.verified}
          criteriaCount={patient.criteria.length}
        />
      )}

      <Tabs tabs={[
        ...(isFrontDesk ? [] : [
          { id: 'overview', label: 'Overview', content: overviewTab },
          { id: 'screening', label: 'Screening', content: screeningTab },
        ]),
        { id: 'identity', label: 'Verification', content: identityAndPortalTab },
        ...(admissionHistory.length > 0 ? [{ id: 'inpatient', label: <span className="inline-flex items-center gap-1.5"><BedDouble className="h-3.5 w-3.5" aria-hidden="true" />Inpatient History</span>, content: inpatientTab }] : []),
      ]} />
    </div>
  )
}
