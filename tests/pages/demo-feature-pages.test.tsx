import { describe, it, expect, vi, afterEach } from 'vitest'

// Wave B P1-21: with DEMO_FEATURES off, every demo page 404s for a role its
// gate admits, before any data is read.
const { mockNotFound, mockGetDb } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND') }),
  mockGetDb: vi.fn(() => { throw new Error('DB_BLOCKED') }),
}))

const PAGES: { route: string; load: () => Promise<{ default: (props: never) => Promise<unknown> }>; props?: unknown }[] = [
  { route: '/billing/pay', load: () => import('@/app/(dashboard)/billing/pay/page'), props: { searchParams: Promise.resolve({}) } },
  { route: '/broadcasts', load: () => import('@/app/(dashboard)/broadcasts/page'), props: { searchParams: Promise.resolve({}) } },
  { route: '/broadcasts/[id]', load: () => import('@/app/(dashboard)/broadcasts/[id]/page'), props: { params: Promise.resolve({ id: '1' }) } },
  { route: '/experience-surveys', load: () => import('@/app/(dashboard)/experience-surveys/page'), props: { searchParams: Promise.resolve({}) } },
  { route: '/experience-surveys/[id]', load: () => import('@/app/(dashboard)/experience-surveys/[id]/page'), props: { params: Promise.resolve({ id: '1' }) } },
  { route: '/documents/fax-history', load: () => import('@/app/(dashboard)/documents/fax-history/page') },
]

async function run(p: (typeof PAGES)[number]) {
  vi.resetModules()
  mockNotFound.mockClear()
  mockGetDb.mockClear()
  vi.doMock('next/navigation', () => ({ redirect: () => { throw new Error('NEXT_REDIRECT') }, notFound: mockNotFound }))
  vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
  vi.doMock('@/db/client', () => ({ getDb: mockGetDb }))
  vi.doMock('@/lib/cache', async (orig) => ({
    ...(await orig<typeof import('@/lib/cache')>()),
    getOrSetCache: (_k: string, _t: number, loader: () => Promise<unknown>) => loader(),
    getRedis: () => { throw new Error('REDIS_BLOCKED') },
  }))
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'admin', name: 'Test admin', userId: null })) }))
  const mod = await p.load()
  try { await mod.default(p.props as never) } catch { /* sentinels */ }
}

const saved = process.env.DEMO_FEATURES
afterEach(() => { process.env.DEMO_FEATURES = saved })

describe.each(PAGES)('$route', (p) => {
  it('404s with DEMO_FEATURES off, before touching the database', async () => {
    process.env.DEMO_FEATURES = 'false'
    await run(p)
    expect(mockNotFound).toHaveBeenCalled()
    expect(mockGetDb).not.toHaveBeenCalled()
  })
  it('renders (reaches data) with DEMO_FEATURES on', async () => {
    process.env.DEMO_FEATURES = 'true'
    await run(p)
    expect(mockNotFound).not.toHaveBeenCalled()
  })
})
