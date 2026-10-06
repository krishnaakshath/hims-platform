import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { formTemplates } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { getFormTemplate, invalidateFormTemplatesList } from '@/lib/queries/form-templates'
import { getFormTemplateFolder } from '@/lib/queries/form-template-folders'

const updateTemplateSchema = z.object({
  name: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  diagnosisTag: z.string().min(1).optional(),
  questions: z.array(z.object({
    id: z.string(), label: z.string(), type: z.enum(['text', 'textarea', 'date', 'select', 'checkbox']),
    options: z.array(z.string()).optional(), optionScores: z.array(z.number().nullable()).optional(),
    hipaaSensitive: z.boolean(), required: z.boolean(),
  }).refine((q) => !q.optionScores || q.optionScores.length === (q.options ?? []).length, {
    message: 'optionScores must have the same length as options',
    path: ['optionScores'],
  })).optional(),
  scoringRule: z.object({
    questionIds: z.array(z.string()),
    bands: z.array(z.object({ min: z.number(), max: z.number(), label: z.string() })),
  }).nullable().optional(),
  isActive: z.boolean().optional(),
  folderId: z.number().int().positive().nullable().optional(),
}).strict()

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  const template = await getFormTemplate(Number(id))
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await logAudit(session, `viewed form template ${id}`, null)
  return NextResponse.json(template)
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params

  const parsed = updateTemplateSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid template payload', details: parsed.error.flatten() }, { status: 400 })

  // A raw FK violation on a bad folderId would surface as an opaque 500;
  // check it explicitly so the client can tell "you sent a bad folder" from
  // "the server broke".
  if (typeof parsed.data.folderId === 'number' && !(await getFormTemplateFolder(parsed.data.folderId))) {
    return NextResponse.json({ error: 'No such folder' }, { status: 400 })
  }

  await getDb().update(formTemplates).set(parsed.data).where(eq(formTemplates.id, Number(id)))
  await invalidateFormTemplatesList()
  await logAudit(session, `updated form template ${id}`, null)
  return NextResponse.json({ ok: true })
}
