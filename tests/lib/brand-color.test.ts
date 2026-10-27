// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseHex,
  contrastRatio,
  hexToOklch,
  oklchToHex,
  deriveAccentPalette,
  LIGHT_PAGE_BG,
  LIGHT_CARD_BG,
  DARK_PAGE_BG,
  DARK_CARD_BG,
  ON_ACCENT_LIGHT,
  ON_ACCENT_DARK,
  type Hex,
} from '@/lib/brand-color'

function channels(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
}

describe('parseHex', () => {
  it('normalises short and upper-case hex', () => {
    expect(parseHex('#ABC')).toBe('#aabbcc')
    expect(parseHex('#194F81')).toBe('#194f81')
  })
  it('rejects non-hex input', () => {
    expect(parseHex('red')).toBeNull()
    expect(parseHex('#12345')).toBeNull()
    expect(parseHex('')).toBeNull()
  })
})

describe('contrastRatio', () => {
  it('matches WCAG reference values', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 2)
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2)
  })
})

describe('oklch conversion', () => {
  it('round-trips within 1 per channel', () => {
    const { l, c, h } = hexToOklch('#336699')
    const back = channels(oklchToHex(l, c, h))
    const orig = channels('#336699')
    back.forEach((v, i) => expect(Math.abs(v - orig[i])).toBeLessThanOrEqual(1))
  })
})

const INPUTS: Hex[] = ['#194f81', '#ffe680', '#0a0a0a', '#ff0000', '#00ff00', '#ffffff', '#808080']

describe('deriveAccentPalette', () => {
  for (const input of INPUTS) {
    it(`meets AA in both themes for ${input}`, () => {
      const p = deriveAccentPalette(input)
      expect(p.input).toBe(input)
      expect(p.light.ratioText).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(p.light.primary, LIGHT_PAGE_BG)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(p.light.primary, LIGHT_CARD_BG)).toBeGreaterThanOrEqual(4.5)
      expect(p.light.ratioOnPage).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(p.dark.primary, DARK_PAGE_BG)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(p.dark.primary, DARK_CARD_BG)).toBeGreaterThanOrEqual(4.5)
      expect(p.dark.ratioOnPage).toBeGreaterThanOrEqual(4.5)
      expect(p.dark.ratioText).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(p.light.foreground, p.light.primary)).toBeCloseTo(p.light.ratioText, 6)
    })
  }

  it('leaves an already-readable colour alone in the light theme', () => {
    expect(deriveAccentPalette('#194f81').adjustedLight).toBe(false)
  })

  it('darkens a pale colour in the light theme', () => {
    const p = deriveAccentPalette('#ffe680')
    expect(p.adjustedLight).toBe(true)
    expect(hexToOklch(p.light.primary).l).toBeLessThan(hexToOklch('#ffe680').l)
  })

  it('is deterministic', () => {
    expect(deriveAccentPalette('#ffe680')).toEqual(deriveAccentPalette('#ffe680'))
  })
})

describe('background constants match globals.css', () => {
  const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')
  function token(block: RegExp, name: string): Hex {
    const b = css.match(block)![0]
    const m = b.match(new RegExp(`--${name}:\\s*oklch\\(([^)]+)\\)`))!
    const [l, c, h = '0'] = m[1].trim().split(/\s+/)
    return oklchToHex(Number(l), Number(c), Number(h))
  }
  const root = /:root\s*\{[^}]*\}/
  const dark = /\.dark\s*\{[^}]*\}/
  const near = (a: string, b: string) =>
    channels(a).forEach((v, i) => expect(Math.abs(v - channels(b)[i])).toBeLessThanOrEqual(1))

  it('light', () => {
    near(LIGHT_PAGE_BG, token(root, 'background'))
    near(LIGHT_CARD_BG, token(root, 'card'))
  })
  it('dark', () => {
    near(DARK_PAGE_BG, token(dark, 'background'))
    near(DARK_CARD_BG, token(dark, 'card'))
    near(ON_ACCENT_DARK, oklchToHex(0.18, 0.01, 60))
    expect(ON_ACCENT_LIGHT).toBe('#fcfcfc')
  })
})
