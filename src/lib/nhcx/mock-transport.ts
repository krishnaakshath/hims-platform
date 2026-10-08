import type { NhcxExchangeRow } from '@/db/schema'

// The labelled NHCX sandbox mock (ruling 1): reachable only for rows flagged
// is_mock, which exist only while mocksEnabled() (ABDM_USE_MOCKS=1 outside
// production). It accepts the message; the synthesised insurer answer (Task
// 12) is fed in by `respond`, registered by the inbound module, and never
// carries an approval amount.

export type MockTransport = { send(row: NhcxExchangeRow, fhir: object): Promise<void> }

let responder: ((row: NhcxExchangeRow) => Promise<void>) | null = null

/** Registers the synthesised-response hook (inbound.ts). */
export function setMockResponder(fn: ((row: NhcxExchangeRow) => Promise<void>) | null): void {
  responder = fn
}

export const mockTransport: MockTransport = {
  async send(row) {
    if (responder) await responder(row)
  },
}
