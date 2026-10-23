import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { LAB_ANALYTE_EDIT_ROLES, LAB_ANALYTE_READ_ROLES } from '@/lib/role-policy'
import { labTestAnalytesRequestSchema } from '@/lib/labs/validation'
import { getLabTestWithAnalytes, replaceAnalytesForTest } from '@/lib/queries/lab-analytes'
import { errorResponse, invalidBody, labServerError, parseId, readJsonBody } from '@/lib/labs/route-responses'

// WS4 T8 (spec 3.3 items 17, 21): a lab test's analytes and age/sex reference ranges.
// GET: setup (admin) and result entry (labs). PUT: setup only; replaces the whole list.
const NOT_FOUND = 'Lab test not found'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_ANALYTE_READ_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const id = parseId((await params).id)
  if (id === null) return errorResponse(400, 'Invalid lab test id')
  try {
    const loaded = await getLabTestWithAnalytes(id)
    if (!loaded) return errorResponse(404, NOT_FOUND)
    return NextResponse.json(loaded)
  } catch (err) {
    return labServerError('lab test analytes read', err, 'Could not load the analytes')
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_ANALYTE_EDIT_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = labTestAnalytesRequestSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'Invalid analyte definitions')
  const id = parseId((await params).id)
  if (id === null) return errorResponse(400, 'Invalid lab test id')

  try {
    const result = await replaceAnalytesForTest(id, parsed.data.analytes, session)
    if (!result.ok) return errorResponse(404, NOT_FOUND)
    const loaded = await getLabTestWithAnalytes(id)
    if (!loaded) return errorResponse(404, NOT_FOUND)
    return NextResponse.json(loaded)
  } catch (err) {
    return labServerError('lab test analytes update', err, 'Could not save the analytes')
  }
}
