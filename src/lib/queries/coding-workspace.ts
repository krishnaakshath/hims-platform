// Coding workspace and chart loaders (SP6 Task 8). Read-only.
// PHI (ruling 4): the coder-facing workspace reads the patient by NAMED columns — id, name,
// uhid, gender, dob — and returns only id, name, uhid, gender and ageYears; dob is used for the
// age and never returned. No contact, address, ABHA, insurance or national-ID column is read.
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { getDb } from '@/db/client'
import {
  codeSystems, codes, codingQueries, codingQueryResponses, departments, diagnoses, encounterCoding, encounterCodingEvents,
  encounterNotes, encounterProcedures, encounters, patients, providers, serviceCatalog,
} from '@/db/schema'
import type { Role } from '@/lib/auth'
import type { CodeSystemKind } from '@/lib/coding/code-systems'
import { validateEncounterCoding, type CodingIssue, type Gender } from '@/lib/coding/rules'
import type {
  CodeEntryStatus, CodingEventAction, CodingQueryStatus, DiagnosisType, EncounterCodingStatus,
} from '@/lib/coding/status'
import type { EncounterStatus, EncounterType, EncounterVisitType } from '@/lib/encounters/status'
import { ageOnDate } from '@/lib/india-time'
import { loadCodingRuleInput } from './coding'

export interface WorkspaceEntryCode {
  codeId: number | null
  kind: CodeSystemKind | null
  code: string
  display: string | null
  version: string | null
  isSample: boolean
}

export interface WorkspaceDiagnosis extends WorkspaceEntryCode {
  id: number
  description: string
  type: DiagnosisType | null
  codingStatus: CodeEntryStatus
  sequence: number | null
  proposedByName: string | null
  codedByName: string | null
}

export interface WorkspaceProcedure extends WorkspaceEntryCode {
  id: number
  description: string
  codingStatus: CodeEntryStatus
  performedOn: string
  performedByName: string | null
  serviceId: number | null
  serviceName: string | null
  sequence: number | null
}

export interface WorkspaceQuery {
  id: number
  status: CodingQueryStatus
  question: string
  addressedToProviderId: number
  addressedToName: string
  raisedByName: string
  raisedAt: Date
  responses: { id: number; authorName: string; authorRole: Role; body: string; createdAt: Date }[]
}

export interface CodingWorkspace {
  patient: { id: string; name: string; uhid: string | null; gender: Gender | null; ageYears: number }
  encounter: {
    id: number
    encounterType: EncounterType
    visitType: EncounterVisitType
    status: EncounterStatus
    encounterDate: string
    completedAt: Date | null
    departmentName: string | null
    providerId: number
    providerName: string
    admissionId: number | null
  }
  coding: {
    status: EncounterCodingStatus
    assignedToUserId: number | null
    assignedToName: string | null
    codedByName: string | null
    codedAt: Date | null
    finalisedByName: string | null
    finalisedAt: Date | null
    reopenCount: number
  }
  diagnoses: WorkspaceDiagnosis[]
  procedures: WorkspaceProcedure[]
  notes: {
    id: number
    noteType: string
    authorName: string
    signedAt: Date | null
    subjective: string | null
    objective: string | null
    assessment: string | null
    plan: string | null
  }[]
  queries: WorkspaceQuery[]
  events: { action: CodingEventAction; fromStatus: EncounterCodingStatus; toStatus: EncounterCodingStatus; byName: string; at: Date; reason: string | null }[]
  issues: CodingIssue[]
}

export interface ChartEncounterCoding {
  encounterId: number
  encounterDate: string
  encounterType: EncounterType
  encounterStatus: EncounterStatus
  providerName: string
  codingStatus: EncounterCodingStatus
  diagnoses: WorkspaceDiagnosis[]
  procedures: WorkspaceProcedure[]
  openQueries: WorkspaceQuery[]
}

// ---------------------------------------------------------------------------------------------
// Shared batch loaders (live rows only), keyed by encounter id
// ---------------------------------------------------------------------------------------------

function group<T>(rows: (T & { encounterId: number | null })[]): Map<number, T[]> {
  const out = new Map<number, T[]>()
  for (const { encounterId, ...rest } of rows) {
    if (encounterId === null) continue
    out.set(encounterId, [...(out.get(encounterId) ?? []), rest as unknown as T])
  }
  return out
}

async function loadDiagnoses(encounterIds: number[]): Promise<Map<number, WorkspaceDiagnosis[]>> {
  if (!encounterIds.length) return new Map()
  const rows = await getDb()
    .select({
      encounterId: diagnoses.encounterId,
      id: diagnoses.id,
      description: diagnoses.description,
      type: diagnoses.diagnosisType,
      codingStatus: diagnoses.codingStatus,
      sequence: diagnoses.sequence,
      proposedByName: diagnoses.proposedByName,
      codedByName: diagnoses.codedByName,
      codeId: diagnoses.codeId,
      kind: diagnoses.codeSystemKind,
      code: diagnoses.code,
      display: diagnoses.codeDisplay,
      version: codeSystems.version,
      isSample: sql<boolean>`coalesce(${codeSystems.isSample}, false)`,
    })
    .from(diagnoses)
    .leftJoin(codes, eq(codes.id, diagnoses.codeId))
    .leftJoin(codeSystems, eq(codeSystems.id, codes.codeSystemId))
    .where(and(inArray(diagnoses.encounterId, encounterIds), isNull(diagnoses.voidedAt)))
    // Primary first, then sequence (unsequenced last), then id.
    .orderBy(
      sql`case when ${diagnoses.diagnosisType} = 'primary' then 0 else 1 end`,
      sql`${diagnoses.sequence} asc nulls last`,
      asc(diagnoses.id),
    )
  return group<WorkspaceDiagnosis>(rows)
}

