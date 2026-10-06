import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'

// Scope Decision 2 (docs/superpowers/sdd .../document-insurance-assignment plan):
// this list stays image-only on purpose, and it is an intended divergence
// from POST /api/documents' ALLOWED_TYPES, not a gap to "harmonize" away.
// primaryCardFrontUrl/primaryCardBackUrl are rendered as a bare <img src>
// on the Medical Record page -- a PDF there is a broken image, so this
// route rejects one at the door. POST /api/documents has no such
// constraint: its fileUrl is only ever reached through a redirecting
// download link, which serves any type correctly, so it also accepts
// application/pdf. Both halves are pinned by tests: this route's own
// "rejects a non-image content type" case (uses exactly an application/pdf
// file) and tests/api/documents-receive.test.ts's "accepts an
// application/pdf" case.
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_BYTES = 8 * 1024 * 1024

export async function POST(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc', 'frontdesk'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params
  const formData = await request.formData()
  const side = formData.get('side')
  const file = formData.get('file')
  if (side !== 'front' && side !== 'back') return NextResponse.json({ error: 'side must be "front" or "back"' }, { status: 400 })
  if (!(file instanceof File)) return NextResponse.json({ error: 'file is required' }, { status: 400 })
  if (!ALLOWED_TYPES.includes(file.type)) return NextResponse.json({ error: 'File must be a JPEG, PNG, or WebP image' }, { status: 400 })
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'File must be under 8MB' }, { status: 400 })

  const blob = await put(`insurance-cards/${anonId}-primary-${side}-${Date.now()}`, file, { access: 'private', contentType: file.type })

  const column = side === 'front' ? { primaryCardFrontUrl: blob.url } : { primaryCardBackUrl: blob.url }
  await getDb().update(patients).set(column).where(eq(patients.id, anonId))

  // Every other route that mutates a `patients` row invalidates its cached
  // getPatientDetail() entry (see identity/route.ts) --
  // this one didn't, so the Medical Record page kept serving a stale
  // (pre-upload) cached patient row for up to the 30s TTL after a card
  // upload. Found while verifying Task 5's "second GET shows the uploaded
  // state" requirement against a real server.
  await invalidateCache(patientDetailCacheKey(anonId))

  await logAudit(session, `uploaded insurance card (${side})`, anonId)
  return NextResponse.json({ url: blob.url })
}
