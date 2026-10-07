import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DepartmentsPanel } from '@/components/settings/DepartmentsPanel'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const d = (o: object) => ({ id: 1, code: 'CARDIO', name: 'Cardiology', kind: 'clinical', isActive: true, createdAt: new Date(), ...o }) as never

describe('DepartmentsPanel', () => {
  it('shows add form only to admins', () => {
    const { unmount } = render(<DepartmentsPanel departments={[d({})]} isAdmin />)
    expect(screen.getByRole('button', { name: /add department/i })).toBeInTheDocument()
    unmount()
    render(<DepartmentsPanel departments={[d({})]} isAdmin={false} />)
    expect(screen.queryByRole('button', { name: /add department/i })).toBeNull()
    expect(screen.getByText('Cardiology')).toBeInTheDocument()
  })
  it('lists inactive departments with an Inactive badge', () => {
    render(<DepartmentsPanel departments={[d({}), d({ id: 2, code: 'LAB', name: 'Laboratory', isActive: false })]} isAdmin={false} />)
    expect(screen.getAllByText('Inactive')).toHaveLength(1)
  })
})
