import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { formTemplates } from '@/db/schema'
import { requireSession } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { listFormTemplates, invalidateFormTemplatesList } from '@/lib/queries/form-templates'
import { getFormTemplateFolder } from '@/lib/queries/form-template-folders'

const questionSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(['text', 'textarea', 'date', 'select', 'checkbox']),
  options: z.array(z.string()).optional(),
  optionScores: z.array(z.number().nullable()).optional(),
  hipaaSensitive: z.boolean(),
  required: z.boolean(),
}).refine((q) => !q.optionScores || q.optionScores.length === (q.options ?? []).length, {
  message: 'optionScores must have the same length as options',
  path: ['optionScores'],
})

const createTemplateSchema = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  diagnosisTag: z.string().min(1),
  questions: z.array(questionSchema),
  scoringRule: z.object({
    questionIds: z.array(z.string()),
    bands: z.array(z.object({ min: z.number(), max: z.number(), label: z.string() })),
  }).nullable().optional(),
  folderId: z.number().int().positive().nullable().optional(),
}).strict()

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  await logAudit(session, 'viewed form templates list', null)
  return NextResponse.json(await listFormTemplates())
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = createTemplateSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid template payload', details: parsed.error.flatten() }, { status: 400 })

  // A raw FK violation on a bad folderId would surface as an opaque 500;
  // check it explicitly so the client can tell "you sent a bad folder" from
  // "the server broke".
  if (typeof parsed.data.folderId === 'number' && !(await getFormTemplateFolder(parsed.data.folderId))) {
    return NextResponse.json({ error: 'No such folder' }, { status: 400 })
  }

  const [created] = await getDb().insert(formTemplates).values(parsed.data).returning()
  await invalidateFormTemplatesList()
  await logAudit(session, 'created form template', null)
  return NextResponse.json(created, { status: 201 })
}
