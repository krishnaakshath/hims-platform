import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

// The workbook page is open to admin, crc and pi, but the full-workbook
// download (GET /api/workbook/full) is admin/crc only -- pi must not be
// shown a button that answers 403.
const state = vi.hoisted(() => ({ role: 'admin' }))
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }) }))
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: state.role, name: `Test ${state.role}`, userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/workbook', () => ({ listWorkbookRows: vi.fn(async () => []) }))
// The table is a client component with its own tests; only the page header matters here.
vi.mock('@/components/WorkbookTable', () => ({ WorkbookTable: () => null }))

import WorkbookPage from '@/app/(dashboard)/workbook/page'

afterEach(() => cleanup())

describe('workbook page download link', () => {
  it.each(['admin', 'crc'])('shows %s the Download Full Workbook link', async (role) => {
    state.role = role
    render(await WorkbookPage())
    expect(screen.getByRole('link', { name: /download full workbook/i })).toHaveAttribute('href', '/api/workbook/full')
  })

  it('hides the download link from pi but still renders the workbook', async () => {
    state.role = 'pi'
    render(await WorkbookPage())
    expect(screen.getByRole('heading', { name: /pre-screening workbook/i })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /download full workbook/i })).not.toBeInTheDocument()
  })
})
