import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listDrugAccountability, createDrugAccountabilityEntry } from '@/lib/queries/trial-compliance'

const ALLOWED_ROLES = ['crc', 'pi', 'admin']

const createSchema = z.object({
  patientId: z.string().trim().min(1).nullable(),
  lotNumber: z.string().trim().min(1),
  expirationDate: z.string().min(1),
  action: z.enum(['received', 'dispensed', 'returned', 'destroyed']),
  quantity: z.number().int().positive(),
  date: z.string().min(1),
  notes: z.string().trim().optional(),
}).strict()

export async function GET(request: NextRequest, { params }: { params: Promise<{ trialId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ALLOWED_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { trialId } = await params
  const entries = await listDrugAccountability(trialId)
  return NextResponse.json({ entries })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ trialId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ALLOWED_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { trialId } = await params
  const parsed = createSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid drug accountability payload', details: parsed.error.flatten() }, { status: 400 })

  const created = await createDrugAccountabilityEntry({ trialId, performedByName: session.name, ...parsed.data })
  await logAudit(session, `logged a drug accountability entry (${parsed.data.action}) for trial ${trialId}`, parsed.data.patientId)
  return NextResponse.json(created, { status: 201 })
}
