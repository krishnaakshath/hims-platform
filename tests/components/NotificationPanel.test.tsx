import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NotificationPanel } from '@/components/NotificationPanel'

describe('NotificationPanel', () => {
  it('does not render for a non-admin role (the audit log is admin-only)', () => {
    render(<NotificationPanel role="crc" />)
    expect(screen.queryByLabelText('Notifications')).not.toBeInTheDocument()
  })

  it('renders the bell for an admin role', () => {
    render(<NotificationPanel role="admin" />)
    expect(screen.getByLabelText('Notifications')).toBeInTheDocument()
  })
})
