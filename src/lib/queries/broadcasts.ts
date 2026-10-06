import { getDb } from '@/db/client'
import { broadcasts, patients, patientTrialScreenings, formSubmissions, trials } from '@/db/schema'
import { eq, desc } from 'drizzle-orm'
import { getOrSetCache, invalidateCache, broadcastsListCacheKey } from '@/lib/cache'
import type { Verdict } from '@/lib/rule-engine'

export interface BroadcastRecipientFilters {
  trialId?: string
  overallStatus?: Verdict
  formStatus?: 'sent' | 'partial' | 'completed' | 'none'
}

export interface BroadcastRecipientCandidate {
  id: string
  name: string
  phone: string | null
  email: string | null
}

/**
 * Computes the live set of patients matching a broadcast's recipient filter.
 * Used by both the "Specify Recipients" wizard step (as a live preview,
 * before anything is sent) and by the create-broadcast route (to snapshot
 * the actual recipient list at send time).
 */
export async function listBroadcastRecipientCandidates(filters: BroadcastRecipientFilters): Promise<BroadcastRecipientCandidate[]> {
  const db = getDb()

  const rows = await db
    .select({ patient: patients, screening: patientTrialScreenings })
    .from(patients)
    .leftJoin(patientTrialScreenings, eq(patientTrialScreenings.patientId, patients.id))
    .where(filters.trialId ? eq(patientTrialScreenings.trialId, filters.trialId) : undefined)
    .orderBy(desc(patientTrialScreenings.id))

  // A patient can have multiple screening rows across trials; when no
  // trialId filter narrows the join, keep exactly one row per patient.
  // Rows are ordered by screening id descending above, so the first one
  // seen per patient below is deterministically that patient's most
  // recently created screening -- "most recent screening wins" is a real
  // product decision now, not an accident of Postgres's row order.
  const byPatient = new Map<string, { patient: typeof patients.$inferSelect; overallStatus?: Verdict }>()
  for (const r of rows) {
    if (!byPatient.has(r.patient.id)) {
      byPatient.set(r.patient.id, { patient: r.patient, overallStatus: r.screening?.overallStatus as Verdict | undefined })
    }
  }

  let candidates = [...byPatient.values()]
  if (filters.overallStatus) {
    candidates = candidates.filter((c) => c.overallStatus === filters.overallStatus)
  }

  if (filters.formStatus) {
    const submissions = await db.select().from(formSubmissions).orderBy(desc(formSubmissions.sentDate))
    const latestStatusByPatient = new Map<string, string>()
    for (const s of submissions) {
      // Rows are ordered by sentDate desc, so the first one seen per patient
      // is that patient's most recent form submission.
      if (!latestStatusByPatient.has(s.patientId)) latestStatusByPatient.set(s.patientId, s.status)
    }
    if (filters.formStatus === 'none') {
      candidates = candidates.filter((c) => !latestStatusByPatient.has(c.patient.id))
    } else {
      candidates = candidates.filter((c) => latestStatusByPatient.get(c.patient.id) === filters.formStatus)
    }
  }

  return candidates.map((c) => ({
    id: c.patient.id,
    name: c.patient.name,
    phone: c.patient.phone ?? null,
    email: c.patient.email ?? null,
  }))
}

/**
 * Simulated delivery: no real SMS/email provider is ever called. The rule
 * is deterministic and explainable for a demo: delivery "succeeds" only
 * when the patient actually has the contact method the channel needs on
 * file, rather than a random outcome.
 */
export function simulateBroadcastDelivery(channel: 'sms' | 'email' | 'both', phone: string | null, email: string | null): 'delivered' | 'failed' {
  if (channel === 'sms') return phone ? 'delivered' : 'failed'
  if (channel === 'email') return email ? 'delivered' : 'failed'
  return phone || email ? 'delivered' : 'failed'
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
