import { randomBytes } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { formSubmissions } from '@/db/schema'
import { requireSession } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { listFormSubmissions } from '@/lib/queries/form-submissions'
import { copyTemplateConsentsToSubmission } from '@/lib/queries/form-submission-consents'

const sendFormSchema = z.object({
  templateId: z.number().int().positive(),
  patientId: z.string().min(1),
}).strict()

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const url = new URL(request.url)
  const filters = {
    diagnosisTag: url.searchParams.get('diagnosisTag') ?? undefined,
    status: (url.searchParams.get('status') as 'sent' | 'partial' | 'completed' | null) ?? undefined,
    dateFrom: url.searchParams.get('dateFrom') ?? undefined,
    dateTo: url.searchParams.get('dateTo') ?? undefined,
  }
  const submissions = await listFormSubmissions(filters)
  await logAudit(session, 'viewed client forms list', null)
  return NextResponse.json(submissions)
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = sendFormSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid send-form payload', details: parsed.error.flatten() }, { status: 400 })

  const accessToken = randomBytes(32).toString('base64url')
  const tokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days

  // One transaction: the submission row and its send-time consent snapshot
  // commit together. A submission left without its consent rows would pass
  // the completion gate with nothing to sign (fail open).
  const created = await getDb().transaction(async (tx) => {
    const [row] = await tx.insert(formSubmissions).values({ ...parsed.data, status: 'sent', accessToken, tokenExpiresAt }).returning()
    await copyTemplateConsentsToSubmission(parsed.data.templateId, row.id, tx)
    return row
  })
  await logAudit(session, 'sent intake form', parsed.data.patientId)
  return NextResponse.json(created, { status: 201 })
}
