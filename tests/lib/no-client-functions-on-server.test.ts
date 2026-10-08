import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// A server module (no 'use client') may render a client component, but every
// other export of a 'use client' module (a helper function, a constant) is a
// client reference on the server: calling it throws "Attempted to call X()
// from the server but X is on the client" at render time, which tsc and the
// unit tests (jsdom, no RSC boundary) never see. Found by the HTTP role/route
// matrix on /coding/encounters/[id] (codingActionAvailable). Pure helpers
// shared by both sides belong in a module without 'use client'.

const SRC = path.resolve(__dirname, '../../src')

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : []
  })
}

const isClientModule = (src: string) => /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*\s*['"]use client['"]/.test(src)

function resolveImport(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec)
  else return null
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand
  }
  return null
}

// Server-side entry points only: app routes, pages, layouts and the modules they reach without
// crossing a 'use client' boundary. Approximated as every non-client file under src/app plus
// non-client components imported by them.
function serverFiles(all: Map<string, string>): Set<string> {
  const out = new Set<string>()
  const queue = [...all.keys()].filter((f) => f.includes(`${path.sep}app${path.sep}`) && !isClientModule(all.get(f)!))
  while (queue.length) {
    const f = queue.pop()!
    if (out.has(f)) continue
    out.add(f)
    for (const m of all.get(f)!.matchAll(/import\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
      const target = resolveImport(f, m[1])
      if (target && all.has(target) && !isClientModule(all.get(target)!)) queue.push(target)
    }
  }
  return out
}

describe('server modules use only components from client modules', () => {
  it('never imports a non-component export of a "use client" module into server code', () => {
    const all = new Map(walk(SRC).map((f) => [f, fs.readFileSync(f, 'utf8')]))
    const violations: string[] = []
    for (const f of serverFiles(all)) {
      const src = all.get(f)!
      for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g)) {
        if (m[1]) continue
        const target = resolveImport(f, m[3])
        if (!target || !all.has(target) || !isClientModule(all.get(target)!)) continue
        for (const raw of m[2].split(',')) {
          const name = raw.trim().replace(/\s+as\s+\w+$/, '')
          if (!name || name.startsWith('type ')) continue
          if (!/^[A-Z][A-Za-z0-9]*$/.test(name) || /^[A-Z0-9_]+$/.test(name)) {
            violations.push(`${path.relative(SRC, f)} imports ${name} from ${path.relative(SRC, target)}`)
          }
        }
      }
    }
    expect(violations).toEqual([])
  })
})
