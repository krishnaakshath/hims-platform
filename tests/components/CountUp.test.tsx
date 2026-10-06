import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { CountUp } from '@/components/CountUp'

// Task 17: the live dashboard was read mid-animation (or with rAF paused in a
// background tab) and showed 30 for 66 patients, 1 for 3 booking requests.
// The number in the DOM must be the true value from the first render -- the
// server HTML, a frozen tab, a screen reader and a screenshot all read it.
describe('CountUp', () => {
  it('renders the real target value on first render, not 0 or a mid-animation value', () => {
    render(<CountUp to={66} />)
    expect(screen.getByText('66')).toBeInTheDocument()
  })

  it('settles on the new value when the target changes (e.g. after router.refresh())', async () => {
    const { rerender } = render(<CountUp to={3} duration={20} />)
    rerender(<CountUp to={5} duration={20} />)
    await waitFor(() => expect(screen.getByText('5')).toBeInTheDocument())
  })
})
