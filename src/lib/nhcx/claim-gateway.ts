import { randomUUID } from 'node:crypto'
import { CAPABILITY_LABEL, readNhcxConfig } from '@/lib/integrations/config'
import { safeLog } from '@/lib/integrations/safe-log'
import { nhcxGatewayStub, type ClaimGateway, type SubmissionPackage } from '@/lib/rcm/gateway'
import type { PayerRef, SnapshotPolicy } from '@/lib/rcm/snapshot'
import { buildClaimBundle, claimBundleProblems, type ClaimBundleContext } from '@/lib/fhir/nhcx/claim'
import { NHCX_BUILD_ERROR_COPY } from '@/lib/fhir/nhcx/resources'
import { validateNhcxBundle } from '@/lib/fhir/nhcx/validate'

// SP8 NhcxClaimGateway (plugs into SP7's ClaimGateway registry). submit() makes
// no network call: it checks that the snapshot can become a valid NHCX bundle
// and hands back a fresh correlation id. The send itself is an outbox row
// written in the submission transaction and dispatched after commit
// (nhcx-exchanges.ts). A refusal never blocks the manual channels.

/** Messages go to the TPA when the policy has one with an NHCX code (S3: address the processing entity), else the insurer (ruling 8). */
export function recipientCodeFor(policy: { insurer: PayerRef; tpa: PayerRef | null }): string | null {
  return policy.tpa?.nhcxParticipantCode || policy.insurer.nhcxParticipantCode || null
}

export function contextFromSnapshot(pkg: SubmissionPackage, now: Date = new Date()): ClaimBundleContext & { recipientCode: string | null } {
  const e = pkg.snapshot.episode
  return {
    created: now,
    practitioner: { name: e.attendingName ?? 'Treating doctor', registrationNumber: e.attendingRegistration },
    recipientCode: recipientCodeFor(pkg.snapshot.policy as SnapshotPolicy),
  }
}

export function nhcxClaimGateway(deps: {
  mode: 'configured' | 'mock'
  loadContext?: (pkg: SubmissionPackage) => Promise<ClaimBundleContext & { recipientCode: string | null }>
}): ClaimGateway {
  const load = deps.loadContext ?? (async (pkg: SubmissionPackage) => contextFromSnapshot(pkg))
  return {
    channel: 'nhcx',
    status: () => ({ configured: true, label: deps.mode === 'mock' ? `NHCX ${CAPABILITY_LABEL.mock.toLowerCase()}` : 'NHCX connected' }),
    async submit(pkg) {
      const ctx = await load(pkg)
      if (!ctx.recipientCode) return { ok: false, error: 'rejected', message: NHCX_BUILD_ERROR_COPY.payer_not_on_nhcx }
      const problems = claimBundleProblems(pkg.snapshot, ctx)
      if (problems.length > 0) return { ok: false, error: 'rejected', message: NHCX_BUILD_ERROR_COPY[problems[0]] }
      const invalid = validateNhcxBundle(buildClaimBundle(pkg.snapshot, ctx), 'ClaimBundle')
      if (invalid.length > 0) {
        safeLog('nhcx', { action: 'claim_gateway', outcome: 'invalid_bundle', count: invalid.length })
        return { ok: false, error: 'rejected', message: 'The claim could not be prepared for NHCX' }
      }
      return { ok: true, transport: 'nhcx', trackingReference: randomUUID() }
    },
  }
}

/** Configured or mock -> the NHCX gateway; otherwise SP7's not-configured stub. */
export function resolveNhcxClaimGateway(env: Record<string, string | undefined> = process.env): ClaimGateway {
  const cfg = readNhcxConfig(env)
  if (cfg.state === 'configured') return nhcxClaimGateway({ mode: 'configured' })
  if (cfg.state === 'mock') return nhcxClaimGateway({ mode: 'mock' })
  return nhcxGatewayStub
}
