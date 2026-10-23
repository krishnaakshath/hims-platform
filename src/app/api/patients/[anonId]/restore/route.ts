import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { readJsonBody } from '@/lib/http'
import { RETRY_MESSAGE, isRetryableConflict } from '@/lib/db-errors'
import { restorePatient } from '@/lib/queries/patient-archive'

// WS8 T13 (spec D17): admin-only restore of an archived chart, audited in the same transaction.
const bodySchema = z.object({}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request, { emptyAs: {} })
  if (!json.ok) return json.response
  if (!bodySchema.safeParse(json.body).success) return NextResponse.json({ error: 'Invalid request', code: 'invalid' }, { status: 400 })

  const { anonId } = await params
  try {
    const result = await restorePatient(anonId, session)
    if (!result.ok) {
      if (result.error === 'not_found') return NextResponse.json({ error: 'Patient not found', code: 'not_found' }, { status: 404 })
      return NextResponse.json({ error: 'This patient is not archived.', code: 'not_archived' }, { status: 409 })
    }
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    throw err
  }
  return NextResponse.json({ ok: true })
}
