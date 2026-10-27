import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { parseId, readJsonBody } from '@/lib/http'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import {
  checkNoteSignable,
  signNote,
  NOTE_NOT_FOUND,
  NOTE_ALREADY_SIGNED,
  NOTE_ATTESTATION,
  SIGN_NOTE_ATTESTATION,
} from '@/lib/queries/encounter-notes'
import { reauthenticate, reauthIdentity } from '@/lib/reauth'
import { checkReauthRateLimit, clearReauthRateLimit } from '@/lib/rate-limit'
import { withServiceGuard } from '@/lib/service-config'

const ws1SignSchema = z.object({
  typedName: z.string().trim().min(1).max(120),
  attestation: z.literal(true),
}).strict()

const ws7SignSchema = z.object({
  typedName: z.string().trim().min(1).max(120),
  attested: z.literal(true),
  password: z.string().min(1).max(200).optional(),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
}).strict().refine((b) => (b.password === undefined) !== (b.totpCode === undefined))

function refusalStatus(error: string | undefined): number {
  if (error === NOTE_NOT_FOUND || error === 'Note not found') return 404
  if (error === NOTE_ALREADY_SIGNED || error === 'Note is already signed') return 409
  return 403
}

export const PUT = withServiceGuard('note signing', async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ anonId: string; id: string }> },
) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['pi', 'admin'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId, id } = await params
  const noteId = parseId(id)
  if (noteId === null) return NextResponse.json({ error: 'Invalid note id' }, { status: 400 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response

  const body = json.body as Record<string, unknown> | null | undefined
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const isAdmin = session.role === 'admin'

  if ('attestation' in body) {
    const parsed = ws1SignSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
    }
    const result = await signNote(noteId, anonId, { typedName: parsed.data.typedName, session }, NOTE_ATTESTATION)
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: refusalStatus(result.error) })
    }
    await logAudit(session, 'signed encounter note', anonId, `note=${noteId} signature=${result.signatureId}`)
    return NextResponse.json({ ok: true })
  }

  const parsed = ws7SignSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Type your name, tick the attestation and enter your password or authenticator code.' }, { status: 400 })
  }
  const { typedName, password, totpCode } = parsed.data

  if (typedName !== session.name.trim()) {
    return NextResponse.json({ error: 'The typed name must match your own name to sign this note.' }, { status: 403 })
  }

  const signable = await checkNoteSignable(noteId, anonId, session.name, isAdmin)
  if (!signable.ok) return NextResponse.json({ error: signable.error }, { status: refusalStatus(signable.error) })

  const identity = reauthIdentity(session)
  const { allowed } = await checkReauthRateLimit(identity)
  if (!allowed) {
    await logAudit(session, 'note signing re-authentication rate-limited', anonId, `note_id=${noteId}`)
    return NextResponse.json({ error: 'Too many attempts. Try again in 15 minutes.' }, { status: 429 })
  }

  const reauth = await reauthenticate(session, { password, totpCode })
  if (!reauth.ok) {
    if (reauth.error === 'no_method') {
      return NextResponse.json({ error: 'Your account has no password or authenticator to confirm your identity. Contact an administrator.', code: 'reauth_unavailable' }, { status: 403 })
    }
    await logAudit(session, 'failed note signing re-authentication', anonId, `note_id=${noteId}`)
    return NextResponse.json({ error: 'Password or code is incorrect.', code: 'reauth_failed' }, { status: 401 })
  }
  await clearReauthRateLimit(identity)

  const result = await signNote(noteId, anonId, { name: session.name, role: session.role, isAdmin, typedName }, SIGN_NOTE_ATTESTATION)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: refusalStatus(result.error) })

  await logAudit(session, 'signed encounter note', anonId, `note_id=${noteId}; method=${reauth.method}`)
  return NextResponse.json({ ok: true })
})
