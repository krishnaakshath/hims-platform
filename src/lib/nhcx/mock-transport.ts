import type { NhcxExchangeRow } from '@/db/schema'

// The labelled NHCX sandbox mock (ruling 1): reachable only for rows flagged
// is_mock, which exist only while mocksEnabled() (ABDM_USE_MOCKS=1 outside
// production). It accepts the message and feeds a synthesised insurer answer
// through the inbound pipeline (inbound.ts): eligibility in force, a queued
// pre-auth or claim. It never fabricates an approval amount.

export type MockTransport = { send(row: NhcxExchangeRow, fhir: object): Promise<void> }

export const mockTransport: MockTransport = {
  async send(row) {
    // Loaded lazily: inbound.ts depends on the exchange queries that use this transport.
    const { synthesizeMockResponse } = await import('./inbound')
    await synthesizeMockResponse(row)
  },
}
