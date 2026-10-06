import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getConsentDocumentWithCounts, updateConsentDocument } from '@/lib/queries/consent-documents'

const updateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  bodyText: z.string().min(1).optional(),
  legalReviewStatus: z.enum(['draft', 'reviewed']).optional(),
}).strict()

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc', 'pi'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  const doc = await getConsentDocumentWithCounts(Number(id))
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await logAudit(session, `viewed consent document ${id}`, null)
  return NextResponse.json(doc)
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc', 'pi'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params

  const parsed = updateSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid consent document payload', details: parsed.error.flatten() }, { status: 400 })

  const ok = await updateConsentDocument(Number(id), parsed.data)
  if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await logAudit(session, `updated consent document ${id}`, null)
  return NextResponse.json({ ok: true })
}
