import { and, asc, eq, gte, lt, or, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { abdmProfileShares, patients } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { isUniqueViolation } from '@/lib/db-errors'
import { istDateOf } from '@/lib/india-time'
import { formatAbhaNumber, isValidAbhaAddress, isValidAbhaNumber, normalizeAbhaAddress, normalizeAbhaNumber } from '@/lib/india/abha'
import { readAbdmConfig } from '@/lib/integrations/config'
import { safeLog } from '@/lib/integrations/safe-log'
import { logGatewayEvent } from '@/lib/integrations/system-audit'
import { ABDM_PATHS } from '@/lib/abdm/constants'
import { abdmHeaders, defaultSessionDeps, getGatewayToken, timeoutSignal, ABDM_TIMEOUT_MS, type SessionDeps } from '@/lib/abdm/session'
import { applyVerifiedAbhaTx } from './abha-link'

// ABHA Scan & Share (S1 hiecm-scan-and-register.yaml). A patient scans the
// desk QR code; ABDM calls our HIP bridge with their profile; we give a token
// number for the counter and acknowledge with on-share. The front desk then
// registers or links the patient. Unresolved shares are scrubbed after 24 h
// (SP8 ruling 4). Audit details carry ids and enum values only.

export type ShareProfile = {
  abhaNumber: string | null
  abhaAddress: string | null
  name: string | null
  gender: string | null
  yearOfBirth: number | null
  monthOfBirth: number | null
  dayOfBirth: number | null
  phone: string | null
  addressLine: string | null
  districtName: string | null
  stateName: string | null
  pincode: string | null
}

export const SHARE_RETENTION_MS = 24 * 60 * 60 * 1000
/** on-share `profile.expiry` (seconds). Meaning and unit are UNVERIFIED U17. */
export const ON_SHARE_EXPIRY = 1800

const clip = (v: string | null, n: number) => (v == null ? null : v.trim().slice(0, n) || null)

/** Normalises a shared profile: an invalid ABHA number or address is dropped, never guessed. */
export function normaliseShareProfile(p: ShareProfile): ShareProfile {
  const abhaNumber = p.abhaNumber && isValidAbhaNumber(p.abhaNumber) ? normalizeAbhaNumber(p.abhaNumber) : null
  const abhaAddress = p.abhaAddress && isValidAbhaAddress(p.abhaAddress) ? normalizeAbhaAddress(p.abhaAddress) : null
  return {
    abhaNumber,
    abhaAddress,
    name: clip(p.name, 200),
    gender: p.gender && /^[MFOT]$/.test(p.gender) ? p.gender : null,
    yearOfBirth: p.yearOfBirth,
    monthOfBirth: p.monthOfBirth,
    dayOfBirth: p.dayOfBirth,
    phone: p.phone ? p.phone.replace(/\D/g, '').slice(-10) || null : null,
    addressLine: clip(p.addressLine, 300),
    districtName: clip(p.districtName, 100),
    stateName: clip(p.stateName, 100),
    pincode: p.pincode && /^\d{6}$/.test(p.pincode.trim()) ? p.pincode.trim() : null,
  }
}

export async function recordProfileShare(
  input: { requestId: string; hipId: string; counterId: string; intent: string; profile: ShareProfile; isMock: boolean },
  now: Date = new Date(),
): Promise<{ shareId: number; tokenNumber: number; duplicate: boolean }> {
  const tokenDate = istDateOf(now)
  const existing = async () => {
    const [row] = await getDb().select({ id: abdmProfileShares.id, tokenNumber: abdmProfileShares.tokenNumber })
      .from(abdmProfileShares).where(eq(abdmProfileShares.requestId, input.requestId))
    return row ? { shareId: row.id, tokenNumber: row.tokenNumber, duplicate: true } : null
  }
  const seen = await existing()
  if (seen) return seen
  try {
    return await getDb().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`abdm:token:${tokenDate}:${input.counterId}`}))`)
      const [dupe] = await tx.select({ id: abdmProfileShares.id, tokenNumber: abdmProfileShares.tokenNumber })
        .from(abdmProfileShares).where(eq(abdmProfileShares.requestId, input.requestId))
      if (dupe) return { shareId: dupe.id, tokenNumber: dupe.tokenNumber, duplicate: true }
      const [{ next }] = (await tx.execute<{ next: number }>(sql`
        select coalesce(max(token_number), 0)::int + 1 as next from abdm_profile_shares
        where token_date = ${tokenDate} and counter_id = ${input.counterId}`)).rows
      const p = normaliseShareProfile(input.profile)
      const [row] = await tx.insert(abdmProfileShares).values({
        requestId: input.requestId, hipId: input.hipId, counterId: input.counterId, intent: input.intent,
        ...p, tokenDate, tokenNumber: next, isMock: input.isMock, receivedAt: now,
      }).returning({ id: abdmProfileShares.id })
      await logGatewayEvent('ABDM gateway', 'abdm: received profile share', null, `share=${row.id} counter=${input.counterId} intent=${input.intent}`, tx)
      return { shareId: row.id, tokenNumber: next, duplicate: false }
    })
  } catch (e) {
    // Two deliveries of the same request racing: the loser reads the winner.
    if (isUniqueViolation(e, 'abdm_profile_shares_request_unique')) {
      const again = await existing()
      if (again) return again
    }
    throw e
  }
}

/** Acknowledges a share to ABDM with its token number (S1 on-share). Never inside a transaction. */
export async function sendOnShare(shareId: number, deps: SessionDeps = defaultSessionDeps()): Promise<void> {
  const cfg = readAbdmConfig()
  if (cfg.state !== 'configured') return
  const [row] = await getDb().select({
    requestId: abdmProfileShares.requestId, counterId: abdmProfileShares.counterId, tokenNumber: abdmProfileShares.tokenNumber, abhaAddress: abdmProfileShares.abhaAddress,
  }).from(abdmProfileShares).where(eq(abdmProfileShares.id, shareId))
  if (!row) return
  let state: 'sent' | 'failed' = 'failed'
  try {
    const token = await getGatewayToken(cfg.config, deps)
    const res = await deps.fetch(`${cfg.config.gatewayBaseUrl}${ABDM_PATHS.onShare}`, {
      method: 'POST',
      headers: abdmHeaders({ 'X-CM-ID': cfg.config.cmId, Authorization: `Bearer ${token}` }, deps.now()),
      body: JSON.stringify({
        acknowledgement: { status: 'SUCCESS', abhaAddress: row.abhaAddress, profile: { context: row.counterId, tokenNumber: String(row.tokenNumber), expiry: ON_SHARE_EXPIRY } },
        response: { requestId: row.requestId },
      }),
      signal: timeoutSignal(ABDM_TIMEOUT_MS),
    })
    state = res.ok ? 'sent' : 'failed'
    safeLog('abdm', { action: 'on_share', shareId, httpStatus: res.status })
  } catch {
    safeLog('abdm', { action: 'on_share', shareId, outcome: 'unreachable' })
  }
  await getDb().update(abdmProfileShares).set({ ackState: state }).where(eq(abdmProfileShares.id, shareId))
}

export type ShareQueueRow = {
  id: number
  tokenNumber: number
  counterId: string
  name: string | null
  gender: string | null
  yearOfBirth: number | null
  abhaMasked: string | null
  abhaAddress: string | null
  receivedAt: string
  isMock: boolean
  existingPatientId: string | null
  existingPatientUhid: string | null
}

/** Pending shares from the last 24 h, by token. The ABHA number is masked. */
export async function listPendingShares(now: Date = new Date()): Promise<ShareQueueRow[]> {
  const since = new Date(now.getTime() - SHARE_RETENTION_MS)
  const rows = await getDb().select().from(abdmProfileShares)
    .where(and(eq(abdmProfileShares.status, 'pending'), gte(abdmProfileShares.receivedAt, since)))
    .orderBy(asc(abdmProfileShares.tokenDate), asc(abdmProfileShares.counterId), asc(abdmProfileShares.tokenNumber))
  const out: ShareQueueRow[] = []
  for (const r of rows) {
    const match = r.abhaNumber || r.abhaAddress
      ? (await getDb().select({ id: patients.id, uhid: patients.uhid }).from(patients).where(or(
          r.abhaNumber ? eq(patients.abhaNumber, r.abhaNumber) : sql`false`,
          r.abhaAddress ? eq(patients.abhaAddress, r.abhaAddress) : sql`false`,
        )).limit(1))[0]
      : undefined
    out.push({
      id: r.id, tokenNumber: r.tokenNumber, counterId: r.counterId, name: r.name, gender: r.gender, yearOfBirth: r.yearOfBirth,
      abhaMasked: r.abhaNumber ? `XX-XXXX-XXXX-${r.abhaNumber.slice(-4)}` : null, abhaAddress: r.abhaAddress,
      receivedAt: r.receivedAt.toISOString(), isMock: r.isMock, existingPatientId: match?.id ?? null, existingPatientUhid: match?.uhid ?? null,
    })
  }
  return out
}

export type SharePrefill = {
  name: string | null
  gender: string | null
  dob: string | null
  phone: string | null
  abhaNumber: string | null
  abhaAddress: string | null
  addressLine: string | null
  district: string | null
  stateName: string | null
  pinCode: string | null
}

/** The registration prefill of one pending share (full ABHA number; registration roles only). */
export async function getSharePrefill(shareId: number): Promise<SharePrefill | null> {
  const [r] = await getDb().select().from(abdmProfileShares).where(and(eq(abdmProfileShares.id, shareId), eq(abdmProfileShares.status, 'pending')))
  if (!r) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  const dob = r.yearOfBirth && r.monthOfBirth && r.dayOfBirth ? `${r.yearOfBirth}-${pad(r.monthOfBirth)}-${pad(r.dayOfBirth)}` : null
  return {
    name: r.name, gender: r.gender, dob, phone: r.phone,
    abhaNumber: r.abhaNumber ? formatAbhaNumber(r.abhaNumber) : null, abhaAddress: r.abhaAddress,
    addressLine: r.addressLine, district: r.districtName, stateName: r.stateName, pinCode: r.pincode,
  }
}

export type ResolveShareError = 'not_found' | 'already_resolved' | 'patient_required' | 'abha_conflict' | 'abha_missing'

/**
 * Resolves a pending share. `linked`: the share's ABHA is verified onto an
 * existing patient (via scan_and_share). `registered`: the patient was just
 * registered from the share; the verification columns are stamped when the
 * registered ABHA number is the shared one. `dismissed`: the profile is
 * scrubbed. Audit 'abdm: resolved profile share'.
 */
export async function resolveShare(
  shareId: number,
  input: { action: 'registered' | 'linked' | 'dismissed'; patientId?: string },
  session: Session,
): Promise<{ ok: true } | { ok: false; error: ResolveShareError }> {
  if (input.action !== 'dismissed' && !input.patientId) return { ok: false, error: 'patient_required' }
  try {
    return await getDb().transaction(async (tx) => {
      const [share] = await tx.select().from(abdmProfileShares).where(eq(abdmProfileShares.id, shareId)).for('update')
      if (!share) return { ok: false as const, error: 'not_found' as const }
      if (share.status !== 'pending') return { ok: false as const, error: 'already_resolved' as const }
      const source = share.isMock ? 'abdm_sandbox_mock' as const : 'abdm' as const
      const patientId = input.patientId ?? null

      if (input.action === 'linked') {
        if (!share.abhaNumber) return { ok: false as const, error: 'abha_missing' as const }
        const r = await applyVerifiedAbhaTx(tx, patientId!, { abhaNumber: share.abhaNumber, abhaAddress: share.abhaAddress, via: 'scan_and_share', source }, null, session)
        if (r === 'not_found') return { ok: false as const, error: 'not_found' as const }
      } else if (input.action === 'registered') {
        const [p] = await tx.select({ abhaNumber: patients.abhaNumber }).from(patients).where(eq(patients.id, patientId!)).for('update')
        if (!p) return { ok: false as const, error: 'not_found' as const }
        if (share.abhaNumber && p.abhaNumber === share.abhaNumber) {
          await tx.update(patients).set({ abhaVerifiedAt: new Date(), abhaVerificationSource: source, abhaVerifiedVia: 'scan_and_share' }).where(eq(patients.id, patientId!))
          await logAudit(session, 'abdm: verified ABHA', patientId, `patient=${patientId} via=scan_and_share source=${source}`, tx)
        }
      }

      const status = input.action
      await tx.update(abdmProfileShares).set({
        status, patientId, resolvedAt: new Date(), resolvedByName: session.name,
        // A dismissed share keeps no profile (ruling 4).
        ...(status === 'dismissed' ? scrubbed : {}),
      }).where(eq(abdmProfileShares.id, shareId))
      await logAudit(session, 'abdm: resolved profile share', patientId, `share=${shareId} action=${status}`, tx)
      return { ok: true as const }
    })
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'abha_conflict' }
    throw e
  }
}

const scrubbed = {
  abhaNumber: null, abhaAddress: null, name: null, gender: null, yearOfBirth: null, monthOfBirth: null, dayOfBirth: null,
  phone: null, addressLine: null, districtName: null, stateName: null, pincode: null,
} as const

/** Pending shares older than 24 h become 'expired' with every profile column cleared. Returns the count. */
export async function expireShares(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - SHARE_RETENTION_MS)
  const rows = await getDb().update(abdmProfileShares).set({ status: 'expired', ...scrubbed })
    .where(and(eq(abdmProfileShares.status, 'pending'), lt(abdmProfileShares.receivedAt, cutoff)))
    .returning({ id: abdmProfileShares.id })
  return rows.length
}

/** What the share queue page shows about the desk QR code (no secrets). */
export function scanShareSetup(): { state: 'configured' | 'mock' | 'not_configured'; qrUrlTemplate: string | null } {
  const cfg = readAbdmConfig()
  if (cfg.state === 'mock') return { state: 'mock', qrUrlTemplate: null }
  if (cfg.state !== 'configured' || !cfg.config.hipId || !cfg.config.gatewayJwksUrl) return { state: 'not_configured', qrUrlTemplate: null }
  // Sandbox host (S1); the production host is UNVERIFIED (U12).
  return { state: 'configured', qrUrlTemplate: `https://phrsbx.abdm.gov.in/share-profile?hip-id=${encodeURIComponent(cfg.config.hipId)}&counter-id=<COUNTER>` }
}
