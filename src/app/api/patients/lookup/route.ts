import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { PATIENT_PICKER_PHONE_ROLES, PATIENT_PICKER_ROLES } from '@/lib/role-policy'
import { lookupPatients } from '@/lib/queries/search'
import { PATIENT_LOOKUP_MAX_PAGE, PATIENT_LOOKUP_MAX_PAGE_SIZE, PATIENT_LOOKUP_MAX_QUERY, PATIENT_LOOKUP_MIN_QUERY, PATIENT_LOOKUP_DEFAULT_PAGE_SIZE } from '@/lib/queries/search-types'
import { RETRY_MESSAGE, isRetryableConflict, pgErrorCode } from '@/lib/db-errors'

// Wave C P0-04: the patient picker's typeahead. Name, UHID, chart id or
// mobile -> a capped, ordered, paged minimal projection (see lookupPatients).
// Gate first (PATIENT_PICKER_ROLES), then the strict query schema. The
// mobile number is returned only to PATIENT_PICKER_PHONE_ROLES; other roles
// may still FIND a patient by mobile but never see it echoed back.
const querySchema = z.object({
  q: z.string().max(PATIENT_LOOKUP_MAX_QUERY).default(''),
  page: z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().int().min(1).max(PATIENT_LOOKUP_MAX_PAGE)).optional(),
  pageSize: z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().int().min(1).max(PATIENT_LOOKUP_MAX_PAGE_SIZE)).optional(),
}).strict()

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!PATIENT_PICKER_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid lookup query' }, { status: 400 })
  const { q, page, pageSize } = parsed.data

  if (q.trim().length < PATIENT_LOOKUP_MIN_QUERY) {
    return NextResponse.json({ results: [], page: page ?? 1, pageSize: pageSize ?? PATIENT_LOOKUP_DEFAULT_PAGE_SIZE, hasMore: false }, { headers: NO_STORE })
  }

  try {
    const result = await lookupPatients(q, { includePhone: PATIENT_PICKER_PHONE_ROLES.includes(session.role), page, pageSize })
    // The query itself is not recorded: it is often a mobile number.
    await logAudit(session, 'looked up patients (picker)', null, `${result.results.length} result(s)`)
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    console.error(`[patients/lookup] failed (code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not look up patients' }, { status: 500 })
  }
}
