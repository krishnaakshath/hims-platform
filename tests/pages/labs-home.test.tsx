import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LAB_STAGE_STATUSES, parseLabStage } from '@/lib/labs/worklist-stage'

// Wave E P1-15: the labs home. Stage tiles count exactly the worklist
// sections and link to that section; day figures (resulted, critical, TAT)
// come from the KPI loader.
afterEach(() => { cleanup() })

const order = (id: number, status: string) => ({ id, status, patientId: 'RD-1', patientName: 'P', testName: 'T', testCode: 'X', orderedAt: new Date(), collectedAt: null, category: 'lab', attachments: [], orderedByProviderId: 1, orderedByProviderName: 'D' })

// WS4 T12: one open critical alert on the worklist banner.
const CRITICAL_ALERT = {
  orderId: 5, patientId: 'RD-1', patientName: 'Lakshmi Iyer', uhid: 'UH000123', testName: 'Complete Blood Count', summary: 'Platelets 38 ×10³/µL; Haemoglobin 6.5 g/dL',
  status: 'open', raisedAt: '2026-10-24T04:30:00.000Z', notifiedAt: null, notifiedByName: null, notifiedToName: null, notifyChannel: null, readBack: null,
  acknowledgedAt: null, acknowledgedByName: null, orderedByProviderId: 1,
}

async function renderLabs(role: string, searchParams: Record<string, string> = {}) {
  vi.resetModules()
  vi.doMock('next/navigation', () => ({ redirect: () => { throw new Error('NEXT_REDIRECT') }, useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) })) // WS4 T12: useRouter for the banner actions
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'Test', userId: null })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
  vi.doMock('@/lib/queries/lab-orders', () => ({
    listWorklist: vi.fn(async () => [order(1, 'ordered'), order(2, 'scheduled'), order(3, 'collected'), order(4, 'received'), order(5, 'resulted'), order(6, 'resulted'), order(7, 'verified')]),
    listPatientsWithLabOrders: vi.fn(async () => []),
  }))
  vi.doMock('@/lib/queries/lab-tests', () => ({ listLabTests: vi.fn(async () => []) }))
  vi.doMock('@/lib/queries/hospital-kpis', () => ({
    getLabKpis: vi.fn(async () => ({ awaitingCollection: 0, inTransit: 0, atBench: 0, toVerify: 0, toReport: 0, criticalUnverified: 1, resultedToday: 9, criticalToday: 2, medianTatMinutes: 75, criticalOpen: 1 })),
  }))
  vi.doMock('@/lib/queries/lab-critical', () => ({ listOpenCriticalAlerts: vi.fn(async () => [CRITICAL_ALERT]), acknowledgeableCriticalOrderIds: vi.fn(async () => []) })) // WS4 T12
  vi.doMock('@/components/LabWorklist', () => ({ LabWorklist: ({ stage }: { stage?: string | null }) => <p>worklist stage={String(stage ?? 'none')}</p> }))
  vi.doMock('@/components/LabsPatientReports', () => ({ LabsPatientReports: () => null }))
  vi.doMock('@/components/Tabs', () => ({ Tabs: ({ tabs, initialId }: { tabs: { id: string; content: React.ReactNode }[]; initialId?: string }) => <div data-initial={initialId ?? tabs[0].id}>{tabs.map((t) => <div key={t.id}>{t.content}</div>)}</div> }))
  const { default: Page } = await import('@/app/(dashboard)/labs/page')
  const { render, screen } = await import('@testing-library/react')
  const { container } = render(await Page({ searchParams: Promise.resolve(searchParams) }))
  return { screen, container }
}

function tile(container: HTMLElement, label: string) {
  const el = [...container.querySelectorAll('[data-kpi-label]')].find((e) => e.textContent === label)
  return { value: el?.previousElementSibling?.textContent, href: el?.closest('a')?.getAttribute('href') }
}

describe('parseLabStage', () => {
  it('accepts the stage slugs and "all", nothing else', () => {
    expect(parseLabStage('to-verify')).toBe('to-verify')
    expect(parseLabStage('all')).toBe('all')
    expect(parseLabStage('resulted')).toBeNull()
    expect(parseLabStage(undefined)).toBeNull()
    expect(parseLabStage(['to-collect', 'x'])).toBe('to-collect')
  })
  it('stage statuses partition the worklist sections', () => {
    expect(LAB_STAGE_STATUSES['to-collect']).toEqual(['ordered', 'scheduled'])
    expect(LAB_STAGE_STATUSES['to-verify']).toEqual(['resulted'])
  })
})

describe('labs home (Wave E P1-15)', () => {
  it('stage tiles count the worklist sections and link to that section', async () => {
    const { container } = await renderLabs('labs')
    expect(tile(container, 'Awaiting collection')).toEqual({ value: '2', href: '/labs?stage=to-collect' })
    expect(tile(container, 'In transit')).toEqual({ value: '1', href: '/labs?stage=in-transit' })
    expect(tile(container, 'At the bench')).toEqual({ value: '1', href: '/labs?stage=at-bench' })
    expect(tile(container, 'To verify')).toEqual({ value: '2', href: '/labs?stage=to-verify' })
  })

  it('adds critical-open (N today), resulted-today and median TAT figures', async () => {
    const { container } = await renderLabs('labs')
    expect(tile(container, 'Critical open')).toEqual({ value: '1', href: '/labs?stage=to-verify' }) // WS4 T12
    expect(container.textContent).toContain('2 today')
    expect(tile(container, 'Resulted today')).toEqual({ value: '9', href: '/labs?stage=all' })
    expect(tile(container, 'Median TAT today')).toEqual({ value: '1 h 15 min', href: '/labs?stage=all' })
  })

  it('a stage link opens the worklist tab filtered to that stage', async () => {
    const { container, screen } = await renderLabs('labs', { stage: 'to-verify' })
    expect(container.querySelector('[data-initial]')?.getAttribute('data-initial')).toBe('worklist')
    expect(screen.getByText('worklist stage=to-verify')).toBeTruthy()
  })

  it('no stage: patient-first tab, unfiltered worklist; an unknown stage is ignored', async () => {
    const a = await renderLabs('labs')
    expect(a.container.querySelector('[data-initial]')?.getAttribute('data-initial')).toBe('by-patient')
    cleanup()
    const b = await renderLabs('labs', { stage: 'bogus' })
    expect(b.screen.getByText('worklist stage=none')).toBeTruthy()
  })

  // WS4 T12
  it('shows the critical banner with Log call for the lab and no Acknowledge', async () => {
    const { screen } = await renderLabs('labs')
    expect(screen.getByText(/CRITICAL · Platelets 38 ×10³\/µL; Haemoglobin 6\.5 g\/dL · Lakshmi Iyer \(UH000123\)/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /log the call/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /acknowledge/i })).toBeNull()
  })
  // end WS4 T12

  it('the pi gets the same tiles (it verifies results)', async () => {
    const { container } = await renderLabs('pi')
    expect(tile(container, 'To verify').href).toBe('/labs?stage=to-verify')
  })
})
