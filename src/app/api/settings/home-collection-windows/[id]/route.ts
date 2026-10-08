import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { LAB_SETUP_ROLES } from '@/lib/role-policy'
import { collectionWindowPatchSchema } from '@/lib/labs/validation'
import { updateCollectionWindow } from '@/lib/queries/lab-setup'
import { WINDOW_OVERLAP_MESSAGE, errorResponse, invalidBody, labServerError, parseId, readJsonBody } from '@/lib/labs/route-responses'

// SP5 Settings → Lab setup: change or deactivate a collection window. Booked visits keep
// their own snapshot of the label and times.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_SETUP_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = collectionWindowPatchSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'Invalid collection window change')
  const id = parseId((await params).id)
  if (id === null) return errorResponse(400, 'Invalid window id')

  try {
    const result = await updateCollectionWindow(id, parsed.data, session)
    if (!result.ok) {
      switch (result.error) {
        case 'not_found': return errorResponse(404, 'Collection window not found')
        case 'overlap': return errorResponse(409, WINDOW_OVERLAP_MESSAGE)
        case 'invalid_times': return errorResponse(400, 'The window must end after it starts')
      }
    }
    return NextResponse.json({ window: result.window })
  } catch (err) {
    return labServerError('collection window change', err, 'Could not update the collection window')
  }
}
