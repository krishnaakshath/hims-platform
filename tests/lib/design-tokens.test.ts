import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf-8')

function rootBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  const end = css.indexOf('}', start)
  return css.slice(start, end)
}

describe('design tokens', () => {
  // Superseded by client feedback (2026-09-28): no black anywhere in the
  // brand, including the primary color and the favicon -- see commit
  // f27057d. The near-black "ink" primary these two tests used to require
  // is exactly what got reverted; replaced with the professional blue
  // master's own separate redesign had already validated.
  it('does not use a near-black primary in :root', () => {
    const root = rootBlock('\n:root')
    const match = root.match(/--primary:\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/)
    expect(match).not.toBeNull()
    const [, lightness, chroma] = match!.map(Number) as unknown as [number, number, number, number]
    // Not both low-lightness AND low-chroma at once -- that combination is
    // what "near-black" means; a mid-lightness saturated blue like this
    // token's actual value (L=0.42, C=0.1) fails this near-black test on
    // both axes, on purpose.
    expect(lightness < 0.3 && chroma < 0.03).toBe(false)
  })

  it('uses a professional blue primary in :root (oklch(0.42 0.1 250), same value production\'s own redesign validated)', () => {
    const root = rootBlock('\n:root')
    expect(root).toMatch(/--primary:\s*oklch\(0\.42\s+0\.1\s+250\)/)
    expect(root).toMatch(/--ring:\s*oklch\(0\.42\s+0\.1\s+250\)/)
  })

  it('keeps success/warning/destructive tokens unchanged from the current values', () => {
    const root = rootBlock('\n:root')
    expect(root).toMatch(/--destructive:\s*oklch\(0\.577\s+0\.245\s+27\.325\)/)
    expect(root).toMatch(/--success:\s*oklch\(0\.596\s+0\.145\s+163\)/)
    expect(root).toMatch(/--warning:\s*oklch\(0\.58\s+0\.15\s+75\)/)
  })
})

function parseOklch(value: string): [number, number, number] {
  const m = value.match(/oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/)
  if (!m) throw new Error(`not a plain oklch() value: ${value}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function tokenValue(block: string, name: string): string {
  const m = block.match(new RegExp(`--${name}:\\s*(oklch\\([^)]*\\))`))
  if (!m) throw new Error(`token --${name} not found`)
  return m[1]
}

// Cheap perceptual-distance proxy: treat L/C/H as a 3D point (H in degrees,
// scaled down so hue differences don't dominate at typical L/C magnitudes).
// Not a real deltaE calculation, but good enough to catch the exact class of
// bug the prior chart-3/chart-1 fix addressed: two tokens landing close
// enough in all three dimensions to read as the same color at a glance.
function distance(a: [number, number, number], b: [number, number, number]): number {
  const [l1, c1, h1] = a
  const [l2, c2, h2] = b
  return Math.sqrt((l1 - l2) ** 2 * 4 + (c1 - c2) ** 2 * 4 + ((h1 - h2) / 60) ** 2)
}

describe('chart color collisions', () => {
  it('every pair of chart-1..5 tokens is visually distinguishable in :root', () => {
    const root = rootBlock('\n:root')
    const names = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5']
    const values = names.map((n) => parseOklch(tokenValue(root, n)))
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        expect(distance(values[i], values[j]), `${names[i]} vs ${names[j]}`).toBeGreaterThan(0.5)
      }
    }
  })

  it('chart tokens are also distinguishable from success/warning/destructive (verdict colors must never collide with chart colors)', () => {
    const root = rootBlock('\n:root')
    const chartNames = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5']
    const verdictNames = ['success', 'warning', 'destructive']
    for (const c of chartNames) {
      for (const v of verdictNames) {
        const dist = distance(parseOklch(tokenValue(root, c)), parseOklch(tokenValue(root, v)))
        expect(dist, `${c} vs ${v}`).toBeGreaterThan(0.4)
      }
    }
  })
})
