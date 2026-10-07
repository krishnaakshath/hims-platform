import { NextRequest, NextResponse } from 'next/server'
import { parseId, readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { addCredential } from '@/lib/queries/staff-credentials'

const addCredentialSchema = z.object({
  credentialType: z.string().trim().min(1),
  credentialNumber: z.string().trim().min(1).nullable().optional(),
  expiresOn: z.string().nullable().optional(),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const { id } = await params
  const staffId = parseId(id)
  if (staffId === null) return NextResponse.json({ error: 'Invalid staff id' }, { status: 400 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = addCredentialSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  const result = await addCredential({
    staffMemberId: staffId,
    credentialType: parsed.data.credentialType,
    credentialNumber: parsed.data.credentialNumber ?? null,
    expiresOn: parsed.data.expiresOn ?? null,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 })

  await logAudit(session, 'added a staff credential', null)
  return NextResponse.json(result.credential, { status: 201 })
}
