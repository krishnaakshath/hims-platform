// Wave H P2-07: a detail page whose numeric id is not plain int4 digits is a
// 404 (notFound()) and never reaches the database -- no NaN / overflow query,
// no `charge:NaN` cache key.
import { describe, it, expect, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(() => { throw new Error('DB_BLOCKED') }),
  getOrSetCache: vi.fn(() => { throw new Error('CACHE_BLOCKED') }),
}))

type Page = { default: (props: never) => Promise<unknown> }
async function run(load: () => Promise<Page>, params: Record<string, string>) {
  vi.resetModules()
  mocks.getDb.mockClear()
  mocks.getOrSetCache.mockClear()
  vi.doMock('next/navigation', () => ({
    redirect: () => { throw new Error('NEXT_REDIRECT') },
    notFound: () => { throw new Error('NEXT_NOT_FOUND') },
  }))
  vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
  vi.doMock('@/db/client', () => ({ getDb: mocks.getDb }))
  vi.doMock('@/lib/cache', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/cache')>()),
    getOrSetCache: mocks.getOrSetCache,
  }))
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'admin', name: 'Test admin', userId: null })) }))
  const mod = await load()
  return mod.default({ params: Promise.resolve(params), searchParams: Promise.resolve({}) } as never)
}

const PAGES: { route: string; key: string; load: () => Promise<Page> }[] = [
  { route: '/broadcasts/[id]', key: 'id', load: () => import('@/app/(dashboard)/broadcasts/[id]/page') },
  { route: '/forms/[templateId]', key: 'templateId', load: () => import('@/app/(dashboard)/forms/[templateId]/page') },
  { route: '/forms/folders/[folderId]', key: 'folderId', load: () => import('@/app/(dashboard)/forms/folders/[folderId]/page') },
  { route: '/experience-surveys/[id]', key: 'id', load: () => import('@/app/(dashboard)/experience-surveys/[id]/page') },
  { route: '/telemedicine/[sessionId]', key: 'sessionId', load: () => import('@/app/(dashboard)/telemedicine/[sessionId]/page') },
  { route: '/staff/[id]', key: 'id', load: () => import('@/app/(dashboard)/staff/[id]/page') },
  { route: '/client-forms/[id]', key: 'id', load: () => import('@/app/(dashboard)/client-forms/[id]/page') },
  { route: '/billing/charges/[chargeId]', key: 'chargeId', load: () => import('@/app/(dashboard)/billing/charges/[chargeId]/page') },
  { route: '/consent-documents/[id]', key: 'id', load: () => import('@/app/(dashboard)/consent-documents/[id]/page') },
]

describe.each(PAGES)('$route', (p) => {
  it.each(['abc', '1.5', '-1', '0', '1e3', '99999999999'])('id %j is notFound() before any query', async (bad) => {
    await expect(run(p.load, { [p.key]: bad })).rejects.toThrow('NEXT_NOT_FOUND')
    expect(mocks.getDb).not.toHaveBeenCalled()
    expect(mocks.getOrSetCache).not.toHaveBeenCalled()
  })
})
