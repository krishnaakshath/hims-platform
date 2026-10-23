// WS4 T12 (spec 3.5 items 23-26): critical-value alerts. One alert per lab order, raised inside the
// result transaction (recordLabResult) when the summary flag becomes critical -- critical values
// are communicated on the preliminary result -- and withdrawn when an amendment removes the flag.
// Lifecycle open -> notified (the lab's call log: who called whom, when, how, read-back) ->
// acknowledged (the ordering doctor or the attending of the active admission), or withdrawn.
// verifyLabResult refuses `critical_not_notified` while the alert is still `open`, and an `open`
// alert cannot be acknowledged (`not_notified`): the call is always logged first.
//
// Lock order: the lab_orders row (`for update`), then the alert row (`for update`). Same first lock
// as every lab lifecycle write, so no new deadlock path. Audits carry ids only (the called name
// and the acknowledgement note are stored, never audited).
import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissions, labCriticalAlerts, labOrders, labResultSignoffs, labTests, patients, serviceCatalog } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import type { LabResultFlag } from '@/lib/labs/analytes'
import { verificationDenial } from '@/lib/labs/verification'
import { resolveSessionProvider } from '@/lib/provider-identity'
import type { WriteExecutor } from '@/lib/queries/executor'
import { isResultOwnerInTx, markCriticalAlertAcknowledgedInTx, resolveVerifierDepartmentId } from '@/lib/queries/lab-signoffs'

export type CriticalAlertStatus = 'open' | 'notified' | 'acknowledged' | 'withdrawn'
export type CriticalNotifyChannel = 'phone' | 'in_person' | 'in_app'

export interface CriticalAlertRow {
  orderId: number
  patientId: string
  patientName: string
  uhid: string | null
  testName: string
  summary: string
  status: CriticalAlertStatus
  raisedAt: string
  notifiedAt: string | null
  notifiedByName: string | null
  notifiedToName: string | null
  notifyChannel: CriticalNotifyChannel | null
  readBack: boolean | null
  acknowledgedAt: string | null
  acknowledgedByName: string | null
  orderedByProviderId: number
}

/** Unacknowledged, still-live alerts: what the banner, the Critical tile and the staff feed show. */
export const OPEN_CRITICAL_STATUSES: readonly CriticalAlertStatus[] = ['open', 'notified']

const SUMMARY_MAX = 500
const valueWithUnit = (value: string, unit: string | null | undefined) => `${value.trim()}${unit ? ` ${unit}` : ''}`

/**
 * The alert's one-line summary: each critical analyte as "Platelets 38 ×10³/µL", joined by "; ",
 * in the test's analyte order; for a single-value test, the test name and its value.
 */
export function criticalSummaryText(i: {
  testName: string
  value: string
  unit: string | null
  analytes?: { name: string; value: string; unit: string | null; flag: LabResultFlag }[]
}): string {
  const critical = (i.analytes ?? []).filter((a) => a.flag === 'critical')
  const text = critical.length > 0
    ? critical.map((a) => `${a.name} ${valueWithUnit(a.value, a.unit)}`).join('; ')
    : `${i.testName} ${valueWithUnit(i.value, i.unit)}`
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text
}

/**
 * Called by recordLabResult on its transaction, under the order lock. A critical result raises the
 * order's one alert (a withdrawn one re-opens with a fresh call log). A critical amendment never
 * duplicates: an `open` alert just takes the new summary ('unchanged'); a `notified` or
 * `acknowledged` alert whose summary changes re-opens ('raised') with the call log and the
 * acknowledgement cleared, because both were about a value that is no longer the result; one whose
 * summary is unchanged is left as it is. A non-critical amendment withdraws an open/notified alert;
 * an acknowledged alert is then a closed record and is left as it is.
 */
