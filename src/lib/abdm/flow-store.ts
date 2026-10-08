import { randomUUID } from 'node:crypto'
import { getRedis } from '@/lib/cache'
import { openPayload, sealPayload } from '@/lib/integrations/payload-vault'
import type { AbdmConsentPurpose, AbhaVerificationSource, AbhaVerifiedVia } from './constants'
import type { LoginRoute } from './gateway'

// Short-lived state of one ABHA create/verify flow, between the staff
// member's steps. Redis key `abdm:flow:<flowId>`, the value sealed with the
// integration payload key, TTL 900 s (under ABDM's 1800 s token life, S1).
//
// The type is the guard: there is no field that can hold a national ID
// number or an OTP. ABDM user and transient tokens live only here (ruling 4).
// A flow belongs to the staff member who started it; anyone else gets null.

export const FLOW_TTL_SECONDS = 900

export interface AbhaFlow {
  flowId: string
  staffName: string
  staffUserId: number | null
  patientId: string | null
  kind: 'enrolment' | LoginRoute | null
  txnId: string | null
  userToken: string | null
  transientToken: string | null
  consentId: number | null
  consentPurpose: AbdmConsentPurpose | null
  verified: { abhaNumber: string; abhaAddress: string | null; via: AbhaVerifiedVia; source: AbhaVerificationSource } | null
  /** Normalised 14-digit ABHA numbers offered by a mobile login, in the order shown. */
  accounts: string[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const key = (flowId: string) => `abdm:flow:${flowId}`

export async function saveFlow(flow: AbhaFlow): Promise<void> {
  await getRedis().set(key(flow.flowId), sealPayload(JSON.stringify(flow)), { ex: FLOW_TTL_SECONDS })
}

export async function createFlow(init: Pick<AbhaFlow, 'staffName' | 'staffUserId' | 'patientId' | 'kind'>): Promise<AbhaFlow> {
  const flow: AbhaFlow = {
    flowId: randomUUID(),
    staffName: init.staffName,
    staffUserId: init.staffUserId,
    patientId: init.patientId,
    kind: init.kind,
    txnId: null,
    userToken: null,
    transientToken: null,
    consentId: null,
    consentPurpose: null,
    verified: null,
    accounts: [],
  }
  await saveFlow(flow)
  return flow
}

export async function getFlow(flowId: string, staffName: string): Promise<AbhaFlow | null> {
  if (!UUID.test(flowId)) return null
  const raw = await getRedis().get<string>(key(flowId))
  if (typeof raw !== 'string') return null
  let flow: AbhaFlow
  try {
    flow = JSON.parse(openPayload(raw)) as AbhaFlow
  } catch {
    return null
  }
  return flow.flowId === flowId && flow.staffName === staffName ? flow : null
}

export async function deleteFlow(flowId: string): Promise<void> {
  if (!UUID.test(flowId)) return
  await getRedis().del(key(flowId))
}
