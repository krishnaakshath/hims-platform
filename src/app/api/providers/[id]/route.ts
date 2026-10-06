import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { updateProviderName } from '@/lib/queries/providers'

const updateProviderSchema = z.object({
  name: z.string().trim().min(1),
}).strict()

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const { id } = await params
  const providerId = Number(id)
  if (!Number.isInteger(providerId)) return NextResponse.json({ error: 'Invalid provider id' }, { status: 400 })

  const parsed = updateProviderSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  const updated = await updateProviderName(providerId, parsed.data.name)
  if (!updated) return NextResponse.json({ error: 'Provider not found' }, { status: 404 })

  await logAudit(session, 'renamed provider profile', null)
  return NextResponse.json(updated)
}
