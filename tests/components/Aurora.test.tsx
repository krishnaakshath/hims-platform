import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

// Browsers without WebGL2 make ogl's Renderer constructor throw. Aurora is
// purely decorative, so it must degrade to an empty container, not crash.
vi.mock('ogl', () => ({
  Renderer: class {
    constructor() {
      throw new TypeError('WebGL2 is not supported')
    }
  },
  Program: class {},
  Mesh: class {},
  Color: class {},
  Triangle: class {},
}))

import Aurora from '@/components/Aurora'

describe('Aurora without WebGL2', () => {
  it('does not throw and renders no canvas when the Renderer constructor throws', () => {
    let container: HTMLElement | undefined
    expect(() => { ({ container } = render(<Aurora />)) }).not.toThrow()
    expect(container!.querySelector('canvas')).toBeNull()
  })
})