export async function raiseOrWithdrawCriticalAlert(
  tx: WriteExecutor,
  i: { orderId: number; patientId: string; flag: LabResultFlag; summary: string },
  now: Date,
): Promise<'raised' | 'withdrawn' | 'unchanged'> {
  const [existing] = await tx.select({ id: labCriticalAlerts.id, status: labCriticalAlerts.status, summary: labCriticalAlerts.summary })
    .from(labCriticalAlerts).where(eq(labCriticalAlerts.labOrderId, i.orderId)).for('update')
  if (i.flag === 'critical') {
    if (!existing) {
      await tx.insert(labCriticalAlerts).values({ labOrderId: i.orderId, patientId: i.patientId, summary: i.summary, status: 'open', raisedAt: now })
      return 'raised'
    }
    if (existing.status === 'open') {
      if (existing.summary !== i.summary) await tx.update(labCriticalAlerts).set({ summary: i.summary }).where(eq(labCriticalAlerts.id, existing.id))
      return 'unchanged'
    }
    // notified / acknowledged with the same critical values: the call log still describes this result.
    if (existing.status !== 'withdrawn' && existing.summary === i.summary) return 'unchanged'
    await tx.update(labCriticalAlerts).set({
      summary: i.summary, status: 'open', raisedAt: now, withdrawnAt: null,
      notifiedAt: null, notifiedByName: null, notifiedByUserId: null, notifiedToName: null, notifyChannel: null, readBack: null,
      acknowledgedAt: null, acknowledgedByName: null, acknowledgedByUserId: null, ackNote: null,
    }).where(eq(labCriticalAlerts.id, existing.id))
    return 'raised'
  }
  if (existing && OPEN_CRITICAL_STATUSES.includes(existing.status)) {
    await tx.update(labCriticalAlerts).set({ status: 'withdrawn', withdrawnAt: now }).where(eq(labCriticalAlerts.id, existing.id))
    return 'withdrawn'
  }
  return 'unchanged'
}

/** The order's alert status, read on the caller's transaction (verifyLabResult, under the order lock). */
export async function criticalAlertStatusInTx(ex: Pick<WriteExecutor, 'select'>, orderId: number): Promise<CriticalAlertStatus | null> {
  const [row] = await ex.select({ status: labCriticalAlerts.status }).from(labCriticalAlerts).where(eq(labCriticalAlerts.labOrderId, orderId))
  return row?.status ?? null
}

/**
 * Whether a `pi` may log the call for this order (spec 3.4: "any provider allowed to verify that
 * order"): the session's staff-linked provider must belong to the test's reporting department.
 * Decision (documented): the self-verification rule does NOT apply -- logging a call is not
 * authorising the result, and a pi never enters results anyway. `labs` / `admin` are not checked.
 */
export async function criticalNotifyDenial(orderId: number, session: Session): Promise<'not_found' | 'not_linked' | 'wrong_department' | null> {
  const verifierDepartmentId = await resolveVerifierDepartmentId(session)
  const [row] = await getDb().select({ departmentId: serviceCatalog.departmentId }).from(labOrders)
    .innerJoin(labTests, eq(labTests.id, labOrders.labTestId))
    .leftJoin(serviceCatalog, eq(serviceCatalog.id, labTests.serviceId))
    .where(eq(labOrders.id, orderId))
  if (!row) return 'not_found'
  const denial = verificationDenial({
    status: 'resulted', verifierDepartmentId, testDepartmentId: row.departmentId ?? null, verifierUserId: null, resultedByUserId: null,
  })
  return denial === 'not_linked' || denial === 'wrong_department' ? denial : null
}

async function lockAlert(tx: WriteExecutor, orderId: number) {
  const [order] = await tx.select({ id: labOrders.id, patientId: labOrders.patientId, orderedByProviderId: labOrders.orderedByProviderId })
    .from(labOrders).where(eq(labOrders.id, orderId)).for('update')
  if (!order) return null
  const [alert] = await tx.select({ id: labCriticalAlerts.id, status: labCriticalAlerts.status })
    .from(labCriticalAlerts).where(eq(labCriticalAlerts.labOrderId, orderId)).for('update')
  return alert ? { order, alert } : null
}

/** The lab's call log. A phone call requires read-back (NABL practice). Only an `open` alert is logged. */
export async function logCriticalNotification(
  orderId: number,
  i: { notifiedToName: string; channel: CriticalNotifyChannel; readBack: boolean },
  session: Session,
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'not_open' | 'read_back_required' }> {
  if (i.channel === 'phone' && !i.readBack) return { ok: false, error: 'read_back_required' }
  return getDb().transaction(async (tx) => {
    const locked = await lockAlert(tx, orderId)
    if (!locked) return { ok: false, error: 'not_found' } as const
    if (locked.alert.status !== 'open') return { ok: false, error: 'not_open' } as const
    await tx.update(labCriticalAlerts).set({
      status: 'notified', notifiedAt: now, notifiedByName: session.name, notifiedByUserId: session.userId,
      notifiedToName: i.notifiedToName.trim(), notifyChannel: i.channel, readBack: i.readBack,
    }).where(eq(labCriticalAlerts.id, locked.alert.id))
    await logAudit(session, 'logged critical result call', locked.order.patientId, `order=${orderId} alert=${locked.alert.id}`, tx)
    return { ok: true } as const
  })
}

/**
 * The doctor's acknowledgement closes a `notified` alert (an `open` one is refused `not_notified`:
 * the lab logs the call first, spec 3.5 item 24) and, in the same
 * transaction, records an `acknowledge` sign-off (WS4 T11) for this provider -- one that already
 * exists is kept. Identity is the staff link only (resolveSessionProvider).
 */
