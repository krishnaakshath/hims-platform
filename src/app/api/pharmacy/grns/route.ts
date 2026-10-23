import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { readJsonBody } from '@/lib/http'
import { PHARMACY_STOCK_ROLES } from '@/lib/role-policy'
import { listGrns, receiveGrn, type GrnError } from '@/lib/queries/pharmacy-grns'

// WS5 T3: goods received notes. GET lists recent GRNs; POST receives one supplier delivery.

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Not a calendar date')

const lineSchema = z.object({
  medicationId: z.number().int().positive(),
  batchNo: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9\-/]+$/, 'Letters, digits, - and / only'),
  expiryDate: isoDate,
  quantity: z.number().int().min(1).max(100_000),
  mrpPerUnitPaise: z.number().int().nonnegative(),
  purchaseRatePaise: z.number().int().nonnegative(),
}).strict()

const grnSchema = z.object({
  supplierName: z.string().trim().min(1).max(120),
  supplierInvoiceNo: z.string().trim().min(1).max(60),
  supplierInvoiceDate: isoDate,
  lines: z.array(lineSchema).min(1).max(50),
}).strict()

const REFUSALS: Record<GrnError, { status: number; message: string }> = {
  unknown_medication: { status: 422, message: 'A line names a medication that is not in the catalog.' },
  expired_on_receipt: { status: 422, message: 'A batch expires today or earlier and cannot be received.' },
  batch_conflict: { status: 409, message: 'A batch number is already on file with a different expiry or MRP, or was written off.' },
}

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!PHARMACY_STOCK_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const raw = Number(request.nextUrl.searchParams.get('limit') ?? 50)
  const limit = Number.isInteger(raw) && raw >= 1 && raw <= 50 ? raw : 50
  const items = await listGrns(limit)
  await logAudit(session, 'pharmacy: viewed GRNs', null, `count=${items.length}`)
  return NextResponse.json({ items })
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!PHARMACY_STOCK_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = grnSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid goods received note', details: parsed.error.flatten() }, { status: 400 })

  const result = await receiveGrn(parsed.data, session)
  if (!result.ok) {
    const r = REFUSALS[result.error]
    return NextResponse.json({ error: r.message, code: result.error }, { status: r.status })
  }
  return NextResponse.json({ grnId: result.grnId, grnNumber: result.grnNumber }, { status: 201 })
}
