// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { render } from '@testing-library/react'
import { LocalDateTime } from '@/components/LocalDateTime'

const ISO = '2026-10-05T14:03:00.000Z' // 7:33 pm IST

// Wave A: hospital time (IST) is rendered identically on the server and in the
// browser, so the server HTML already carries the text and hydration agrees.
describe('LocalDateTime', () => {
  it('server render emits the IST date-time inside a time element', () => {
    const html = renderToString(<LocalDateTime iso={ISO} />)
    expect(html).toContain(`dateTime="${ISO}"`)
    expect(html).toContain('5 Oct 2026, 7:33 pm IST')
  })

  it('client render matches the server render exactly', () => {
    const server = document.createElement('div')
    server.innerHTML = renderToString(<LocalDateTime iso={ISO} />)
    const { container } = render(<LocalDateTime iso={ISO} />)
    expect(container.textContent).toBe(server.textContent)
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
