import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LeftNav } from '@/components/LeftNav'

vi.mock('next/navigation', () => ({ usePathname: () => '/patients', redirect: vi.fn() }))

afterEach(() => vi.unstubAllEnvs())

describe('LeftNav trials flag', () => {
  it('hides Workbook, Trials & Protocols and Pipeline Dashboard when trials=false, keeps form entries', () => {
    render(<LeftNav role="admin" trials={false} />)
    for (const n of [/^workbook$/i, /trials & protocols/i, /pipeline dashboard/i]) {
      expect(screen.queryByRole('link', { name: n })).not.toBeInTheDocument()
    }
    for (const n of [/form templates/i, /consent documents/i, /client forms/i]) {
      expect(screen.getByRole('link', { name: n })).toBeInTheDocument()
    }
  })
  it('shows them when trials=true', () => {
    render(<LeftNav role="admin" trials />)
    for (const n of [/^workbook$/i, /trials & protocols/i, /pipeline dashboard/i]) {
      expect(screen.getByRole('link', { name: n })).toBeInTheDocument()
    }
  })
})

describe('trial pages and routes with the flag off', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('ENABLE_TRIALS', '')
  })

  const pages = [
    '@/app/(dashboard)/workbook/page',
    '@/app/(dashboard)/trials/page',
    '@/app/(dashboard)/trials/[trialId]/page',
    '@/app/(dashboard)/pipeline-dashboard/page',
  ]
  for (const p of pages) {
    it(`${p} redirects before any query`, async () => {
      const redirect = vi.fn(() => { throw new Error('NEXT_REDIRECT') })
      const getDb = vi.fn(() => { throw new Error('DB_BLOCKED') })
      vi.doMock('next/navigation', () => ({ redirect, notFound: () => { throw new Error('NF') } }))
      vi.doMock('@/db/client', () => ({ getDb }))
      vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn() }))
      vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'admin', name: 'A', userId: null })) }))
      const mod = await import(/* @vite-ignore */ p)
      const props = p.includes('[trialId]') ? { params: Promise.resolve({ trialId: '1' }) } : { searchParams: Promise.resolve({}) }
      await mod.default(props as never).catch(() => undefined)
      expect(redirect).toHaveBeenCalledWith('/')
      expect(getDb).not.toHaveBeenCalled()
    })
  }

  const routes: [string, string[], boolean][] = [
    ['@/app/api/trials/route', ['GET'], false],
    ['@/app/api/trials/[trialId]/adverse-events/route', ['GET', 'POST', 'PATCH'], true],
    ['@/app/api/trials/[trialId]/drug-accountability/route', ['GET', 'POST'], true],
    ['@/app/api/trials/[trialId]/regulatory-documents/route', ['GET', 'POST'], true],
    ['@/app/api/trials/[trialId]/criteria/route', ['PUT'], true],
    ['@/app/api/workbook/full/route', ['GET'], false],
    ['@/app/api/workbook/export/route', ['GET'], false],
  ]
  for (const [path, methods, ctx] of routes) {
    for (const m of methods) {
      it(`${m} ${path} answers 404`, async () => {
        const getDb = vi.fn(() => { throw new Error('DB_BLOCKED') })
        vi.doMock('@/db/client', () => ({ getDb }))
        vi.doMock('@/lib/auth', async (orig) => ({ ...(await orig<object>()), requireSession: vi.fn(async () => ({ role: 'admin', name: 'A', userId: null })) }))
        const mod = await import(/* @vite-ignore */ path)
        const req = new Request('http://localhost/x', { method: m, body: m === 'GET' ? undefined : '{}' })
        const res = await mod[m](req, ctx ? { params: Promise.resolve({ trialId: '1' }) } : undefined)
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ error: 'Not found' })
        expect(getDb).not.toHaveBeenCalled()
      })
    }
  }
})
