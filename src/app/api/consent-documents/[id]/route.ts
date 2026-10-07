import { NextRequest, NextResponse } from 'next/server'
import { parseId, readJsonBody } from '@/lib/http'
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
  const numericId = parseId(id)
  if (numericId === null) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const doc = await getConsentDocumentWithCounts(numericId)
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await logAudit(session, `viewed consent document ${id}`, null)
  return NextResponse.json(doc)
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc', 'pi'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = updateSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid consent document payload', details: parsed.error.flatten() }, { status: 400 })

  const numericId = parseId(id)
  if (numericId === null) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const ok = await updateConsentDocument(numericId, parsed.data)
  if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await logAudit(session, `updated consent document ${id}`, null)
  return NextResponse.json({ ok: true })
}
