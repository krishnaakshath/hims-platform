import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { listBroadcastRecipientCandidates } from '@/lib/queries/broadcasts'

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  // LeftNav.tsx:62 — { href: '/broadcasts', roles: ['admin', 'crc'] }
  if (!['admin', 'crc'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const url = new URL(request.url)
  const trialId = url.searchParams.get('trialId') ?? undefined
  const overallStatusParam = url.searchParams.get('overallStatus')
  const formStatusParam = url.searchParams.get('formStatus')
  const overallStatus = overallStatusParam === 'green' || overallStatusParam === 'yellow' || overallStatusParam === 'red' ? overallStatusParam : undefined
  const formStatus = formStatusParam === 'sent' || formStatusParam === 'partial' || formStatusParam === 'completed' || formStatusParam === 'none' ? formStatusParam : undefined

  const candidates = await listBroadcastRecipientCandidates({ trialId, overallStatus, formStatus })
  return NextResponse.json(candidates)
}
