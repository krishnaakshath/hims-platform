import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { GET, POST } from '@/app/api/form-template-folders/route'
import { PUT, DELETE } from '@/app/api/form-template-folders/[id]/route'
import { getDb } from '@/db/client'
import { formTemplateFolders, formTemplates, auditLog } from '@/db/schema'
import { eq, desc, inArray } from 'drizzle-orm'
import { listFormTemplates } from '@/lib/queries/form-templates'
import { listActiveTemplatesInFolder } from '@/lib/queries/form-template-folders'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'crc', name: 'Jamie Ruiz', userId: null })) }))

let createdFolderIds: number[] = []
let createdTemplateIds: number[] = []

afterEach(async () => {
  for (const id of createdTemplateIds) {
    await getDb().delete(formTemplates).where(eq(formTemplates.id, id))
  }
  createdTemplateIds = []
  for (const id of createdFolderIds) {
    await getDb().delete(formTemplateFolders).where(eq(formTemplateFolders.id, id))
    await getDb().delete(auditLog).where(inArray(auditLog.action, [`renamed form template folder ${id}`, `deleted form template folder ${id}`]))
  }
  createdFolderIds = []
  await getDb().delete(auditLog).where(eq(auditLog.action, 'created form template folder'))
})

function makeRequest(body?: unknown, method = 'POST') {
  return new Request('http://localhost/api/form-template-folders', {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function insertTemplate(overrides: { folderId?: number | null; isActive?: boolean; name?: string } = {}) {
  const [row] = await getDb().insert(formTemplates).values({
    name: overrides.name ?? `Test Template ${Date.now()}-${Math.random()}`,
    category: 'Test',
    diagnosisTag: 'Test',
    questions: [],
    isActive: overrides.isActive ?? true,
    folderId: overrides.folderId ?? null,
  }).returning()
  createdTemplateIds.push(row.id)
  return row
}

describe('POST /api/form-template-folders', () => {
  it('creates a folder that appears in the list with 0 templates', async () => {
    const res = await POST(makeRequest({ name: 'Research Forms' }) as never)
    expect(res.status).toBe(201)
    const created = await res.json()
    createdFolderIds.push(created.id)

    const listRes = await GET()
    const list = await listRes.json()
    const found = list.find((f: { id: number }) => f.id === created.id)
    expect(found).toBeDefined()
    expect(found.activeTemplateCount).toBe(0)
  })

  it('counts an active template filed into the folder', async () => {
    const res = await POST(makeRequest({ name: 'Folder With One' }) as never)
    const created = await res.json()
    createdFolderIds.push(created.id)

    await insertTemplate({ folderId: created.id })

    const listRes = await GET()
    const list = await listRes.json()
    const found = list.find((f: { id: number }) => f.id === created.id)
    expect(found.activeTemplateCount).toBe(1)
  })

  it('does not count or list an archived template in the folder', async () => {
    const res = await POST(makeRequest({ name: 'Folder With Archived' }) as never)
    const created = await res.json()
    createdFolderIds.push(created.id)

    const active = await insertTemplate({ folderId: created.id })
    await insertTemplate({ folderId: created.id, isActive: false })

    const listRes = await GET()
    const list = await listRes.json()
    const found = list.find((f: { id: number }) => f.id === created.id)
    expect(found.activeTemplateCount).toBe(1)

    const activeTemplates = await listActiveTemplatesInFolder(created.id)
    expect(activeTemplates.map((t) => t.id)).toEqual([active.id])
  })

  it('rejects a payload with an extra field (.strict())', async () => {
    const res = await POST(makeRequest({ name: 'x', sortOrder: 5 }) as never)
    expect(res.status).toBe(400)
  })

  it('writes an audit log row on create', async () => {
    const res = await POST(makeRequest({ name: 'Audited Folder' }) as never)
    const created = await res.json()
    createdFolderIds.push(created.id)

    const [latest] = await getDb().select().from(auditLog).where(eq(auditLog.action, 'created form template folder')).orderBy(desc(auditLog.id)).limit(1)
    expect(latest?.action).toBe('created form template folder')
  })

  it('invalidates the templates list cache', async () => {
    // Prime the 30-second cache entry.
    await listFormTemplates()

    // Insert a template directly, bypassing the routes, so only the folder
    // POST's own invalidateFormTemplatesList() call can clear the cache.
    const inserted = await insertTemplate()

    const res = await POST(makeRequest({ name: 'Cache Buster Folder' }) as never)
    const created = await res.json()
    createdFolderIds.push(created.id)

    const templates = await listFormTemplates()
    expect(templates.some((t) => t.id === inserted.id)).toBe(true)
  })
})

describe('PUT /api/form-template-folders/[id]', () => {
  it('renames a folder', async () => {
    const createRes = await POST(makeRequest({ name: 'Original Name' }) as never)
    const created = await createRes.json()
    createdFolderIds.push(created.id)

    const putRes = await PUT(makeRequest({ name: 'Renamed' }, 'PUT') as never, { params: Promise.resolve({ id: String(created.id) }) })
    expect(putRes.status).toBe(200)

    const listRes = await GET()
    const list = await listRes.json()
    const found = list.find((f: { id: number }) => f.id === created.id)
    expect(found.name).toBe('Renamed')
  })
})

describe('DELETE /api/form-template-folders/[id]', () => {
  it('un-files templates instead of deleting them, then removes the folder', async () => {
    const createRes = await POST(makeRequest({ name: 'Folder To Delete' }) as never)
    const created = await createRes.json()

    const template = await insertTemplate({ folderId: created.id })

    const delRes = await DELETE(makeRequest(undefined, 'DELETE') as never, { params: Promise.resolve({ id: String(created.id) }) })
    expect(delRes.status).toBe(200)

    const [row] = await getDb().select().from(formTemplates).where(eq(formTemplates.id, template.id))
    expect(row).toBeDefined()
    expect(row.folderId).toBeNull()

    const listRes = await GET()
    const list = await listRes.json()
    expect(list.find((f: { id: number }) => f.id === created.id)).toBeUndefined()
    // Folder is already gone -- don't attempt to clean it up again in afterEach.
  })

  it('returns 404 for a folder id that does not exist', async () => {
    const res = await DELETE(makeRequest(undefined, 'DELETE') as never, { params: Promise.resolve({ id: '999999999' }) })
    expect(res.status).toBe(404)
  })
})

describe('role gating', () => {
  it('rejects frontdesk and billing with 403 on POST/PUT/DELETE, leaving the folder table unchanged', async () => {
    const createRes = await POST(makeRequest({ name: 'Gated Folder' }) as never)
    const created = await createRes.json()
    createdFolderIds.push(created.id)

    const auth = await import('@/lib/auth')
    for (const role of ['frontdesk', 'billing'] as const) {
      vi.mocked(auth.requireSession).mockResolvedValueOnce({ role, name: 'Someone', userId: null })
      const postRes = await POST(makeRequest({ name: 'Should Not Exist' }) as never)
      expect(postRes.status).toBe(403)

      vi.mocked(auth.requireSession).mockResolvedValueOnce({ role, name: 'Someone', userId: null })
      const putRes = await PUT(makeRequest({ name: 'Should Not Rename' }, 'PUT') as never, { params: Promise.resolve({ id: String(created.id) }) })
      expect(putRes.status).toBe(403)

      vi.mocked(auth.requireSession).mockResolvedValueOnce({ role, name: 'Someone', userId: null })
      const delRes = await DELETE(makeRequest(undefined, 'DELETE') as never, { params: Promise.resolve({ id: String(created.id) }) })
      expect(delRes.status).toBe(403)
    }

    const [row] = await getDb().select().from(formTemplateFolders).where(eq(formTemplateFolders.id, created.id))
    expect(row).toBeDefined()
    expect(row.name).toBe('Gated Folder')
  })

  it('allows pi (doctor) on POST/PUT/DELETE', async () => {
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'pi', name: 'Dr. Someone', userId: null })
    const postRes = await POST(makeRequest({ name: 'PI Folder' }) as never)
    expect(postRes.status).toBe(201)
    const created = await postRes.json()
    createdFolderIds.push(created.id)

    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'pi', name: 'Dr. Someone', userId: null })
    const putRes = await PUT(makeRequest({ name: 'PI Folder Renamed' }, 'PUT') as never, { params: Promise.resolve({ id: String(created.id) }) })
    expect(putRes.status).toBe(200)

    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'pi', name: 'Dr. Someone', userId: null })
    const delRes = await DELETE(makeRequest(undefined, 'DELETE') as never, { params: Promise.resolve({ id: String(created.id) }) })
    expect(delRes.status).toBe(200)
  })

  it('rejects an unauthenticated call with 401', async () => {
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireSession).mockResolvedValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) as never)
    const res = await POST(makeRequest({ name: 'Unauthed' }) as never)
    expect(res.status).toBe(401)
  })
})
