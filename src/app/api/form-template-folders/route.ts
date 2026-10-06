import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { invalidateFormTemplatesList } from '@/lib/queries/form-templates'
import { listFormTemplateFolders, createFormTemplateFolder } from '@/lib/queries/form-template-folders'

const createFolderSchema = z.object({
  name: z.string().trim().min(1),
}).strict()

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc', 'pi'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const folders = await listFormTemplateFolders()
  await logAudit(session, 'viewed form template folders', null)
  return NextResponse.json(folders)
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc', 'pi'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const parsed = createFolderSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid folder payload', details: parsed.error.flatten() }, { status: 400 })

  const created = await createFormTemplateFolder(parsed.data.name)
  // A new folder changes where a template can be filed, which the cached
  // /api/form-templates list (and anything reading folderId off it) must
  // reflect immediately, not after its 30-second TTL.
  await invalidateFormTemplatesList()
  await logAudit(session, 'created form template folder', null)
  return NextResponse.json(created, { status: 201 })
}
