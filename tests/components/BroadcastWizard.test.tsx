import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BroadcastWizard } from '@/components/BroadcastWizard'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

afterEach(() => {
  vi.unstubAllGlobals()
})

const TRIALS = [{ id: 'nct06911112', condition: 'Major Depressive Disorder' }]

describe('BroadcastWizard', () => {
  it('disables Next until a message is entered', () => {
    render(<BroadcastWizard trials={TRIALS} />)
    expect(screen.getByText('Next: Specify Recipients')).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/Message/i), { target: { value: 'Reminder to complete your form.' } })
    expect(screen.getByText('Next: Specify Recipients')).not.toBeDisabled()
  })

  it('disables Next for SMS once the message exceeds 140 characters', () => {
    render(<BroadcastWizard trials={TRIALS} />)
    fireEvent.change(screen.getByLabelText(/Message/i), { target: { value: 'x'.repeat(141) } })
    expect(screen.getByText('Next: Specify Recipients')).toBeDisabled()
    expect(screen.getByText('141/140 characters')).toBeInTheDocument()
  })

  it('does not enforce the 140-char limit for email-only broadcasts', () => {
    render(<BroadcastWizard trials={TRIALS} />)
    fireEvent.change(screen.getByLabelText(/Channel/i), { target: { value: 'email' } })
    fireEvent.change(screen.getByLabelText(/Subject/i), { target: { value: 'Update on your study visit' } })
    fireEvent.change(screen.getByLabelText(/Message/i), { target: { value: 'x'.repeat(200) } })
    expect(screen.getByText('Next: Specify Recipients')).not.toBeDisabled()
  })

  it('requires a subject for email and "both" channels, but not for SMS', () => {
    render(<BroadcastWizard trials={TRIALS} />)
    fireEvent.change(screen.getByLabelText(/Channel/i), { target: { value: 'both' } })
    fireEvent.change(screen.getByLabelText(/Message/i), { target: { value: 'Reminder to complete your form.' } })
    expect(screen.getByText('Next: Specify Recipients')).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/Subject/i), { target: { value: 'Reminder' } })
    expect(screen.getByText('Next: Specify Recipients')).not.toBeDisabled()
  })

  it('disables advancing to Review until recipients have been previewed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ id: 'RD-0001', name: 'Maria Alvarez', phone: '909-555-0142', email: null }]), { status: 200 })))
    render(<BroadcastWizard trials={TRIALS} />)

    fireEvent.change(screen.getByLabelText(/Message/i), { target: { value: 'Reminder to complete your form.' } })
    fireEvent.click(screen.getByText('Next: Specify Recipients'))

    expect(screen.getByText('Next: Review and Send')).toBeDisabled()
    fireEvent.click(screen.getByText('Preview Recipients'))

    await screen.findByText('1 patient match this filter.')
    expect(screen.getByText('Next: Review and Send')).not.toBeDisabled()
  })
})
