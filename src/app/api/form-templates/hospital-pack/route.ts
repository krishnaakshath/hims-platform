import { NextRequest, NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { readJsonBody } from '@/lib/http'
import { getDb } from '@/db/client'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { invalidateFormTemplatesList } from '@/lib/queries/form-templates'
import { seedHospitalForms } from '@/db/seed-hospital-forms'

const installSchema = z.object({}).strict()

// Installs the hospital form pack (WS7 T4): every pack form missing by name is
// created with its draft consent documents. Admin only; idempotent.
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  if (!installSchema.safeParse(json.body).success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  // One install at a time, all or nothing: a double click never creates a
  // form twice, and a failure part-way leaves no half-installed pack.
  const result = await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hospital_form_pack'))`)
    const r = await seedHospitalForms(tx)
    await logAudit(session, 'installed hospital form pack', null, `created: ${r.created.length}, skipped: ${r.skipped.length}`, tx)
    return r
  })
  await invalidateFormTemplatesList()
  return NextResponse.json(result)
}
