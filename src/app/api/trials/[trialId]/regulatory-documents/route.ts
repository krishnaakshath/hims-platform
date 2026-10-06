import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listRegulatoryDocuments, createRegulatoryDocument } from '@/lib/queries/trial-compliance'

const ALLOWED_ROLES = ['crc', 'pi', 'admin']

const createSchema = z.object({
  documentType: z.enum(['form_1572', 'delegation_log', 'irb_approval', 'informed_consent_template', 'protocol', 'investigator_brochure', 'other']),
  title: z.string().trim().min(1),
  version: z.string().trim().optional(),
  effectiveDate: z.string().min(1),
  expirationDate: z.string().min(1).optional(),
}).strict()

export async function GET(request: NextRequest, { params }: { params: Promise<{ trialId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ALLOWED_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { trialId } = await params
  const documents = await listRegulatoryDocuments(trialId)
  return NextResponse.json({ documents })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ trialId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ALLOWED_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { trialId } = await params
  const parsed = createSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid regulatory document payload', details: parsed.error.flatten() }, { status: 400 })

  const created = await createRegulatoryDocument({ trialId, uploadedByName: session.name, ...parsed.data })
  await logAudit(session, `added a ${parsed.data.documentType} regulatory document for trial ${trialId}`, null)
  return NextResponse.json(created, { status: 201 })
}
