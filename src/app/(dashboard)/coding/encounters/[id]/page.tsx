// /coding/encounters/[id]: the coding workspace for one encounter (CODING_ROLES). The role gate runs
// before any data load; a bad or unknown id is a 404. Audited with the patient id.
// Coder minimum PHI (ruling 4): only an explicit view is built from the loader's payload -- name,
// UHID, sex and age in years; never dob, contact, address, ABHA, insurance or Aadhaar fields.
import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { CODING_ROLES } from '@/lib/role-policy'
import type { Gender } from '@/lib/coding/rules'
import type { EncounterVisitType } from '@/lib/encounters/status'
import { DEFAULT_TIMEZONE, formatDateTimeIn, formatIsoDate, todayIsoIn } from '@/lib/india-time'
import { getCodingWorkspace, type WorkspaceDiagnosis, type WorkspaceProcedure } from '@/lib/queries/coding-workspace'
import { listAllProviders } from '@/lib/queries/providers'
import { listAllUsers } from '@/lib/queries/users'
import { CODING_EVENT_LABEL, CodingWorkspaceView, codingStatusChange, type WorkspaceView } from '@/components/coding/CodingWorkspaceView'
import type { EntryView } from '@/components/coding/EntryEditor'

const SEX_LABEL: Record<Gender, string> = { male: 'Male', female: 'Female', transgender: 'Transgender', other: 'Other', unknown: 'Unknown' }
const VISIT_TYPE_LABEL: Record<EncounterVisitType, string> = { new: 'New visit', follow_up: 'Follow-up', review: 'Review', emergency: 'Emergency' }
const NOTE_TYPE_LABEL: Record<string, string> = { progress: 'Progress note', nursing: 'Nursing note', intake: 'Intake note' }
const ROLE_LABEL: Record<string, string> = { pi: 'Doctor', admin: 'Admin', coder: 'Coder' }

/** A positive int4 path id, or null. */
function parseEncounterId(raw: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null
  const n = Number(raw)
  return n <= 2_147_483_647 ? n : null
}

const entryBase = (e: WorkspaceDiagnosis | WorkspaceProcedure) => ({
  id: e.id,
  description: e.description,
  codeId: e.codeId,
  kind: e.kind,
  code: e.code,
  display: e.display,
  isSample: e.isSample,
  codingStatus: e.codingStatus,
  proposedByName: e.proposedByName,
  sequence: e.sequence,
})

export default async function CodingWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionOrRedirect()
  if (!CODING_ROLES.includes(session.role)) redirect('/')

  const encounterId = parseEncounterId((await params).id)
  if (encounterId === null) notFound()
  const ws = await getCodingWorkspace(encounterId)
  if (!ws) notFound()

  const [providerRows, userRows] = await Promise.all([
    listAllProviders(),
    // The assign select is admin-only; a coder's page never loads the staff list.
    session.role === 'admin' ? listAllUsers() : Promise.resolve([]),
  ])
  await logAudit(session, 'coding: viewed coding workspace', ws.patient.id, `encounter=${encounterId}`)

  const view: WorkspaceView = {
    encounterId,
    patient: {
      name: ws.patient.name,
      uhid: ws.patient.uhid,
      sexLabel: ws.patient.gender ? SEX_LABEL[ws.patient.gender] : 'Not recorded',
      ageYears: ws.patient.ageYears,
    },
    encounter: {
      typeLabel: ws.encounter.encounterType.toUpperCase(),
      visitTypeLabel: VISIT_TYPE_LABEL[ws.encounter.visitType],
      dateIso: ws.encounter.encounterDate,
      dateLabel: formatIsoDate(ws.encounter.encounterDate),
      completedLabel: ws.encounter.completedAt ? formatDateTimeIn(ws.encounter.completedAt) : null,
      isCompleted: ws.encounter.status === 'completed',
      departmentName: ws.encounter.departmentName,
      providerId: ws.encounter.providerId,
      providerName: ws.encounter.providerName,
    },
    coding: {
      status: ws.coding.status,
      assignedToUserId: ws.coding.assignedToUserId,
      assignedToName: ws.coding.assignedToName,
      codedLine: ws.coding.codedAt ? `${ws.coding.codedByName ?? '—'}, ${formatDateTimeIn(ws.coding.codedAt)}` : null,
      finalisedLine: ws.coding.finalisedAt ? `${ws.coding.finalisedByName ?? '—'}, ${formatDateTimeIn(ws.coding.finalisedAt)}` : null,
      reopenCount: ws.coding.reopenCount,
    },
    diagnoses: ws.diagnoses.map((d): EntryView => ({ ...entryBase(d), type: d.type })),
    procedures: ws.procedures.map((p): EntryView => ({
      ...entryBase(p),
      performedOn: p.performedOn,
      performedOnLabel: formatIsoDate(p.performedOn),
      performedByName: p.performedByName,
      serviceName: p.serviceName,
    })),
    notes: ws.notes.map((n) => ({
      id: n.id,
      title: NOTE_TYPE_LABEL[n.noteType] ?? 'Note',
      byline: `${n.authorName}${n.signedAt ? `, signed ${formatDateTimeIn(n.signedAt)}` : ''}`,
      sections: [
        { label: 'Subjective', text: n.subjective },
        { label: 'Objective', text: n.objective },
        { label: 'Assessment', text: n.assessment },
        { label: 'Plan', text: n.plan },
      ].flatMap((s) => (s.text && s.text.trim() !== '' ? [{ label: s.label, text: s.text }] : [])),
    })),
    queries: ws.queries.map((q) => ({
      id: q.id,
      status: q.status,
      question: q.question,
      addressedToName: q.addressedToName,
      raisedByName: q.raisedByName,
      raisedLabel: formatDateTimeIn(q.raisedAt),
      responses: q.responses.map((r) => ({
        id: r.id,
        authorName: r.authorName,
        authorRoleLabel: ROLE_LABEL[r.authorRole] ?? r.authorRole,
        body: r.body,
        createdLabel: formatDateTimeIn(r.createdAt),
      })),
    })),
    // Reopen reasons are shown: this page is gated to the coding roles.
    events: ws.events.map((e, i) => ({
      key: `${i}-${e.action}`,
      actionLabel: CODING_EVENT_LABEL[e.action],
      change: codingStatusChange(e.fromStatus, e.toStatus),
      byName: e.byName,
      atLabel: formatDateTimeIn(e.at),
      reason: e.reason,
    })),
    issues: ws.issues.map((i) => ({ severity: i.severity, code: i.code, entry: i.entry, message: i.message })),
  }

  return (
    <CodingWorkspaceView
      view={view}
      role={session.role}
      userId={session.userId}
      // id and name only, never whole staff or provider rows (no email or registration numbers).
      coders={userRows.filter((u) => u.role === 'coder').map((u) => ({ id: u.id, name: u.name }))}
      providers={providerRows.filter((p) => p.isActive).map((p) => ({ id: p.id, name: p.name }))}
      todayIso={todayIsoIn(DEFAULT_TIMEZONE, new Date())}
    />
  )
}
