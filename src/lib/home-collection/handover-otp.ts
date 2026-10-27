// WS6 T11: proof of sample handover at the door (spec D7). The collector sends a 6-digit code to the
// visit's contact phone; the patient reads it out once the samples are taken. The code comes from
// crypto.randomInt, is stored only as an scrypt hash (hashPassword), lives 15 minutes, and allows
// HANDOVER_OTP_MAX_ATTEMPTS wrong tries; a new send resets the attempts. The code never appears in
// a response, a log line, an audit row or notification_log (which stores no body or params).
import { randomInt } from 'crypto'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { homeCollectionVisits } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { getBrand } from '@/lib/brand-server'
import { collectorVisitRefusal } from '@/lib/home-collection/rules'
import { istDateOf } from '@/lib/india-time'
import { normalizePhone } from '@/lib/india/phone'
import { sendNotification, type NotificationAttempt } from '@/lib/notify/send'
import { hashPassword, verifyPassword } from '@/lib/password'

export const HANDOVER_OTP_TTL_MS = 15 * 60 * 1000
/** Wrong codes allowed per send; the next try is refused as locked. */
export const HANDOVER_OTP_MAX_ATTEMPTS = 5

export type HandoverOtpCheck = 'ok' | 'invalid' | 'expired' | 'locked'

/** Pure apart from the hash compare. No code on file counts as a wrong code. */
export function checkHandoverOtp(
  row: { hash: string | null; expiresAt: Date | null; attempts: number }, code: string, now: Date,
): HandoverOtpCheck {
  if (row.attempts >= HANDOVER_OTP_MAX_ATTEMPTS) return 'locked'
  if (row.hash === null || row.expiresAt === null) return 'invalid'
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired'
  if (!/^\d{6}$/.test(code)) return 'invalid'
  return verifyPassword(code, row.hash) ? 'ok' : 'invalid'
}

/** A uniformly random 6-digit code, leading zeros kept. */
export function generateHandoverOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export type HandoverChannelStatus = 'sent' | 'log_only' | 'skipped'

/** One status for the collector: sent on any channel, else logged only, else nothing went out. */
export function handoverChannelStatus(attempts: NotificationAttempt[]): HandoverChannelStatus {
  if (attempts.some((a) => a.status === 'sent')) return 'sent'
  if (attempts.some((a) => a.status === 'log_only')) return 'log_only'
  return 'skipped'
}

export type IssueHandoverOtpResult =
  | { ok: true; channelStatus: HandoverChannelStatus }
  | { ok: false; error: 'not_found' | 'not_assigned' | 'not_due' | 'not_collectable' | 'no_phone'; visitDate?: string }

/**
 * Issue a fresh code for a visit the session may act on today (the same door guard as collect):
 * one transaction locks the visit row, stores the hash, the 15-minute expiry and attempts = 0, and
 * writes the audit row (ids only). After it commits the code is sent with sendNotification to the
 * visit's contact phone; a send failure is reported as the channel status, never thrown.
 */
export async function issueHandoverOtp(visitId: number, session: Session, now: Date = new Date()): Promise<IssueHandoverOtpResult> {
  const code = generateHandoverOtp()
  const hash = hashPassword(code)
  const issued = await getDb().transaction(async (tx) => {
    const [visit] = await tx
      .select({
        patientId: homeCollectionVisits.patientId, status: homeCollectionVisits.status, collectorUserId: homeCollectionVisits.collectorUserId,
        visitDate: homeCollectionVisits.visitDate, contactPhone: homeCollectionVisits.contactPhone,
      })
      .from(homeCollectionVisits)
      .where(eq(homeCollectionVisits.id, visitId))
      .for('update')
    if (!visit) return { ok: false as const, error: 'not_found' as const }
    const refusal = collectorVisitRefusal(visit, session, istDateOf(now))
    if (refusal === 'not_due') return { ok: false as const, error: refusal, visitDate: visit.visitDate }
    if (refusal) return { ok: false as const, error: refusal }
    const phone = visit.contactPhone ? normalizePhone(visit.contactPhone) : null
    if (!phone) return { ok: false as const, error: 'no_phone' as const }
    await tx.update(homeCollectionVisits)
      .set({ handoverOtpHash: hash, handoverOtpExpiresAt: new Date(now.getTime() + HANDOVER_OTP_TTL_MS), handoverOtpAttempts: 0, updatedAt: now })
      .where(eq(homeCollectionVisits.id, visitId))
    await logAudit(session, 'sent home collection handover code', visit.patientId, `visit=${visitId}`, tx)
    return { ok: true as const, patientId: visit.patientId, phone }
  })
  if (!issued.ok) return issued

  try {
    // Spec D14 (WL): the SMS hospitalName is the resolved brand's SMS name (getBrand never throws).
    const { smsName } = await getBrand()
    const result = await sendNotification({
      patientId: issued.patientId,
      templateKey: 'home_collection_handover_otp',
      vars: { hospitalName: smsName, otp: code },
      destination: { phone: issued.phone },
    })
    return { ok: true, channelStatus: handoverChannelStatus(result.attempts) }
  } catch (err) {
    // The code is stored; nothing went out. Error class only, never the code or the phone.
    console.error(`[home-collection] handover code send failed (${err instanceof Error ? err.name : typeof err})`)
    return { ok: true, channelStatus: 'skipped' }
  }
}
