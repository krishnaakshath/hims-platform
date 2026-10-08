// SP5 Task 15: the portal's "Your lab reports" page.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const redirect = vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) })
vi.mock('next/navigation', () => ({ redirect: (u: string) => redirect(u), notFound: () => { throw new Error('NEXT_NOT_FOUND') } }))
let sessionPatient: string | null = 'RD-0001'
vi.mock('@/lib/patient-session', () => ({
  requirePatientSessionOrRedirect: vi.fn(async () => {
    if (!sessionPatient) redirect('/patient-portal/login')
    return { patientId: sessionPatient }
  }),
}))
vi.mock('@/lib/patient-portal-audit', () => ({ logPatientPortalAction: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/lab-reports', () => ({ listPortalLabReports: vi.fn(async () => []) }))

import Page from '@/app/patient-portal/(authenticated)/lab-reports/page'
import { listPortalLabReports } from '@/lib/queries/lab-reports'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'

beforeEach(() => {
  sessionPatient = 'RD-0001'
  vi.mocked(listPortalLabReports).mockReset().mockResolvedValue([])
  vi.mocked(logPatientPortalAction).mockClear()
})

describe('/patient-portal/lab-reports', () => {
  it('lists only the session patient\'s current reports with download links', async () => {
    vi.mocked(listPortalLabReports).mockResolvedValue([
      { id: 42, reportNumber: 'LR-2099-000008', releasedAt: new Date('2099-08-02T06:30:00Z'), testSummary: 'HbA1c, TSH' },
      { id: 7, reportNumber: 'LR-2099-000002', releasedAt: new Date('2099-07-01T05:00:00Z'), testSummary: 'Lipid profile' },
    ])
    render(await Page())
    expect(listPortalLabReports).toHaveBeenCalledWith('RD-0001')
    expect(screen.getByRole('heading', { name: 'Your lab reports' })).toBeInTheDocument()
    expect(screen.getByText('HbA1c, TSH')).toBeInTheDocument()
    expect(screen.getByText(/Released 2 Aug 2099, 12:00 pm/)).toBeInTheDocument()
    expect(screen.getByText('Report LR-2099-000008')).toBeInTheDocument()
    const links = screen.getAllByRole('link', { name: /download/i })
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/api/patient-portal/lab-reports/42/download', '/api/patient-portal/lab-reports/7/download'])
    expect(logPatientPortalAction).toHaveBeenCalledWith('viewed patient portal lab reports', 'RD-0001')
  })

  it('shows the empty state', async () => {
    render(await Page())
    expect(screen.getByText('No lab reports yet. Reports appear here once your doctor has verified the results.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /download/i })).toBeNull()
  })

  it('redirects to the portal login without a patient session, before any query', async () => {
    sessionPatient = null
    await expect(Page()).rejects.toThrow('NEXT_REDIRECT:/patient-portal/login')
    expect(listPortalLabReports).not.toHaveBeenCalled()
  })
})
