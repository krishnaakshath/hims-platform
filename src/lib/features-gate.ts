// Server-side helpers that apply the ENABLE_TRIALS flag (see features.ts).
// Pages call redirectUnlessTrials() right after the session gate; API routes
// `if (!trialsEnabled()) return trialsOffResponse()` right after requireSession().
import { redirect } from 'next/navigation'
import { NextResponse } from 'next/server'
import { trialsEnabled } from '@/lib/features'

/** Send the visitor to the dashboard home when trials are off. Throws (redirect) in that case. */
export function redirectUnlessTrials(): void {
  if (!trialsEnabled()) redirect('/')
}

/** The 404 a trial API route answers while trials are off. */
export function trialsOffResponse(): NextResponse {
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}
