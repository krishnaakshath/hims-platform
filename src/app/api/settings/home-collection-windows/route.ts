import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { LAB_SETUP_ROLES } from '@/lib/role-policy'
import { collectionWindowSchema } from '@/lib/labs/validation'
import { createCollectionWindow } from '@/lib/queries/lab-setup'
import { WINDOW_OVERLAP_MESSAGE, errorResponse, invalidBody, labServerError, readJsonBody } from '@/lib/labs/route-responses'

// SP5 Settings → Lab setup: add a home-collection window ('HH:MM' IST, with a capacity).
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_SETUP_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = collectionWindowSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'Invalid collection window')

  try {
    const result = await createCollectionWindow(parsed.data, session)
    if (!result.ok) return errorResponse(409, WINDOW_OVERLAP_MESSAGE)
    return NextResponse.json({ window: result.window }, { status: 201 })
  } catch (err) {
    return labServerError('collection window create', err, 'Could not add the collection window')
  }
}
