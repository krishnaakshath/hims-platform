// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { render, screen } from '@testing-library/react'
import { LocalDateTime } from '@/components/LocalDateTime'

const ISO = '2026-10-05T14:03:00.000Z'

describe('LocalDateTime', () => {
  it('server render emits a time element with no locale text', () => {
    const html = renderToString(<LocalDateTime iso={ISO} />)
    expect(html).toContain(`dateTime="${ISO}"`)
    expect(html).not.toContain(new Date(ISO).toLocaleString())
  })

  it('client render shows the browser-local string', () => {
    render(<LocalDateTime iso={ISO} />)
    expect(screen.getByText(new Date(ISO).toLocaleString())).toBeTruthy()
  })

  it('does not throw on an invalid ISO and renders a dash', () => {
    expect(() => renderToString(<LocalDateTime iso="not-a-date" />)).not.toThrow()
    const { container } = render(<LocalDateTime iso="not-a-date" />)
    expect(container.textContent).toBe('—')
  })

  it('passes className through', () => {
    const { container } = render(<LocalDateTime iso={ISO} className="text-xs" />)
    expect(container.querySelector('time')?.className).toBe('text-xs')
  })
})
