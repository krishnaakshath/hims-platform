import { NextRequest, NextResponse } from 'next/server'
import { confirmScreeningSelection } from '@/lib/queries/eligibility'
import { logAudit } from '@/lib/audit'
import { requireSession } from '@/lib/auth'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'

// Bodyless -- confirms the current green screening verdict for this patient
// and (via confirmScreeningSelection) sends the patient their selection
// notification.
export async function POST(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  // Confirming a trial-eligibility verdict is a clinical judgment call, not
  // a logistics/registration task (spec §9) -- frontdesk can see the chart
  // but doesn't own this decision, so it's excluded from the role gate.
  if (!['admin', 'pi', 'crc'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params
  const result = await confirmScreeningSelection(anonId, session.name)

  if (!result.ok) {
    if (result.reason === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (result.reason === 'not_green') return NextResponse.json({ error: 'Cannot confirm — screening is not currently green' }, { status: 409 })
    if (result.reason === 'already_confirmed') return NextResponse.json({ error: 'Already confirmed' }, { status: 409 })
    return NextResponse.json({ error: 'Cannot confirm — this screening\'s trial could not be resolved' }, { status: 409 })
  }

  await invalidateCache(patientDetailCacheKey(anonId))
  await logAudit(session, 'confirmed trial eligibility and notified patient', anonId)

  return NextResponse.json({ ok: true, confirmedAt: result.confirmedAt, notifiedAt: result.notifiedAt })
}
