import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession, type Session } from '@/lib/auth'
import { getPatientSession, type PatientSession } from '@/lib/patient-session'
import { logAudit } from '@/lib/audit'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import {
  listMessagesForPatient,
  listPatientVisibleMessages,
  sendMessage,
  markReadByProvider,
  markReadByPatient,
  getPatientDisplayName,
} from '@/lib/queries/messages'

const sendMessageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  // See resolveActor() below -- a disambiguation hint only, never trusted
  // on its own.
  actingAs: z.enum(['provider', 'patient']).optional(),
  // Staff-to-staff note about this patient (e.g. pharmacy confirming a
  // dispense with the prescriber) -- never honored for a patient actor
  // below, only staff can mark their own message internal.
  internal: z.boolean().optional(),
}).strict()

type Actor = { kind: 'staff'; session: Session } | { kind: 'patient'; session: PatientSession }

/**
 * This route serves two completely separate session types (see AGENTS.md /
 * the auth-model notes in lib/auth.ts and lib/patient-session.ts) -- a staff
 * member reading/replying to any patient's thread, or a patient reading/
 * replying to their own.
 *
 * A browser can in theory carry both cookies at once (e.g. a staff member
 * who is also logged into the patient portal in the same browser, which is
 * exactly how this got tested this session) -- without a way to tell which
 * UI actually made the request, this used to always prefer the staff
 * session, so a patient's own composer would silently send as staff.
 * `actingAs` (an optional hint the caller sets based on which surface it
 * renders in) picks which session type to check FIRST when both exist, but
 * it is never trusted by itself: whichever session it points to must still
 * be a real, valid session, and a patient session must still only ever act
 * on its own patientId's thread. Omitting it (or an unrecognized value)
 * keeps the original staff-first default.
 */
// Messages page.tsx -- crc/pi/admin/pharmacy, not frontdesk/billing/labs.
// Enforced here too, not just on the page: this route is reachable directly
// regardless of what the UI shows.
const STAFF_MESSAGE_ROLES = ['crc', 'pi', 'admin', 'pharmacy']

async function resolveActor(patientId: string, actingAs?: 'provider' | 'patient'): Promise<Actor | NextResponse> {
  const [staffSession, patientSession] = await Promise.all([getSession(), getPatientSession()])
  const staffActor: Actor | null = staffSession && STAFF_MESSAGE_ROLES.includes(staffSession.role) ? { kind: 'staff', session: staffSession } : null
  const patientActor: Actor | null = patientSession && patientSession.patientId === patientId ? { kind: 'patient', session: patientSession } : null

  const [first, second] = actingAs === 'patient' ? [patientActor, staffActor] : [staffActor, patientActor]
  if (first) return first
  if (second) return second

  // A patient session existed but didn't match this patientId -- distinct
  // from "no session at all" so a patient poking at another patient's
  // thread gets 403, not a generic 401.
  if (patientSession && patientSession.patientId !== patientId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

function parseActingAs(value: string | null): 'provider' | 'patient' | undefined {
  return value === 'provider' || value === 'patient' ? value : undefined
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ patientId: string }> }) {
  const { patientId } = await params
  const actingAs = parseActingAs(new URL(request.url).searchParams.get('actingAs'))
  const actor = await resolveActor(patientId, actingAs)
  if (actor instanceof NextResponse) return actor

  if (actor.kind === 'staff') {
    const thread = await listMessagesForPatient(patientId)
    await markReadByProvider(patientId)
    await logAudit(actor.session, 'viewed patient messages', patientId)
    return NextResponse.json(thread)
  }

  // Patient-facing read: internal (staff-to-staff) notes are never included.
  const thread = await listPatientVisibleMessages(patientId)
  await markReadByPatient(patientId)
  await logPatientPortalAction('viewed messages', patientId)
  return NextResponse.json(thread)
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ patientId: string }> }) {
  const { patientId } = await params

  const parsed = sendMessageSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid message payload', details: parsed.error.flatten() }, { status: 400 })

  const actor = await resolveActor(patientId, parsed.data.actingAs)
  if (actor instanceof NextResponse) return actor

  if (actor.kind === 'staff') {
    const created = await sendMessage(patientId, 'provider', actor.session.name, parsed.data.body, parsed.data.internal ?? false)
    await logAudit(actor.session, parsed.data.internal ? 'sent internal note about patient' : 'sent patient message', patientId)
    return NextResponse.json(created, { status: 201 })
  }

  const patientName = await getPatientDisplayName(patientId)
  if (!patientName) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const created = await sendMessage(patientId, 'patient', patientName, parsed.data.body)
  await logPatientPortalAction('sent message', patientId)
  return NextResponse.json(created, { status: 201 })
}
