import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { createConsentDocument, listConsentDocumentsWithCounts } from '@/lib/queries/consent-documents'

const createSchema = z.object({
  name: z.string().trim().min(1),
  bodyText: z.string().min(1),
}).strict()

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc', 'pi'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const docs = await listConsentDocumentsWithCounts()
  await logAudit(session, 'viewed consent documents', null)
  return NextResponse.json(docs)
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc', 'pi'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid consent document payload', details: parsed.error.flatten() }, { status: 400 })

  const created = await createConsentDocument(parsed.data)
  await logAudit(session, 'created consent document', null)
  return NextResponse.json(created, { status: 201 })
}
