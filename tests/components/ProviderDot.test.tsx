import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ProviderDot } from '@/components/ProviderDot'

describe('ProviderDot', () => {
  it('maps each known colorTag to its own chart-token class', () => {
    const tags = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5']
    const classNames = tags.map((tag) => {
      const { container } = render(<ProviderDot colorTag={tag} />)
      return container.querySelector('span')?.className
    })
    expect(new Set(classNames).size).toBe(5)
  })

  it('falls back to a neutral dot for an unrecognized colorTag', () => {
    const { container } = render(<ProviderDot colorTag="not-a-real-tag" />)
    expect(container.querySelector('span')?.className).toContain('bg-muted-foreground')
  })

  it('renders no svg icon glyph', () => {
    const { container } = render(<ProviderDot colorTag="chart-1" />)
    expect(container.querySelector('svg')).not.toBeInTheDocument()
  })
})
