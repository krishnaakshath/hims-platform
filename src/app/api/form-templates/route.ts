import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { getDb } from '@/db/client'
import { formTemplates } from '@/db/schema'
import { requireSession } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { listFormTemplates, invalidateFormTemplatesList } from '@/lib/queries/form-templates'
import { getFormTemplateFolder } from '@/lib/queries/form-template-folders'
import { formTemplateBodySchema } from '@/lib/forms/question-model'

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
  const parsed = formTemplateBodySchema.safeParse(json.body)
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
