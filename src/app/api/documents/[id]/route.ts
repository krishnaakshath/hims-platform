import { NextRequest, NextResponse } from 'next/server'
import { parseId, readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { del } from '@vercel/blob'
import { getDb } from '@/db/client'
import { patients, documentTypeEnum } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getDocument, updateDocument, deleteDocument, isAdmissionForPatient } from '@/lib/queries/documents'
import type { UpdateDocumentInput } from '@/lib/queries/documents'
import { invalidateCache, documentsListCacheKey, patientDetailCacheKey } from '@/lib/cache'

const updateDocumentSchema = z
  .object({
    status: z.enum(['new', 'processed']).optional(),
    patientId: z.string().trim().min(1).nullable().optional(),
    admissionId: z.number().int().positive().nullable().optional(),
    documentType: z.enum(documentTypeEnum.enumValues).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' })

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc', 'frontdesk'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id } = await params
  const docId = parseId(id)
  if (docId === null) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = updateDocumentSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid document update', details: parsed.error.flatten() }, { status: 400 })

  const existing = await getDocument(docId)
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const data = parsed.data
  const patientIdSupplied = 'patientId' in data
  const clearingPatient = patientIdSupplied && data.patientId === null
  const effectivePatientId = patientIdSupplied ? data.patientId : existing.patientId

  const update: UpdateDocumentInput = {}
  const changes: string[] = []

  if (data.status !== undefined) {
    update.status = data.status
    changes.push(`marked document ${id} as ${data.status}`)
  }

  if (patientIdSupplied) {
    const newPatientId = data.patientId
    if (newPatientId) {
      // Narrow select -- the live `patients` table has columns other
      // in-flight branches have already migrated away from schema.ts (see
      // documents/route.ts's POST), so a bare select().from(patients) can
      // 42703 on an unrelated column.
      const [patientRow] = await getDb().select({ id: patients.id }).from(patients).where(eq(patients.id, newPatientId))
      if (!patientRow) return NextResponse.json({ error: 'patientId does not exist' }, { status: 400 })

      update.patientId = newPatientId
      update.filedByName = session.name
      update.filedAt = new Date()
      changes.push(`filed document ${id} to patient ${newPatientId}`)

      // Re-filing to a different patient invalidates whatever admission the
      // document was previously tied to -- an admission belongs to exactly
      // one patient, so carrying it over to a new patient would be wrong.
      // If the body itself supplies an admissionId, the check below governs
      // instead of this auto-clear.
      if (newPatientId !== existing.patientId && data.admissionId === undefined) {
        update.admissionId = null
      }
    } else {
      update.patientId = null
      update.filedByName = null
      update.filedAt = null
      update.admissionId = null
      changes.push(`unfiled document ${id}`)
    }
  }

  // Skipped when the body is clearing patientId to null: that branch above
  // already forced admissionId to null, and Scope Decision in the task
  // brief is to ignore any admissionId sent alongside patientId: null rather
  // than 400 on it -- patientId: null is unambiguous about intent.
  if (!clearingPatient && data.admissionId !== undefined) {
    if (data.admissionId === null) {
      update.admissionId = null
    } else {
      if (!effectivePatientId || !(await isAdmissionForPatient(data.admissionId, effectivePatientId))) {
        return NextResponse.json({ error: 'admissionId does not belong to this patient' }, { status: 400 })
      }
      update.admissionId = data.admissionId
    }
  }

  if (data.documentType !== undefined) {
    update.documentType = data.documentType
    changes.push(`changed document ${id} type to ${data.documentType}`)
  }

  await updateDocument(docId, update)

  await invalidateCache(documentsListCacheKey())
  if (existing.patientId) await invalidateCache(patientDetailCacheKey(existing.patientId))
  // A re-file changes what two patients' pages should show -- invalidate
  // the new patient's cached detail page too when it differs from the old.
  if (effectivePatientId && effectivePatientId !== existing.patientId) await invalidateCache(patientDetailCacheKey(effectivePatientId))

  await logAudit(session, changes.join('; '), effectivePatientId ?? existing.patientId)

  return NextResponse.json({ ok: true })
}

// Admin-only: permanently removes a document record (and best-effort, its
// stored file) from this app -- for correcting a genuine mistake, e.g. a
// document scanned to the wrong chart or a duplicate upload. Any other
// staff role that wants a document off a chart re-files it via PATCH; they
// don't erase the record. Mirrors patients/[anonId]/route.ts's admin-only
// DELETE.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const numericId = parseId(id)
  if (numericId === null) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const deleted = await deleteDocument(numericId)
  if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (deleted.fileUrl) {
    // Best-effort: a failed Blob delete must never block or reverse the DB
    // delete. The record that this document existed and was removed lives in
    // auditLog and outlives storage cleanup either way; an orphaned blob is a
    // janitorial problem, a half-deleted document row is a data-integrity one.
    try {
      await del(deleted.fileUrl)
    } catch (err) {
      console.error(`Failed to delete blob for document ${id}:`, err)
    }
  }

  await invalidateCache(documentsListCacheKey())
  if (deleted.patientId) await invalidateCache(patientDetailCacheKey(deleted.patientId))
  await logAudit(session, `deleted document ${id} ("${deleted.name}")`, deleted.patientId)

  return NextResponse.json({ ok: true })
}
