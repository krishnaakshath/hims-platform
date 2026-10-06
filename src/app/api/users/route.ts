import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listAllUsers, createUser } from '@/lib/queries/users'

const createUserSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email(),
  role: z.enum(['admin', 'pi', 'crc', 'frontdesk', 'pharmacy', 'billing', 'labs']),
}).strict()

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  await logAudit(session, 'viewed staff roster', null)
  const roster = await listAllUsers()
  return NextResponse.json(roster)
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const parsed = createUserSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  const result = await createUser(parsed.data)
  if (!result) return NextResponse.json({ error: 'A staff account with this email already exists' }, { status: 409 })

  await logAudit(session, 'created a staff account', null)
  return NextResponse.json({ id: result.user.id, name: result.user.name, email: result.user.email, role: result.user.role, password: result.password }, { status: 201 })
}
