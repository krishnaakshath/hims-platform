// SP6 Task 14: /coding/service-codes. Queries mocked; the editor's PUT goes to a stubbed fetch.
import { describe, it, expect, vi, afterEach } from 'vitest'

const refresh = vi.fn()
afterEach(async () => {
  const { cleanup } = await import('@testing-library/react')
  cleanup()
  vi.unstubAllGlobals()
  refresh.mockReset()
})

async function renderAs(role: string, opts: { q?: string; services?: unknown[]; codes?: Map<number, unknown[]> } = {}) {
  vi.resetModules()
  const redirect = vi.fn(() => { throw new Error('NEXT_REDIRECT') })
  const listMappableServices = vi.fn(async () => opts.services ?? [
    { id: 5, code: 'PKG_KNEE', name: 'Knee replacement package', category: 'package', isActive: true },
    { id: 6, code: 'LAB_GLU', name: 'Fasting glucose', category: 'investigation_lab', isActive: true },
  ])
  const listServiceProcedureCodes = vi.fn(async () => opts.codes ?? new Map([[5, [
    { serviceId: 5, kind: 'hbp', code: 'SMP001A', isPrimary: true, display: 'SAMPLE fictional knee', isSample: true },
  ]]]))
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'Tester', userId: 5 })) }))
  vi.doMock('@/lib/queries/service-procedure-codes', () => ({ SERVICE_LIST_LIMIT: 200, listMappableServices, listServiceProcedureCodes }))
  vi.doMock('next/navigation', () => ({ redirect, useRouter: () => ({ refresh }) }))
  const { default: Page } = await import('@/app/(dashboard)/coding/service-codes/page')
  const rtl = await import('@testing-library/react')
  const run = () => Page({ searchParams: Promise.resolve(opts.q ? { q: opts.q } : {}) })
  return { rtl, run, redirect, listMappableServices, listServiceProcedureCodes }
}

describe('/coding/service-codes', () => {
  it('redirects a denied role before any load', async () => {
    for (const role of ['pi', 'billing', 'crc', 'frontdesk']) {
      const r = await renderAs(role)
      await expect(r.run()).rejects.toThrow('NEXT_REDIRECT')
      expect(r.listMappableServices).not.toHaveBeenCalled()
    }
  })

  it('lists mappable services with their codes and searches by q', async () => {
    const r = await renderAs('coder', { q: ' knee ' })
    r.rtl.render(await r.run())
    expect(r.listMappableServices).toHaveBeenCalledWith('knee')
    expect(r.listServiceProcedureCodes).toHaveBeenCalledWith([5, 6])
    const { screen } = r.rtl
    expect(screen.getByRole('heading', { name: /knee replacement package/i })).toBeInTheDocument()
    expect(screen.getByText('SMP001A')).toBeInTheDocument()
    expect(screen.getByText('Primary')).toBeInTheDocument()
    expect(screen.getByText('Sample')).toBeInTheDocument()
    expect(screen.getByText(/no procedure codes mapped/i)).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: /search services/i })).toHaveValue('knee')
  })

  it('shows an empty state', async () => {
    const r = await renderAs('admin', { services: [], codes: new Map() })
    r.rtl.render(await r.run())
    expect(r.rtl.screen.getByText(/no procedure, package or investigation services in the catalogue yet/i)).toBeInTheDocument()
  })

  it('saves an edited map with a PUT and shows refusals with their problems', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Some codes are not in the current code set', problems: ['SMP001A is not an active PM-JAY HBP package code in the current version'] }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await renderAs('coder')
    r.rtl.render(await r.run())
    const { screen, fireEvent, waitFor } = r.rtl
    fireEvent.click(screen.getByRole('button', { name: /edit procedure codes for knee replacement package/i }))
    fireEvent.click(screen.getByRole('button', { name: /save codes/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('SMP001A is not an active PM-JAY HBP package code')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/coding/services/5/procedure-codes')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ codes: [{ kind: 'hbp', code: 'SMP001A', isPrimary: true }] }) })
    fireEvent.click(screen.getByRole('button', { name: /remove smp001a/i }))
    fireEvent.click(screen.getByRole('button', { name: /save codes/i }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ codes: [] })
  })
})
