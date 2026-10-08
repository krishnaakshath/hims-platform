import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { RCM_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { streamPrivateBlob } from '@/lib/blob-store'
import { getSubmissionCopy } from '@/lib/queries/claim-submissions'
import { parseId, rcmError } from '@/lib/rcm/route-responses'

// SP7 (ruling 3): download the retained RCM copy or the insurer copy of one version.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; copy: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!RCM_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const p = await params
  const id = parseId(p.id)
  if (id === null) return rcmError(400, 'Invalid submission id')
  if (p.copy !== 'rcm' && p.copy !== 'insurer') return rcmError(400, 'Unknown copy')
  const copy = await getSubmissionCopy(id, p.copy)
  if (!copy) return rcmError(404, 'Submission not found')
  const response = await streamPrivateBlob(copy.url, { filename: `${copy.claimNumber}-v${copy.version}-${p.copy}.pdf`, disposition: 'attachment' })
  if (!response) return rcmError(404, 'Stored file is missing')
  await logAudit(session, 'rcm: downloaded claim copy', copy.patientId, `claim=${copy.claimId} version=${copy.version} copy=${p.copy}`)
  return response
}
