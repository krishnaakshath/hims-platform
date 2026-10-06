import { NextResponse } from 'next/server'
import { getPatientSession, clearPatientSessionCookie } from '@/lib/patient-session'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'

export async function POST() {
  const session = await getPatientSession()
  await clearPatientSessionCookie()
  if (session) await logPatientPortalAction('logged out of patient portal', session.patientId)
  return NextResponse.json({ ok: true })
}
