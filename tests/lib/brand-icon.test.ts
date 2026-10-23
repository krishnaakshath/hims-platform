import { describe, it, expect } from 'vitest'
import {
  DEFAULT_ICON_COLOR,
  brandIconPalette,
  brandIconSvg,
  brandIconDataUri,
  brandShortName,
  contrastRatio,
} from '@/lib/brand-icon'

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5)
    expect(contrastRatio('#fff', '#fff')).toBeCloseTo(1, 5)
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1)
  })
})

describe('brandIconPalette', () => {
  it('falls back to the product blue with a white glyph when the colour is missing', () => {
    for (const primaryColor of [null, undefined, '', 'blue', '#12345', 'url(x)']) {
      const p = brandIconPalette({ primaryColor })
      expect(p.background).toBe(DEFAULT_ICON_COLOR)
      expect(p.foreground).toBe('#ffffff')
      expect(p.ring).toBeNull()
    }
    expect(brandIconPalette().background).toBe(DEFAULT_ICON_COLOR)
  })

  it('normalises #rgb and upper-case to #rrggbb', () => {
    expect(brandIconPalette({ primaryColor: '#0AF' }).background).toBe('#00aaff')
    expect(brandIconPalette({ primaryColor: ' #0B3D2E ' }).background).toBe('#0b3d2e')
  })

  it('keeps a white glyph on a dark brand colour', () => {
    const p = brandIconPalette({ primaryColor: '#0b3d2e' })
    expect(p.foreground).toBe('#ffffff')
    expect(contrastRatio(p.background, p.foreground)).toBeGreaterThanOrEqual(3)
  })

  it('switches to a dark (never black) glyph on a light brand colour', () => {
    for (const color of ['#f5c518', '#ffffff', '#fafafa', '#7fffd4', '#ffd1dc']) {
      const p = brandIconPalette({ primaryColor: color })
      expect(p.foreground, color).not.toBe('#ffffff')
      expect(p.foreground, color).not.toBe('#000000')
      expect(contrastRatio(p.background, p.foreground), color).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('always yields at least 3:1 glyph contrast across the colour cube', () => {
    const steps = ['00', '33', '66', '99', 'cc', 'ff']
    for (const r of steps) for (const g of steps) for (const b of steps) {
      const p = brandIconPalette({ primaryColor: `#${r}${g}${b}` })
      expect(contrastRatio(p.background, p.foreground), p.background).toBeGreaterThanOrEqual(3)
    }
  })

  it('adds an edge ring only when the tile would vanish into the tab strip', () => {
    expect(brandIconPalette({ primaryColor: '#194f81' }).ring).toBeNull()
    expect(brandIconPalette({ primaryColor: '#f5c518' }).ring).toBeNull()
    const nearWhite = brandIconPalette({ primaryColor: '#fafafa' })
    expect(nearWhite.ring).not.toBeNull()
    expect(contrastRatio(nearWhite.ring!, '#ffffff')).toBeGreaterThan(1.35)
    const nearDark = brandIconPalette({ primaryColor: '#1a1a1e' })
    expect(nearDark.ring).not.toBeNull()
    expect(contrastRatio(nearDark.ring!, '#202124')).toBeGreaterThan(1.35)
  })

  it('uses the brand colour for light theme-color and a darker shade for dark', () => {
    const p = brandIconPalette({ primaryColor: '#f5c518' })
    expect(p.themeColorLight).toBe('#f5c518')
    expect(p.themeColorDark).toMatch(/^#[0-9a-f]{6}$/)
    expect(contrastRatio(p.themeColorDark, '#000000')).toBeLessThan(contrastRatio(p.themeColorLight, '#000000'))
  })
})

describe('brandShortName', () => {
  it('keeps short names whole', () => {
    expect(brandShortName('HIMS')).toBe('HIMS')
    expect(brandShortName('Acme Health')).toBe('Acme Health')
  })

  it('uses the first word of a long name, else truncates by code point', () => {
    expect(brandShortName('Saint Mary General Hospital')).toBe('Saint')
    expect(brandShortName('Supercalifragilistic Hospital')).toBe('Supercalifra')
    expect(brandShortName('病院病院病院病院病院病院病院病院')).toBe('病院病院病院病院病院病院')
    expect(Array.from(brandShortName('🏥🏥🏥🏥🏥🏥🏥🏥🏥🏥🏥🏥🏥🏥')).length).toBe(12)
  })

  it('falls back to HIMS for empty, whitespace or control-only names', () => {
    for (const n of [null, undefined, '', '   ', '\u0000\n\t']) expect(brandShortName(n)).toBe('HIMS')
  })

  it('collapses whitespace and strips control characters', () => {
    expect(brandShortName('  Acme\n\tCare  ')).toBe('Acme Care')
  })
})

describe('brandIconSvg', () => {
  it('renders a self-contained SVG with only palette colours', () => {
    const p = brandIconPalette({ primaryColor: '#0b3d2e' })
    const svg = brandIconSvg(p)
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).toContain('fill="#0b3d2e"')
    // White plus, heartbeat cut through it in the tile colour.
    expect(svg).toContain('fill="#ffffff"')
    expect(svg).toContain('stroke="#0b3d2e"')
    expect(svg).toContain('rx="7"')
  })

  it('renders a full-bleed, padded variant for Apple/maskable icons', () => {
    const svg = brandIconSvg(brandIconPalette(), { shape: 'square', glyphScale: 0.8 })
    expect(svg).toContain('rx="0"')
    expect(svg).toContain('scale(0.8)')
  })

  it('round-trips through a base64 data URI', () => {
    const p = brandIconPalette()
    const uri = brandIconDataUri(p)
    expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(Buffer.from(uri.split(',')[1], 'base64').toString('utf-8')).toBe(brandIconSvg(p))
  })
})
