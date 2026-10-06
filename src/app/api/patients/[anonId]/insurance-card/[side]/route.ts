import { NextRequest, NextResponse } from 'next/server'
import { get } from '@vercel/blob'
import { requireSession } from '@/lib/auth'
import { INSURANCE_CARD_READ_ROLES } from '@/lib/role-policy'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { eq } from 'drizzle-orm'

// Serves the actual card image bytes. The blob store is private, so the
// Medical Record page's <img>/<a> can no longer point at patients.primaryCard*Url
// directly -- a browser has no way to authenticate to the blob store on its
// own. This route is the only thing that can reach the bytes (server-side,
// using our own token), gated to INSURANCE_CARD_READ_ROLES (admin, crc, pi,
// frontdesk, billing).
export async function GET(request: NextRequest, { params }: { params: Promise<{ anonId: string; side: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!INSURANCE_CARD_READ_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId, side } = await params
  if (side !== 'front' && side !== 'back') return NextResponse.json({ error: 'Invalid side' }, { status: 400 })

  const [row] = await getDb()
    .select({ front: patients.primaryCardFrontUrl, back: patients.primaryCardBackUrl })
    .from(patients)
    .where(eq(patients.id, anonId))
  const storedUrl = side === 'front' ? row?.front : row?.back
  if (!storedUrl) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const blob = await get(storedUrl, { access: 'private' })
  if (!blob || blob.statusCode !== 200) return NextResponse.json({ error: 'Stored file is missing' }, { status: 404 })

  return new NextResponse(blob.stream, {
    headers: {
      'Content-Type': blob.blob.contentType,
      'Cache-Control': 'private, max-age=0, must-revalidate',
    },
  })
}
