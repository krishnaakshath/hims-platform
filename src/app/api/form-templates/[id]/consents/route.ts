import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { attachConsentToTemplate, listConsentsForTemplate } from '@/lib/queries/form-template-consents'
import { getFormTemplate, invalidateFormTemplatesList } from '@/lib/queries/form-templates'

const attachSchema = z.object({ consentDocumentId: z.number().int().positive() }).strict()

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc', 'pi'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  const templateId = Number(id)
  if (!Number.isInteger(templateId) || !(await getFormTemplate(templateId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(await listConsentsForTemplate(templateId))
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc', 'pi'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  const templateId = Number(id)
  if (!Number.isInteger(templateId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const parsed = attachSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid attach payload', details: parsed.error.flatten() }, { status: 400 })

  const result = await attachConsentToTemplate(templateId, parsed.data.consentDocumentId)
  if (!result.ok) {
    if (result.reason === 'no_such_template') return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (result.reason === 'no_such_document') return NextResponse.json({ error: 'No such consent document' }, { status: 400 })
    return NextResponse.json({ error: 'This consent document is already attached to this form' }, { status: 409 })
  }
  await invalidateFormTemplatesList()
  await logAudit(session, `attached consent document to form template ${templateId}`, null)
  return NextResponse.json({ formTemplateConsentId: result.formTemplateConsentId }, { status: 201 })
}
