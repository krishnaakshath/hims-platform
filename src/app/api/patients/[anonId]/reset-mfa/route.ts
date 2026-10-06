import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { resetPatientMfa } from '@/lib/queries/patient-portal'
import { logAudit } from '@/lib/audit'

export async function POST(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const { anonId } = await params
  await resetPatientMfa(anonId)
  await logAudit(session, 'reset MFA for patient', anonId)

  return NextResponse.json({ ok: true })
}