async function loadProcedures(encounterIds: number[]): Promise<Map<number, WorkspaceProcedure[]>> {
  if (!encounterIds.length) return new Map()
  const rows = await getDb()
    .select({
      encounterId: encounterProcedures.encounterId,
      id: encounterProcedures.id,
      description: encounterProcedures.description,
      codingStatus: encounterProcedures.codingStatus,
      performedOn: encounterProcedures.performedOn,
      performedByName: providers.name,
      serviceId: encounterProcedures.serviceId,
      serviceName: serviceCatalog.name,
      sequence: encounterProcedures.sequence,
      codeId: encounterProcedures.codeId,
      kind: encounterProcedures.codeSystemKind,
      code: sql<string>`coalesce(${encounterProcedures.code}, '')`,
      display: encounterProcedures.codeDisplay,
      version: codeSystems.version,
      isSample: sql<boolean>`coalesce(${codeSystems.isSample}, false)`,
    })
    .from(encounterProcedures)
    .leftJoin(providers, eq(providers.id, encounterProcedures.performedByProviderId))
    .leftJoin(serviceCatalog, eq(serviceCatalog.id, encounterProcedures.serviceId))
    .leftJoin(codes, eq(codes.id, encounterProcedures.codeId))
    .leftJoin(codeSystems, eq(codeSystems.id, codes.codeSystemId))
    .where(and(inArray(encounterProcedures.encounterId, encounterIds), isNull(encounterProcedures.voidedAt)))
    .orderBy(sql`${encounterProcedures.sequence} asc nulls last`, asc(encounterProcedures.id))
  return group<WorkspaceProcedure>(rows)
}

async function loadQueries(encounterIds: number[], statuses: CodingQueryStatus[] | null): Promise<Map<number, WorkspaceQuery[]>> {
  if (!encounterIds.length) return new Map()
  const addressedTo = alias(providers, 'addressed_to')
  const rows = await getDb()
    .select({
      encounterId: codingQueries.encounterId,
      id: codingQueries.id,
      status: codingQueries.status,
      question: codingQueries.question,
      addressedToProviderId: codingQueries.addressedToProviderId,
      addressedToName: addressedTo.name,
      raisedByName: codingQueries.raisedByName,
      raisedAt: codingQueries.raisedAt,
    })
    .from(codingQueries)
    .innerJoin(addressedTo, eq(addressedTo.id, codingQueries.addressedToProviderId))
    .where(and(inArray(codingQueries.encounterId, encounterIds), statuses ? inArray(codingQueries.status, statuses) : undefined))
    .orderBy(asc(codingQueries.raisedAt), asc(codingQueries.id))
  const responses = rows.length
    ? await getDb()
      .select({
        queryId: codingQueryResponses.queryId, id: codingQueryResponses.id, authorName: codingQueryResponses.authorName,
        authorRole: codingQueryResponses.authorRole, body: codingQueryResponses.body, createdAt: codingQueryResponses.createdAt,
      })
      .from(codingQueryResponses)
      .where(inArray(codingQueryResponses.queryId, rows.map((r) => r.id)))
      .orderBy(asc(codingQueryResponses.createdAt), asc(codingQueryResponses.id))
    : []
  const byQuery = new Map<number, WorkspaceQuery['responses']>()
  for (const { queryId, ...r } of responses) byQuery.set(queryId, [...(byQuery.get(queryId) ?? []), r])
  return group<WorkspaceQuery>(rows.map((r) => ({ ...r, responses: byQuery.get(r.id) ?? [] })))
}

// ---------------------------------------------------------------------------------------------
// Workspace (coder-facing)
// ---------------------------------------------------------------------------------------------

