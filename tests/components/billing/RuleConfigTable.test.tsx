import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RuleConfigTable } from '@/components/billing/RuleConfigTable'
import { CHARGE_RULES } from '@/lib/billing/charge-rules'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const ROWS = CHARGE_RULES.map((r) => ({ ...r, enabled: true, severity: null, effectiveSeverity: r.defaultSeverity }))
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => { fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 })); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => vi.unstubAllGlobals())

describe('RuleConfigTable', () => {
  it('rule table is read-only for billing and editable for admin; non-configurable rules never editable', async () => {
    const { unmount } = render(<RuleConfigTable rows={ROWS} editable={false} />)
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    expect(screen.getByText('A tariff rate or manual price covers the service')).toBeInTheDocument()
    unmount()

    render(<RuleConfigTable rows={ROWS} editable />)
    const configurable = CHARGE_RULES.filter((r) => r.configurable)
    expect(screen.getAllByRole('checkbox')).toHaveLength(configurable.length)
    expect(screen.queryByRole('checkbox', { name: /A tariff rate or manual price/ })).toBeNull()
    fireEvent.change(screen.getByRole('combobox', { name: 'Severity: No duplicate charge on the same day' }), { target: { value: 'warn' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/billing/rules/duplicate_charge')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ enabled: true, severity: 'warn' })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled: Quantity within the service limit' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ enabled: false, severity: null })
  })
})
