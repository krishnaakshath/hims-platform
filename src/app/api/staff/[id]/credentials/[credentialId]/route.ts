import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { updateCredential } from '@/lib/queries/staff-credentials'

// Fix B (final whole-branch review, Important #2): matches this module's
// existing admin-only write gate (see PATCH /api/staff/[id], POST
// /api/staff/[id]/credentials). Scoped to the 3 columns staff_credentials
// actually has beyond id/staffMemberId (src/db/schema.ts): credentialType,
// credentialNumber, expiresOn -- there is no separate "status" column, the
// expiring/expired/current status is derived from expiresOn.
const updateCredentialSchema = z.object({
  credentialType: z.string().trim().min(1).optional(),
  credentialNumber: z.string().trim().min(1).nullable().optional(),
  expiresOn: z.string().nullable().optional(),
}).strict()

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; credentialId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const { credentialId } = await params
  const parsedCredentialId = Number(credentialId)
  if (!Number.isInteger(parsedCredentialId)) return NextResponse.json({ error: 'Invalid credential id' }, { status: 400 })

  const parsed = updateCredentialSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  const result = await updateCredential(parsedCredentialId, parsed.data)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 })

  await logAudit(session, 'updated a staff credential', null)
  return NextResponse.json(result.credential)
}
