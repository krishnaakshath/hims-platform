import { NextRequest, NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { runNhcxSweep } from '@/lib/queries/nhcx-exchanges'
import { safeLog } from '@/lib/integrations/safe-log'

// SP8: the NHCX cron sweep (retries, optional polling, 7-day silence, share
// expiry, inbound-call purge). Session-less: `Authorization: Bearer
// <CRON_SECRET>` compared as SHA-256 digests (the LIS webhook pattern). Listed
// in tests/api/sessionless-routes.test.ts. The secret is never echoed.
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({ error: 'Cron is not configured' }, { status: 503 })
  const supplied = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/, '')
  const a = createHash('sha256').update(secret).digest()
  const b = createHash('sha256').update(supplied).digest()
  if (!supplied || !timingSafeEqual(a, b)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json(await runNhcxSweep(new Date()))
  } catch (err) {
    safeLog('nhcx-sweep', { outcome: 'failed', errorCode: err instanceof Error ? err.name : 'UnknownError' })
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