export async function getCodingWorkspace(encounterId: number): Promise<CodingWorkspace | null> {
  const db = getDb()
  const [row] = await db
    .select({
      // Named patient columns only (ruling 4); dob feeds ageYears and is dropped below.
      patientId: patients.id,
      patientName: patients.name,
      uhid: patients.uhid,
      gender: patients.gender,
      dob: patients.dob,
      id: encounters.id,
      encounterType: encounters.encounterType,
      visitType: encounters.visitType,
      status: encounters.status,
      encounterDate: encounters.encounterDate,
      completedAt: encounters.completedAt,
      departmentName: departments.name,
      providerId: encounters.providerId,
      providerName: providers.name,
      admissionId: encounters.admissionId,
      appointmentId: encounters.appointmentId,
    })
    .from(encounters)
    .innerJoin(patients, eq(patients.id, encounters.patientId))
    .innerJoin(providers, eq(providers.id, encounters.providerId))
    .leftJoin(departments, eq(departments.id, encounters.departmentId))
    .where(eq(encounters.id, encounterId))
  if (!row) return null

  const [coding] = await db
    .select({
      status: encounterCoding.status, assignedToUserId: encounterCoding.assignedToUserId, assignedToName: encounterCoding.assignedToName,
      codedByName: encounterCoding.codedByName, codedAt: encounterCoding.codedAt, finalisedByName: encounterCoding.finalisedByName,
      finalisedAt: encounterCoding.finalisedAt, reopenCount: encounterCoding.reopenCount,
    })
    .from(encounterCoding)
    .where(eq(encounterCoding.encounterId, encounterId))

  // Signed notes of THIS visit only (its appointment or admission); none when it has neither.
  const visitLinks = [
    row.appointmentId !== null ? eq(encounterNotes.appointmentId, row.appointmentId) : undefined,
    row.admissionId !== null ? eq(encounterNotes.admissionId, row.admissionId) : undefined,
  ].filter((c) => c !== undefined)
  const notes = visitLinks.length
    ? await db
      .select({
        id: encounterNotes.id, noteType: encounterNotes.noteType, authorName: encounterNotes.authorName, signedAt: encounterNotes.signedAt,
        subjective: encounterNotes.subjective, objective: encounterNotes.objective, assessment: encounterNotes.assessment, plan: encounterNotes.plan,
      })
      .from(encounterNotes)
      .where(and(eq(encounterNotes.patientId, row.patientId), eq(encounterNotes.status, 'signed'), or(...visitLinks)))
      .orderBy(asc(encounterNotes.signedAt), asc(encounterNotes.id))
    : []

  const [dx, procs, queries, events, ruleInput] = await Promise.all([
    loadDiagnoses([encounterId]),
    loadProcedures([encounterId]),
    loadQueries([encounterId], null),
    db
      .select({
        action: encounterCodingEvents.action, fromStatus: encounterCodingEvents.fromStatus, toStatus: encounterCodingEvents.toStatus,
        byName: encounterCodingEvents.byName, at: encounterCodingEvents.at, reason: encounterCodingEvents.reason,
      })
      .from(encounterCodingEvents)
      .where(eq(encounterCodingEvents.encounterId, encounterId))
      .orderBy(asc(encounterCodingEvents.at), asc(encounterCodingEvents.id)),
    loadCodingRuleInput(db, encounterId),
  ])

  return {
    patient: {
      id: row.patientId, name: row.patientName, uhid: row.uhid, gender: row.gender ?? null,
      ageYears: ageOnDate(row.dob, row.encounterDate),
    },
    encounter: {
      id: row.id, encounterType: row.encounterType, visitType: row.visitType, status: row.status, encounterDate: row.encounterDate,
      completedAt: row.completedAt, departmentName: row.departmentName ?? null, providerId: row.providerId, providerName: row.providerName,
      admissionId: row.admissionId,
    },
    coding: coding ?? {
      status: 'uncoded', assignedToUserId: null, assignedToName: null, codedByName: null, codedAt: null,
      finalisedByName: null, finalisedAt: null, reopenCount: 0,
    },
    diagnoses: dx.get(encounterId) ?? [],
    procedures: procs.get(encounterId) ?? [],
    notes,
    queries: queries.get(encounterId) ?? [],
    events,
    issues: ruleInput ? validateEncounterCoding(ruleInput, 'finalise') : [],
  }
}

// ---------------------------------------------------------------------------------------------
// Chart (doctor-facing): the patient's recent visits with their coding
// ---------------------------------------------------------------------------------------------

export async function listEncounterCodingForPatient(patientId: string, limit = 10): Promise<ChartEncounterCoding[]> {
  const rows = await getDb()
    .select({
      encounterId: encounters.id,
      encounterDate: encounters.encounterDate,
      encounterType: encounters.encounterType,
      encounterStatus: encounters.status,
      providerName: providers.name,
      codingStatus: encounterCoding.status,
    })
    .from(encounters)
    .innerJoin(providers, eq(providers.id, encounters.providerId))
    .leftJoin(encounterCoding, eq(encounterCoding.encounterId, encounters.id))
    .where(and(eq(encounters.patientId, patientId), ne(encounters.status, 'cancelled')))
    .orderBy(desc(encounters.encounterDate), desc(encounters.id))
    .limit(limit)
  const ids = rows.map((r) => r.encounterId)
  const [dx, procs, queries] = await Promise.all([loadDiagnoses(ids), loadProcedures(ids), loadQueries(ids, ['open', 'answered'])])
  return rows.map((r) => ({
    ...r,
    codingStatus: r.codingStatus ?? 'uncoded',
    diagnoses: dx.get(r.encounterId) ?? [],
    procedures: procs.get(r.encounterId) ?? [],
    openQueries: queries.get(r.encounterId) ?? [],
  }))
}
