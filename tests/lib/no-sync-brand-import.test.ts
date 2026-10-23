// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

// WL T10 guard: the brand is resolved per request (`await getBrand()` on the server, `useBrand()` in
// client components), so nothing in src/ may read the synchronous env-only brand object. The
// deprecated `brand` alias is gone from src/lib/brand.ts; this keeps it (and a stray value import of
// `envBrand`, which would silently ignore Settings > Branding) from coming back.
const SRC = join(__dirname, '..', '..', 'src')

// Files allowed a VALUE import of `envBrand` from '@/lib/brand', and why:
const ENV_BRAND_ALLOWED = new Set([
  // brand.ts defines it.
  'lib/brand.ts',
  // getBrand() layers the stored settings over the env brand (and falls back to it on a DB failure).
  'lib/brand-server.ts',
  // The branding admin payload shows the env value behind every field ("Reset" restores it).
  'lib/queries/brand-settings.ts',
].map((p) => p.split('/').join(sep)))
// The cookie modules (proxy.ts, lib/auth.ts, lib/patient-session.ts, lib/mfa-pending-session.ts)
// need no entry: they import `cookieName`, whose default argument is `envBrand` inside brand.ts, so
// cookie names stay env-only and synchronous without importing the env brand themselves.

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

// The brand module however it is named: '@/lib/brand' or a relative path that resolves to
// src/lib/brand(.ts) from the importing file ('./brand', '../brand', '../lib/brand', ...).
const BRAND_MODULE = join(SRC, 'lib', 'brand')
// A notional importer for the self-tests below (src/components/Probe.tsx).
const PROBE = join(SRC, 'components', 'Probe.tsx')

function isBrandModule(specifier: string, file: string): boolean {
  let target: string
  if (specifier.startsWith('@/')) target = join(SRC, specifier.slice(2))
  else if (specifier.startsWith('.')) target = join(dirname(file), specifier)
  else return false
  return target.replace(/\.(ts|tsx|js|mjs)$/, '') === BRAND_MODULE
}

const SPECIFIER = String.raw`['"]([^'"]+)['"]`
// `import { ... } from`, `import Default, { ... } from` and `export { ... } from` (possibly multi-line).
const NAMED_RE = new RegExp(String.raw`\b(?:import|export)\s+(type\s+)?(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*` + SPECIFIER, 'g')
// Shapes that reach every export, envBrand included: a default or namespace import, `export * from`
// and a dynamic `import(...)`.
const WHOLE_RE = new RegExp([
  String.raw`\bimport\s+(?!type\b)(?:\*\s*as\s+\w+|\w+)\s*(?:,\s*\{[^}]*\}\s*)?from\s*` + SPECIFIER,
  String.raw`\bexport\s+\*\s*(?:as\s+\w+\s+)?from\s*` + SPECIFIER,
  String.raw`\bimport\s*\(\s*` + SPECIFIER + String.raw`\s*\)`,
].join('|'), 'g')

/** The specifier list of every value import/re-export of the brand module (`type`-only ones carry no value). */
function brandImports(source: string, file: string = PROBE): string[] {
  return [...source.matchAll(NAMED_RE)]
    .filter((m) => !m[1] && isBrandModule(m[3], file))
    .map((m) => m[2])
}

/** Every default, namespace, `export *` or dynamic import of the brand module. */
function wholeBrandImports(source: string, file: string = PROBE): string[] {
  return [...source.matchAll(WHOLE_RE)]
    .filter((m) => isBrandModule(m[1] ?? m[2] ?? m[3], file))
    .map((m) => m[0])
}

function valueNames(specifiers: string): string[] {
  return specifiers.split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('type '))
    .map((s) => s.split(/\s+as\s+/)[0].trim())
}

const FILES = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f))

