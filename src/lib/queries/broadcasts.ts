import { getDb } from '@/db/client'
import { admissions, broadcasts, departments, encounters, followUpOrders, formSubmissions, patientNotificationPreferences, patients, patientTrialScreenings, providers, rooms, trials } from '@/db/schema'
import { and, asc, desc, eq, exists, gte, lt, lte, ne, sql, type SQL } from 'drizzle-orm'
import { getOrSetCache, invalidateCache, broadcastsListCacheKey } from '@/lib/cache'
import { addDaysIso, MISSED_GRACE_DAYS } from '@/lib/follow-ups/rules'
import { todayIsoIn } from '@/lib/india-time'
import { normalizePhone } from '@/lib/india/phone'
import { LANGUAGES } from '@/lib/india/reference'
import { broadcastOutcome, classifyRecipient, describeAudienceFilters, type HospitalAudienceFilters, type RecipientClass } from '@/lib/broadcasts/audience'
import { sendNotification, type SendNotificationDeps } from '@/lib/notify/send'
import { notArchived } from './patient-archive' // WS8 T13

export interface BroadcastAudienceMember {
  id: string
  uhid: string | null
  name: string
  /** As stored; the send path normalises it again. */
  phone: string | null
  email: string | null
  recipientClass: RecipientClass
}

/** SQL conditions on `patients` for the hospital filters (trial and form filters are applied after). */
function hospitalConditions(f: HospitalAudienceFilters, todayIso: string): SQL[] {
  const c: SQL[] = []
  const today = sql`${todayIso}::date`
  const yearAgo = sql`(${todayIso}::date - interval '12 months')::date`
  const encounterWith = (col: typeof encounters.departmentId | typeof encounters.providerId, v: number) =>
    exists(getDb().select({ one: sql`1` }).from(encounters).where(and(
      eq(encounters.patientId, patients.id), eq(col, v), ne(encounters.status, 'cancelled'), gte(encounters.encounterDate, yearAgo),
    )))
  if (f.departmentId !== undefined) c.push(encounterWith(encounters.departmentId, f.departmentId))
  if (f.providerId !== undefined) c.push(encounterWith(encounters.providerId, f.providerId))
  // Age in whole years on today's IST date: age >= n  <=>  dob <= today - n years.
  if (f.ageMin !== undefined) c.push(sql`${patients.dob} <= (${today} - make_interval(years => ${f.ageMin}::int))::date`)
  if (f.ageMax !== undefined) c.push(sql`${patients.dob} > (${today} - make_interval(years => ${f.ageMax + 1}::int))::date`)
  if (f.ward) {
    c.push(exists(getDb().select({ one: sql`1` }).from(admissions).innerJoin(rooms, eq(rooms.id, admissions.currentRoomId)).where(and(
      eq(admissions.patientId, patients.id), eq(admissions.status, 'admitted'), eq(rooms.ward, f.ward),
    ))))
  }
  if (f.followUpDue) {
    // Not yet booked ('planned'). Overdue = window closed, still inside the missed grace period
    // (the follow-up worklist's "overdue" bucket); due_7_days = due date within the next 7 days.
    const window = f.followUpDue === 'overdue'
      ? and(lt(followUpOrders.windowEnd, todayIso), gte(followUpOrders.windowEnd, addDaysIso(todayIso, -MISSED_GRACE_DAYS)))
      : and(gte(followUpOrders.dueDate, todayIso), lte(followUpOrders.dueDate, addDaysIso(todayIso, 7)))
    c.push(exists(getDb().select({ one: sql`1` }).from(followUpOrders).where(and(
      eq(followUpOrders.patientId, patients.id), eq(followUpOrders.status, 'planned'), window,
    ))))
  }
  if (f.language) c.push(eq(patients.preferredLanguage, f.language))
  if (f.pinCodePrefix) c.push(sql`${patients.pinCode} LIKE ${`${f.pinCodePrefix}%`}`)
  return c
}

/** Latest screening per patient (by screening id), narrowed to a trial when given. */
async function screeningStatusByPatient(trialId: string | undefined): Promise<Map<string, string | null>> {
  const rows = await getDb()
    .select({ patientId: patientTrialScreenings.patientId, overallStatus: patientTrialScreenings.overallStatus })
    .from(patientTrialScreenings)
    .where(trialId ? eq(patientTrialScreenings.trialId, trialId) : undefined)
    .orderBy(desc(patientTrialScreenings.id))
  const m = new Map<string, string | null>()
  for (const r of rows) if (!m.has(r.patientId)) m.set(r.patientId, r.overallStatus)
  return m
}

async function latestFormStatusByPatient(): Promise<Map<string, string>> {
  const rows = await getDb().select({ patientId: formSubmissions.patientId, status: formSubmissions.status }).from(formSubmissions).orderBy(desc(formSubmissions.sentDate))
  const m = new Map<string, string>()
  for (const r of rows) if (!m.has(r.patientId)) m.set(r.patientId, r.status)
  return m
}

