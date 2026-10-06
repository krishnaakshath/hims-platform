import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { detachConsentFromTemplate } from '@/lib/queries/form-template-consents'
import { invalidateFormTemplatesList } from '@/lib/queries/form-templates'

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string; consentDocumentId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc', 'pi'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id, consentDocumentId } = await params
  const templateId = Number(id)
  const docId = Number(consentDocumentId)
  if (!Number.isInteger(templateId) || !Number.isInteger(docId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const ok = await detachConsentFromTemplate(templateId, docId)
  if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await invalidateFormTemplatesList()
  await logAudit(session, `detached consent document from form template ${templateId}`, null)
  return NextResponse.json({ ok: true })
}
