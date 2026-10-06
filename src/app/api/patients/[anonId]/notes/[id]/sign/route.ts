import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { signNote } from '@/lib/queries/encounter-notes'

export async function PUT(request: NextRequest, { params }: { params: Promise<{ anonId: string; id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['pi', 'admin'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId, id } = await params
  const noteId = Number(id)
  if (!Number.isInteger(noteId)) return NextResponse.json({ error: 'Invalid note id' }, { status: 400 })

  const result = await signNote(noteId, anonId, session.name, session.role === 'admin')
  if (!result.ok) {
    const status = result.error === 'Note not found' ? 404 : result.error === 'Note is already signed' ? 409 : 403
    return NextResponse.json({ error: result.error }, { status })
  }

  await logAudit(session, 'signed encounter note', anonId)
  return NextResponse.json({ ok: true })
}
