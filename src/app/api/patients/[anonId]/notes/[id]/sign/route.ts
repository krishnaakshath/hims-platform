import { NextRequest, NextResponse } from 'next/server'
import { parseId, readJsonBody } from '@/lib/http'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { noteSignSchema, signNote } from '@/lib/queries/encounter-notes'

// WS1 T5 (spec ruling 10): the body is { typedName, attestation: true } (strict); a body-less PUT
// is 400. The typed name must equal the signer's own name (admin exempt, as discharge). The audit
// row carries the note id only, never note text or the typed name.
export async function PUT(request: NextRequest, { params }: { params: Promise<{ anonId: string; id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['pi', 'admin'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = noteSignSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Type your name and tick the attestation to sign' }, { status: 400 })

  const { anonId, id } = await params
  const noteId = parseId(id)
  if (noteId === null) return NextResponse.json({ error: 'Invalid note id' }, { status: 400 })

  const result = await signNote(noteId, anonId, { typedName: parsed.data.typedName, session })
  if (!result.ok) {
    const status = result.error === 'Note not found' ? 404 : result.error === 'Note is already signed' ? 409 : 403
    return NextResponse.json({ error: result.error }, { status })
  }

  await logAudit(session, 'signed encounter note', anonId, `note=${noteId} signature=${result.signatureId}`)
  return NextResponse.json({ ok: true })
}
