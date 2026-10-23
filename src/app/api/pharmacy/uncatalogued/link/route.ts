import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { readJsonBody } from '@/lib/http'
import { PHARMACY_STOCK_ROLES } from '@/lib/role-policy'
import { linkUncataloguedEpisodes } from '@/lib/queries/medications'

// WS5 T4: resolve a "Not in catalog" prescription name by linking its active, unlinked episodes
// (exact name) to a catalogue drug.
const linkSchema = z.object({
  episodeName: z.string().min(1).max(200),
  medicationId: z.number().int().positive(),
}).strict()

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!PHARMACY_STOCK_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = linkSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid link', details: parsed.error.flatten() }, { status: 400 })

  const result = await linkUncataloguedEpisodes(parsed.data.episodeName, parsed.data.medicationId, session)
  if (!result.ok) return NextResponse.json({ error: 'That medication is not in the catalog.', code: 'unknown_medication' }, { status: 422 })
  return NextResponse.json({ linked: result.linked })
}
