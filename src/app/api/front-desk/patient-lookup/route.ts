import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { findLikelyDuplicatePatients, findPatientsByPhone, type LikelyDuplicatePatient } from '@/lib/queries/patients'
import { normalizePhone } from '@/lib/india/phone'

// Registration duplicate check (FrontDeskDuplicateWarning in AddClientModal):
// name + DOB, and/or the mobile number (Wave B P1-10). Returns id, name, DOB
// and UHID only.
export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['frontdesk', 'admin', 'crc'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const params = request.nextUrl.searchParams
  const name = params.get('name')?.trim().slice(0, 200) || null
  const dob = params.get('dob')?.trim() || null
  const rawPhone = params.get('phone')
  const phone = rawPhone ? normalizePhone(rawPhone.slice(0, 40)) : null
  const byNameDob = !!(name && dob && /^\d{4}-\d{2}-\d{2}$/.test(dob))
  if (!byNameDob && !phone) return NextResponse.json({ error: 'name and dob, or a valid mobile number, are required' }, { status: 400 })

  const [nameMatches, phoneMatches] = await Promise.all([
    byNameDob ? findLikelyDuplicatePatients(name!, dob!) : Promise.resolve([] as LikelyDuplicatePatient[]),
    phone ? findPatientsByPhone(phone) : Promise.resolve([] as LikelyDuplicatePatient[]),
  ])
  const merged = new Map<string, LikelyDuplicatePatient>()
  for (const m of [...nameMatches, ...phoneMatches]) if (!merged.has(m.id)) merged.set(m.id, m)

  await logAudit(session, 'searched for a possible duplicate patient', null)
  return NextResponse.json([...merged.values()])
}
