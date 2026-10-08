import { NextResponse } from 'next/server'
import { cachedHealthReport } from '@/lib/config-check'

// Readiness for deploys and uptime monitors: 200 only when the database and
// Redis answer, every migration is applied, the required secrets are set and
// the blob store is configured;
// otherwise 503 with the same fixed-word report as /api/health.
export const dynamic = 'force-dynamic'

export async function GET() {
  const report = await cachedHealthReport()
  return NextResponse.json(report, {
    status: report.status === 'ok' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  })
}
