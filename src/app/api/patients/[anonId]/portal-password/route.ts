import { NextRequest, NextResponse } from 'next/server'
import { randomInt } from 'crypto'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { setPatientPortalPassword, revokePatientPortalAccess } from '@/lib/queries/patient-portal'

// Handed to a patient on paper or read aloud at checkout, not pasted from a
// password manager -- so it needs to be transcribable without ambiguity,
// but it's still a real PHI-guarding credential and needs real entropy.
// This charset excludes visually-ambiguous characters (0/O, 1/I/L) and
// draws 12 characters from a 31-symbol alphabet: ~5 bits/char x 12 = ~59
// bits.
const UNAMBIGUOUS_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function generatePortalPassword(): string {
  const chars = Array.from({ length: 12 }, () => UNAMBIGUOUS_CHARS[randomInt(UNAMBIGUOUS_CHARS.length)])
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`
}

// Admin-only: generates a new hospital-issued portal password for this
// patient and returns it once in plaintext so staff can hand it to the
// patient directly (in person, by phone, or on a printed after-visit
// summary) -- it is never stored or retrievable in plaintext again, only
// its hash, matching how the staff admin credential works.
export async function POST(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const { anonId } = await params
  const password = generatePortalPassword()
  await setPatientPortalPassword(anonId, password)
  await logAudit(session, 'issued a new patient portal password', anonId)

  return NextResponse.json({ patientId: anonId, password })
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const { anonId } = await params
  await revokePatientPortalAccess(anonId)
  await logAudit(session, 'revoked patient portal access', anonId)

  return NextResponse.json({ ok: true })
}