describe('no synchronous brand import in src/', () => {
  it('no file imports the removed `brand` value from @/lib/brand', () => {
    const offenders = FILES.filter((f) => brandImports(readFileSync(f, 'utf8'), f).some((s) => valueNames(s).includes('brand')))
      .map((f) => relative(SRC, f))
    expect(offenders).toEqual([])
  })

  it('no default, namespace, `export *` or dynamic import of the brand module (which would reach the env brand indirectly)', () => {
    const offenders = FILES.filter((f) => wholeBrandImports(readFileSync(f, 'utf8'), f).length > 0)
      .map((f) => relative(SRC, f))
    expect(offenders).toEqual([])
  })

  it('envBrand is value-imported only by the allowed files', () => {
    const offenders = FILES.filter((f) => !ENV_BRAND_ALLOWED.has(relative(SRC, f)))
      .filter((f) => brandImports(readFileSync(f, 'utf8'), f).some((s) => valueNames(s).includes('envBrand')))
      .map((f) => relative(SRC, f))
    expect(offenders).toEqual([])
  })

  it('brand.ts no longer exports the deprecated `brand` alias', async () => {
    const mod = await import('@/lib/brand')
    expect('brand' in mod).toBe(false)
    expect(mod.envBrand).toBeDefined()
  })

  it('the guard itself recognises the forbidden shapes', () => {
    expect(brandImports(`import { brand } from '@/lib/brand'`).flatMap(valueNames)).toEqual(['brand'])
    expect(brandImports(`import {\n  cookieName,\n  brand as b,\n} from "@/lib/brand"`).flatMap(valueNames)).toEqual(['cookieName', 'brand'])
    expect(brandImports(`import type { Brand } from '@/lib/brand'`)).toEqual([])
    expect(brandImports(`import { type Brand, envBrand } from '@/lib/brand'`).flatMap(valueNames)).toEqual(['envBrand'])
    // Other modules whose names start with "brand" are not the brand module.
    expect(brandImports(`import { getBrand } from '@/lib/brand-server'`)).toEqual([])
    expect(brandImports(`import { envBrand } from '@/lib/brand-resolve'`)).toEqual([])
  })

  it('the guard recognises relative imports of the brand module', () => {
    const inLib = join(SRC, 'lib', 'queries', 'x.ts')
    expect(brandImports(`import { envBrand } from './brand'`, join(SRC, 'lib', 'x.ts')).flatMap(valueNames)).toEqual(['envBrand'])
    expect(brandImports(`import { envBrand } from '../brand'`, inLib).flatMap(valueNames)).toEqual(['envBrand'])
    expect(brandImports(`import { brand } from '../lib/brand'`).flatMap(valueNames)).toEqual(['brand'])
    expect(brandImports(`import { envBrand } from '../lib/brand.ts'`).flatMap(valueNames)).toEqual(['envBrand'])
    // A relative path that resolves elsewhere is not the brand module.
    expect(brandImports(`import { envBrand } from './brand'`)).toEqual([])
    expect(brandImports(`import { envBrand } from '../lib/brand-server'`)).toEqual([])
  })

  it('the guard recognises re-exports of the brand module', () => {
    expect(brandImports(`export { envBrand } from '@/lib/brand'`).flatMap(valueNames)).toEqual(['envBrand'])
    expect(brandImports(`export { envBrand as fallbackBrand } from '../lib/brand'`).flatMap(valueNames)).toEqual(['envBrand'])
    expect(brandImports(`export type { Brand } from '@/lib/brand'`)).toEqual([])
    expect(wholeBrandImports(`export * from '@/lib/brand'`)).toHaveLength(1)
    expect(wholeBrandImports(`export * as b from '../lib/brand'`)).toHaveLength(1)
  })

  it('the guard recognises default, namespace and dynamic imports of the brand module', () => {
    expect(wholeBrandImports(`import * as b from '@/lib/brand'`)).toHaveLength(1)
    expect(wholeBrandImports(`import b from '../lib/brand'`)).toHaveLength(1)
    expect(wholeBrandImports(`import b, { cookieName } from '@/lib/brand'`)).toHaveLength(1)
    expect(wholeBrandImports(`const { envBrand } = await import('@/lib/brand')`)).toHaveLength(1)
    expect(wholeBrandImports(`const m = await import( "../lib/brand" )`)).toHaveLength(1)
    expect(wholeBrandImports(`import type * as B from '@/lib/brand'`)).toEqual([])
    expect(wholeBrandImports(`const m = await import('@/lib/brand-server')`)).toEqual([])
    expect(wholeBrandImports(`import { cookieName } from '@/lib/brand'`)).toEqual([])
  })
})