/**
 * WS7 T10: every patient matching a broadcast's audience filters, each classified as send /
 * opted_out / no_phone. Used by the wizard preview and, again at send time, by the create route.
 * WS8 T13: archived charts are excluded in SQL; `archived` still reads patients.archived_at so a
 * chart archived between the query and the classification can never be classified `send`.
 * A trial filter keeps only patients with a screening for that trial; a screening-status filter
 * looks at each patient's most recent screening.
 */
export async function listBroadcastRecipientCandidates(filters: HospitalAudienceFilters, now: Date = new Date()): Promise<BroadcastAudienceMember[]> {
  const todayIso = todayIsoIn(undefined, now)
  const conds = hospitalConditions(filters, todayIso)
  const rows = await getDb()
    .select({
      id: patients.id, uhid: patients.uhid, name: patients.name, phone: patients.phone, email: patients.email,
      optedOut: patients.notificationOptOut, sms: patientNotificationPreferences.sms,
      archivedAt: patients.archivedAt, // WS8 T13
    })
    .from(patients)
    .leftJoin(patientNotificationPreferences, eq(patientNotificationPreferences.patientId, patients.id))
    .where(and(notArchived(), ...conds)) // WS8 T13
    .orderBy(asc(patients.id))

  let matched = rows
  if (filters.trialId || filters.overallStatus) {
    const screening = await screeningStatusByPatient(filters.trialId)
    matched = matched.filter((r) => screening.has(r.id) && (!filters.overallStatus || screening.get(r.id) === filters.overallStatus))
  }
  if (filters.formStatus) {
    const latest = await latestFormStatusByPatient()
    matched = matched.filter((r) => (filters.formStatus === 'none' ? !latest.has(r.id) : latest.get(r.id) === filters.formStatus))
  }

  return matched.map((r) => ({
    id: r.id, uhid: r.uhid, name: r.name, phone: r.phone, email: r.email,
    recipientClass: classifyRecipient({
      phone: r.phone ? normalizePhone(r.phone) : null,
      optedOut: r.optedOut,
      smsOff: r.sms === false,
      archived: r.archivedAt !== null, // WS8 T13
    }),
  }))
}

/** History view: the stored filters as readable phrases, with department/doctor/trial names. */
export async function describeBroadcastFilters(filters: HospitalAudienceFilters | null, opts: { trialsEnabled: boolean }): Promise<string[]> {
  if (!filters) return []
  const db = getDb()
  const [department] = filters.departmentId !== undefined ? await db.select({ name: departments.name }).from(departments).where(eq(departments.id, filters.departmentId)) : []
  const [provider] = filters.providerId !== undefined ? await db.select({ name: providers.name }).from(providers).where(eq(providers.id, filters.providerId)) : []
  const [trial] = filters.trialId && opts.trialsEnabled ? await db.select({ condition: trials.condition }).from(trials).where(eq(trials.id, filters.trialId)) : []
  const language = LANGUAGES.find((l) => l.code === filters.language)?.label ?? null
  return describeAudienceFilters(filters, { department: department?.name, provider: provider?.name, trial: trial?.condition, language }, opts)
}

/** Wizard options: active departments and doctors, and the hospital's wards. */
export async function listBroadcastFilterOptions() {
  const db = getDb()
  const [deps, docs, wardRows] = await Promise.all([
    db.select({ id: departments.id, name: departments.name }).from(departments).where(eq(departments.isActive, true)).orderBy(asc(departments.name)),
    db.select({ id: providers.id, name: providers.name }).from(providers).where(eq(providers.isActive, true)).orderBy(asc(providers.name)),
    db.selectDistinct({ ward: rooms.ward }).from(rooms).orderBy(asc(rooms.ward)),
  ])
  return { departments: deps, providers: docs, wards: wardRows.map((w) => w.ward) }
}

export interface SendBroadcastInput {
  message: string
  filters: HospitalAudienceFilters
  hospitalName: string
  sentBy: string
  /** The audience as classified at send time (listBroadcastRecipientCandidates). */
  audience: BroadcastAudienceMember[]
}

export interface SendBroadcastResult { id: number; recipientCount: number; sentCount: number; skippedCount: number; failedCount: number }

/** The same sender may not send the same message to the same filters again within this window. */
export const DUPLICATE_BROADCAST_WINDOW_MINUTES = 10

/** sendBroadcast refused a repeat (a retry or a double submit from two tabs); nothing was sent. */
export class DuplicateBroadcastError extends Error {
  readonly code = 'duplicate_broadcast'
  constructor(readonly existingId: number) {
    super('duplicate_broadcast')
    this.name = 'DuplicateBroadcastError'
  }
}

/**
 * WS7 T10: records the broadcast, then sends `broadcast_notice` to every sendable recipient
 * through sendNotification (one notification_log row per channel attempt, deduped per broadcast),
 * then stores the sent/skipped/failed counts. Opted-out and no-phone patients are never sent to
 * and count as skipped. A recipient whose send throws counts as failed; the rest still go out.
 * An identical message + filters from the same sender within DUPLICATE_BROADCAST_WINDOW_MINUTES
 * throws DuplicateBroadcastError before anything is recorded or sent: the check and the insert run
 * in one transaction under a per-sender advisory lock, so two concurrent submits cannot both pass.
 */