export async function acknowledgeCriticalAlert(
  orderId: number,
  note: string | null,
  session: Session,
  now: Date = new Date(),
): Promise<{ ok: true; providerId: number } | { ok: false; error: 'not_found' | 'not_owner' | 'already_acknowledged' | 'withdrawn' | 'not_notified' }> {
  const provider = await resolveSessionProvider(session)
  return getDb().transaction(async (tx) => {
    const locked = await lockAlert(tx, orderId)
    if (!locked) return { ok: false, error: 'not_found' } as const
    if (!provider || !(await isResultOwnerInTx(tx, provider.id, locked.order))) return { ok: false, error: 'not_owner' } as const
    if (locked.alert.status === 'withdrawn') return { ok: false, error: 'withdrawn' } as const
    if (locked.alert.status === 'acknowledged') return { ok: false, error: 'already_acknowledged' } as const
    if (locked.alert.status === 'open') return { ok: false, error: 'not_notified' } as const
    await markCriticalAlertAcknowledgedInTx(tx, locked.alert.id, note, session, now)
    const signoff = await tx.insert(labResultSignoffs)
      .values({ labOrderId: orderId, kind: 'acknowledge', providerId: provider.id, userId: session.userId, signedByName: session.name, note, signedAt: now })
      .onConflictDoNothing({ target: [labResultSignoffs.labOrderId, labResultSignoffs.kind, labResultSignoffs.providerId] })
      .returning({ id: labResultSignoffs.id })
    const signoffPart = signoff.length > 0 ? ` signoff=${signoff[0].id}` : ''
    await logAudit(session, 'acknowledged critical result', locked.order.patientId, `order=${orderId} alert=${locked.alert.id}${signoffPart}`, tx)
    return { ok: true, providerId: provider.id } as const
  })
}

const LIST_LIMIT = 50

/**
 * Open and notified alerts, newest first. `providerId` keeps the alerts that provider owns: their
 * own orders, or any order of a patient they are attending on an active admission.
 */
export async function listOpenCriticalAlerts(filter: { patientId?: string; providerId?: number }): Promise<CriticalAlertRow[]> {
  const where: (SQL | undefined)[] = [inArray(labCriticalAlerts.status, [...OPEN_CRITICAL_STATUSES])]
  if (filter.patientId !== undefined) where.push(eq(labCriticalAlerts.patientId, filter.patientId))
  if (filter.providerId !== undefined) {
    where.push(or(
      eq(labOrders.orderedByProviderId, filter.providerId),
      sql`exists (select 1 from ${admissions} a where a.patient_id = ${labOrders.patientId} and a.status = 'admitted' and a.attending_provider_id = ${filter.providerId})`,
    ))
  }
  const rows = await getDb()
    .select({
      a: labCriticalAlerts, testName: labTests.name, patientName: patients.name, uhid: patients.uhid, orderedByProviderId: labOrders.orderedByProviderId,
    })
    .from(labCriticalAlerts)
    .innerJoin(labOrders, eq(labOrders.id, labCriticalAlerts.labOrderId))
    .innerJoin(labTests, eq(labTests.id, labOrders.labTestId))
    .innerJoin(patients, eq(patients.id, labCriticalAlerts.patientId))
    .where(and(...where))
    .orderBy(desc(labCriticalAlerts.raisedAt), desc(labCriticalAlerts.id))
    .limit(LIST_LIMIT)
  const iso = (d: Date | null) => (d ? d.toISOString() : null)
  return rows.map(({ a, testName, patientName, uhid, orderedByProviderId }) => ({
    orderId: a.labOrderId, patientId: a.patientId, patientName, uhid, testName, summary: a.summary, status: a.status,
    raisedAt: a.raisedAt.toISOString(), notifiedAt: iso(a.notifiedAt), notifiedByName: a.notifiedByName, notifiedToName: a.notifiedToName,
    notifyChannel: a.notifyChannel, readBack: a.readBack, acknowledgedAt: iso(a.acknowledgedAt), acknowledgedByName: a.acknowledgedByName,
    orderedByProviderId,
  }))
}

/**
 * Order ids of the alerts this session may acknowledge: `notified` ones (the call is logged; an
 * `open` alert is refused `not_notified`) that its staff-linked provider owns (ordering or
 * attending). Empty without a link. The route re-checks under the lock.
 */
export async function acknowledgeableCriticalOrderIds(session: Session, filter: { patientId?: string } = {}): Promise<number[]> {
  const provider = await resolveSessionProvider(session)
  if (!provider) return []
  return (await listOpenCriticalAlerts({ ...filter, providerId: provider.id })).filter((a) => a.status === 'notified').map((a) => a.orderId)
}
