import { describe, it, expect, vi } from 'vitest'
import type { ReactElement } from 'react'

vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'admin', name: 'T', userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/patients', () => ({ listPatientNameOptions: vi.fn(async () => []) }))
vi.mock('@/lib/queries/admissions', () => ({ listActiveAdmissions: vi.fn(async () => []) }))
vi.mock('@/components/DocumentsReportTable', () => ({ DocumentsReportTable: () => null }))

// Simulates a Redis cache HIT: the real getOrSetCache would hand back
// JSON-parsed data, so every Date column is an ISO string, not a Date.
const hit = JSON.parse(
  JSON.stringify([
    { id: 1, name: 'a.pdf', documentDate: '2026-09-01', filedAt: new Date('2026-09-02T10:00:00Z'), createdAt: new Date('2026-09-01T10:00:00Z'), patientName: null, patientDob: null },
    { id: 2, name: 'b.pdf', documentDate: '2026-09-01', filedAt: null, createdAt: new Date('2026-09-01T11:00:00Z'), patientName: null, patientDob: null },
  ]),
)
vi.mock('@/lib/cache', () => ({
  getOrSetCache: vi.fn(async () => hit),
  documentsListCacheKey: () => 'documents:list:all',
}))

import DocumentsPage from '@/app/(dashboard)/documents/page'
import DocumentsLayout from '@/app/(dashboard)/documents/layout'
import { render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({ usePathname: () => '/documents', redirect: vi.fn() }))

describe('/documents page on a cache hit', () => {
  it('renders without throwing and passes ISO strings through', async () => {
    const el = (await DocumentsPage()) as ReactElement<{ rows: { filedAt: string | null; createdAt: string }[] }>
    expect(el.props.rows[0].filedAt).toBe('2026-09-02T10:00:00.000Z')
    expect(el.props.rows[1].filedAt).toBeNull()
    expect(el.props.rows[0].createdAt).toBe('2026-09-01T10:00:00.000Z')
  })
})

describe('/documents layout wording', () => {
  it('titles the page "Document inbox" and labels the demo fax tab "Fax log (demo)"', async () => {
    vi.stubEnv('DEMO_FEATURES', 'true')
    render(await DocumentsLayout({ children: null }))
    vi.unstubAllEnvs()
    expect(screen.getByRole('heading', { level: 1, name: 'Document inbox' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Document inbox' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Fax log (demo)' })).toBeInTheDocument()
  })

  it('shows no fax tab when demo features are off', async () => {
    vi.stubEnv('DEMO_FEATURES', 'false')
    render(await DocumentsLayout({ children: null }))
    vi.unstubAllEnvs()
    expect(screen.queryByText(/fax/i)).not.toBeInTheDocument()
  })
})