export async function sendBroadcast(input: SendBroadcastInput, deps?: SendNotificationDeps): Promise<SendBroadcastResult> {
  const db = getDb()
  const { filters } = input
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`broadcast:${input.sentBy}`}))`)
    const [dup] = await tx.select({ id: broadcasts.id }).from(broadcasts).where(and(
      eq(broadcasts.sentBy, input.sentBy),
      eq(broadcasts.message, input.message),
      sql`${broadcasts.filters} = ${JSON.stringify(filters)}::jsonb`,
      sql`${broadcasts.sentAt} > now() - make_interval(mins => ${DUPLICATE_BROADCAST_WINDOW_MINUTES}::int)`,
    )).orderBy(desc(broadcasts.id)).limit(1)
    if (dup) throw new DuplicateBroadcastError(dup.id)
    const [inserted] = await tx
      .insert(broadcasts)
      .values({
        subject: null,
        message: input.message,
        channel: 'sms',
        filterTrialId: filters.trialId ?? null,
        filterOverallStatus: filters.overallStatus ?? null,
        filterFormStatus: filters.formStatus ?? null,
        filters,
        templateKey: 'broadcast_notice',
        recipients: [],
        recipientCount: input.audience.length,
        sentBy: input.sentBy,
      })
      .returning({ id: broadcasts.id })
    return inserted
  })

  let sentCount = 0
  let skippedCount = 0
  let failedCount = 0
  const recipients: { patientId: string; patientName: string; deliveryStatus: 'delivered' | 'failed' }[] = []
  for (const m of input.audience) {
    if (m.recipientClass !== 'send') { skippedCount += 1; continue }
    let outcome: 'sent' | 'skipped' | 'failed'
    try {
      const r = await sendNotification({
        patientId: m.id,
        templateKey: 'broadcast_notice',
        vars: { hospitalName: input.hospitalName, message: input.message },
        destination: { ...(m.phone ? { phone: m.phone } : {}), ...(m.email ? { email: m.email } : {}) },
        dedupeKey: `broadcast:${row.id}`,
      }, deps)
      outcome = broadcastOutcome(r.attempts)
    } catch (err) {
      console.error(`[broadcast] send failed (${err instanceof Error ? err.name : typeof err})`)
      outcome = 'failed'
    }
    if (outcome === 'sent') sentCount += 1
    else if (outcome === 'failed') failedCount += 1
    else skippedCount += 1
    if (outcome !== 'skipped') recipients.push({ patientId: m.id, patientName: m.name, deliveryStatus: outcome === 'sent' ? 'delivered' : 'failed' })
  }

  await db.update(broadcasts).set({ sentCount, skippedCount, failedCount, recipients }).where(eq(broadcasts.id, row.id))
  return { id: row.id, recipientCount: input.audience.length, sentCount, skippedCount, failedCount }
}

export async function listBroadcasts() {
  return getOrSetCache(broadcastsListCacheKey(), 30, async () => {
    const rows = await getDb()
      .select({ broadcast: broadcasts, trial: trials })
      .from(broadcasts)
      .leftJoin(trials, eq(broadcasts.filterTrialId, trials.id))
      .orderBy(desc(broadcasts.sentAt))

    return rows.map((r) => ({ ...r.broadcast, trialCondition: r.trial?.condition ?? null }))
  })
}

export async function getBroadcast(id: number) {
  const [row] = await getDb()
    .select({ broadcast: broadcasts, trial: trials })
    .from(broadcasts)
    .leftJoin(trials, eq(broadcasts.filterTrialId, trials.id))
    .where(eq(broadcasts.id, id))
  if (!row) return null
  return { ...row.broadcast, trialCondition: row.trial?.condition ?? null }
}

export async function invalidateBroadcastsList() {
  await invalidateCache(broadcastsListCacheKey())
}

/**
 * Broadcasts are stored with a snapshotted `recipients` jsonb array rather
 * than a join table (see the schema comment), so "which broadcasts did this
 * patient get" is a full-table scan filtered in application code -- the same
 * pattern `listBroadcastRecipientCandidates` above already uses for its
 * formStatus filter. Only ever fetched from the patient portal, where the
 * broadcast list is small enough that this is fine. A failed delivery never
 * reached the patient, so it's excluded here even though it's on the row.
 */
export async function listBroadcastsForPatient(patientId: string) {
  const rows = await getDb().select().from(broadcasts).orderBy(desc(broadcasts.sentAt))
  return rows
    .filter((b) => b.recipients.some((r) => r.patientId === patientId && r.deliveryStatus === 'delivered'))
    .map((b) => ({ id: b.id, subject: b.subject, message: b.message, channel: b.channel, sentAt: b.sentAt }))
}
