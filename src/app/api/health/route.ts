import { NextResponse } from 'next/server'
import { cachedHealthReport } from '@/lib/config-check'

// Public liveness and diagnostics (no session; /api is outside the proxy
// matcher). Always 200 while the app is serving, with fixed status words
// only: { status, checks: { database, redis, migrations, secrets } }.
// Deploy gates use /api/health/ready, which answers 503 unless all pass.
export const dynamic = 'force-dynamic'

export async function GET() {
  const report = await cachedHealthReport()
  return NextResponse.json(report, { headers: { 'Cache-Control': 'no-store' } })
}
