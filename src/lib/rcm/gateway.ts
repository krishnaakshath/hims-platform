// SP7 ClaimGateway (pure). Ruling 4: manual now, gateway-shaped. Manual channels record the
// dispatch; NHCX reports "not configured" and refuses (no mock here: spec §3 "No fake data
// in production"). SP8 registers the real NHCX adapter and its env-flagged mock through
// getClaimGateway's registry.
import { CHANNEL_LABEL, type SubmissionChannel, type SubmissionKind } from './constants'
import { RCM_ERROR_MESSAGE } from './errors'
import type { ClaimSnapshot } from './snapshot'

export interface SubmissionPackage { claimNumber: string; version: number; kind: SubmissionKind; snapshot: ClaimSnapshot; insurerCopySha256: string; trackingReference: string | null }
export type GatewaySubmitResult =
  | { ok: true; transport: 'manual' | 'nhcx'; trackingReference: string | null }
  | { ok: false; error: 'not_configured' | 'rejected'; message: string }
export interface ClaimGateway {
  readonly channel: SubmissionChannel
  status(): { configured: boolean; label: string }
  submit(pkg: SubmissionPackage): Promise<GatewaySubmitResult>
}

export function manualGateway(channel: Exclude<SubmissionChannel, 'nhcx'>): ClaimGateway {
  return {
    channel,
    status: () => ({ configured: true, label: `Recorded manually (${CHANNEL_LABEL[channel]})` }),
    submit: async (pkg) => ({ ok: true, transport: 'manual', trackingReference: pkg.trackingReference }),
  }
}

export const nhcxGatewayStub: ClaimGateway = {
  channel: 'nhcx',
  status: () => ({ configured: false, label: 'NHCX not connected (planned)' }),
  submit: async () => ({ ok: false, error: 'not_configured', message: RCM_ERROR_MESSAGE.gateway_not_configured }),
}

export function getClaimGateway(channel: SubmissionChannel, registry?: Partial<Record<SubmissionChannel, ClaimGateway>>): ClaimGateway {
  const registered = registry?.[channel]
  if (registered) return registered
  return channel === 'nhcx' ? nhcxGatewayStub : manualGateway(channel)
}
