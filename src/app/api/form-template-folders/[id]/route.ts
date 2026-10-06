import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { invalidateFormTemplatesList } from '@/lib/queries/form-templates'
import { renameFormTemplateFolder, deleteFormTemplateFolder } from '@/lib/queries/form-template-folders'

const renameFolderSchema = z.object({
  name: z.string().trim().min(1),
}).strict()

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc', 'pi'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { id } = await params

  const parsed = renameFolderSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid folder payload', details: parsed.error.flatten() }, { status: 400 })

  const renamed = await renameFormTemplateFolder(Number(id), parsed.data.name)
  if (!renamed) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await invalidateFormTemplatesList()
  await logAudit(session, `renamed form template folder ${id}`, null)
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc', 'pi'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { id } = await params

  const deleted = await deleteFormTemplateFolder(Number(id))
  if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await invalidateFormTemplatesList()
  await logAudit(session, `deleted form template folder ${id}`, null)
  return NextResponse.json({ ok: true })
}
