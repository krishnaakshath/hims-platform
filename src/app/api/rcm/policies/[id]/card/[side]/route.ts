import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { POLICY_READ_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { streamPrivateBlob } from '@/lib/blob-store'
import { getPolicyCardBlob } from '@/lib/queries/rcm-policies'
import { parseId, rcmError } from '@/lib/rcm/route-responses'

// SP7: stream a stored policy-card image inline (audited after a successful read).
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; side: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!POLICY_READ_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const p = await params
  const id = parseId(p.id)
  if (id === null) return rcmError(400, 'Invalid policy id')
  if (p.side !== 'front' && p.side !== 'back') return rcmError(400, 'Choose the front or back of the card')

  const card = await getPolicyCardBlob(id, p.side)
  if (!card) return rcmError(404, 'Card image not found')
  const response = await streamPrivateBlob(card.url, { filename: `policy-${id}-${p.side}`, disposition: 'inline' })
  if (!response) return rcmError(404, 'Stored file is missing')
  await logAudit(session, 'rcm: viewed policy card', card.patientId, `policy=${id} side=${p.side}`)
  return response
}
