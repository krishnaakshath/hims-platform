import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { and, eq, gt, inArray, notInArray, sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { POST } from '@/app/api/form-templates/hospital-pack/route'
import { getDb } from '@/db/client'
import { auditLog, consentDocuments, formTemplateConsents, formTemplates } from '@/db/schema'
import { HOSPITAL_FORM_PACK } from '@/db/seed-hospital-forms'

let sessionRole: 'admin' | 'crc' | 'pi' | 'frontdesk' | 'billing' | null = 'admin'
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () =>
    sessionRole ? { role: sessionRole, name: 'Pack Test Admin', userId: null } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  ),
}))

const PACK_NAMES = HOSPITAL_FORM_PACK.map((f) => f.name)
const CONSENT_NAMES = HOSPITAL_FORM_PACK.flatMap((f) => f.consents.map((c) => c.name))
const post = (body: string) => new Request('http://localhost/api/form-templates/hospital-pack', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }) as never

// The route commits for real; remember what pack rows existed before each test
// and remove only what the test added.
let preTemplateIds: number[] = []
let preDocIds: number[] = []
let auditFloor = 0

beforeEach(async () => {
  const db = getDb()
  preTemplateIds = (await db.select({ id: formTemplates.id }).from(formTemplates).where(inArray(formTemplates.name, PACK_NAMES))).map((r) => r.id)
  preDocIds = (await db.select({ id: consentDocuments.id }).from(consentDocuments).where(inArray(consentDocuments.name, CONSENT_NAMES))).map((r) => r.id)
  const [row] = await db.select({ m: sql<number>`coalesce(max(${auditLog.id}), 0)::int` }).from(auditLog)
  auditFloor = row.m
})

afterEach(async () => {
  sessionRole = 'admin'
  const db = getDb()
  const newTemplates = (await db.select({ id: formTemplates.id }).from(formTemplates)
    .where(and(inArray(formTemplates.name, PACK_NAMES), preTemplateIds.length ? notInArray(formTemplates.id, preTemplateIds) : undefined))).map((r) => r.id)
  if (newTemplates.length) {
    await db.delete(formTemplateConsents).where(inArray(formTemplateConsents.formTemplateId, newTemplates))
    await db.delete(formTemplates).where(inArray(formTemplates.id, newTemplates))
  }
  const newDocs = (await db.select({ id: consentDocuments.id }).from(consentDocuments)
    .where(and(inArray(consentDocuments.name, CONSENT_NAMES), preDocIds.length ? notInArray(consentDocuments.id, preDocIds) : undefined))).map((r) => r.id)
  if (newDocs.length) await db.delete(consentDocuments).where(inArray(consentDocuments.id, newDocs))
  await db.delete(auditLog).where(and(gt(auditLog.id, auditFloor), eq(auditLog.action, 'installed hospital form pack')))
})

describe('POST /api/form-templates/hospital-pack', () => {
  it.each(['frontdesk', 'crc', 'pi', 'billing'] as const)('denies %s with 403 before reading the body', async (role) => {
    sessionRole = role
    const res = await POST(post('not json'))
    expect(res.status).toBe(403)
  })

  it('returns 401 without a session', async () => {
    sessionRole = null
    expect((await POST(post('{}'))).status).toBe(401)
  })

  it('rejects a body with unknown keys or invalid JSON', async () => {
    expect((await POST(post('{"force":true}'))).status).toBe(400)
    expect((await POST(post('not json'))).status).toBe(400)
  })

  it('installs the missing pack forms for an admin, then skips them, auditing counts only', async () => {
    const res = await POST(post('{}'))
    expect(res.status).toBe(200)
    const body = await res.json() as { created: string[]; skipped: string[] }
    expect([...body.created, ...body.skipped].sort()).toEqual([...PACK_NAMES].sort())

    const again = await POST(post('{}'))
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ created: [], skipped: PACK_NAMES })

    for (const name of PACK_NAMES) {
      expect(await getDb().select({ id: formTemplates.id }).from(formTemplates).where(eq(formTemplates.name, name)), name).toHaveLength(1)
    }

    const audits = await getDb().select().from(auditLog).where(and(gt(auditLog.id, auditFloor), eq(auditLog.action, 'installed hospital form pack')))
    expect(audits.map((a) => a.details)).toEqual([
      `created: ${body.created.length}, skipped: ${body.skipped.length}`,
      `created: 0, skipped: ${PACK_NAMES.length}`,
    ])
    expect(audits.every((a) => a.role === 'admin' && a.patientId === null)).toBe(true)
  })
})
