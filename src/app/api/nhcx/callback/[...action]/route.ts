import { NextRequest, NextResponse } from 'next/server'
import { handleNhcxCallback } from '@/lib/nhcx/inbound'

// SP8: the NHCX callback endpoint (`endpoint_url` = <app>/api/nhcx/callback).
// Session-less by design (listed in tests/api/sessionless-routes.test.ts); its
// security pipeline is in src/lib/nhcx/inbound.ts. Fixed bodies only.
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const { action } = await params
  const r = await handleNhcxCallback(request, action.join('/'))
  return NextResponse.json(r.body, { status: r.http })
}

const notAllowed = () => NextResponse.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } })
export const GET = notAllowed
export const PUT = notAllowed
export const PATCH = notAllowed
export const DELETE = notAllowed
