import type { NhcxExchangeRow } from '@/db/schema'
import type { OutboundBuild } from './nhcx-exchanges'

// SP8 Task 15 fills this in (response review and the payment acknowledgement).
export async function buildPaymentAckOutbound(_row: NhcxExchangeRow, _now: Date): Promise<OutboundBuild> {
  void _row; void _now
  return { ok: false, code: 'snapshot_missing' }
}
