// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

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

/** Every `import ... from '@/lib/brand'` statement (possibly multi-line), as one string. */
function brandImports(source: string): string[] {
  return [...source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]@\/lib\/brand['"]/g)]
    .filter((m) => !m[1]) // `import type { ... }` carries no value
    .map((m) => m[2])
}

function valueNames(specifiers: string): string[] {
  return specifiers.split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('type '))
    .map((s) => s.split(/\s+as\s+/)[0].trim())
}

const FILES = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f))

describe('no synchronous brand import in src/', () => {
  it('no file imports the removed `brand` value from @/lib/brand', () => {
    const offenders = FILES.filter((f) => brandImports(readFileSync(f, 'utf8')).some((s) => valueNames(s).includes('brand')))
      .map((f) => relative(SRC, f))
    expect(offenders).toEqual([])
  })

  it('no default or namespace import of @/lib/brand (which would reach the env brand indirectly)', () => {
    const offenders = FILES.filter((f) => /import\s+(\*\s+as\s+\w+|\w+)\s+from\s*['"]@\/lib\/brand['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f))
    expect(offenders).toEqual([])
  })

  it('envBrand is value-imported only by the allowed files', () => {
    const offenders = FILES.filter((f) => !ENV_BRAND_ALLOWED.has(relative(SRC, f)))
      .filter((f) => brandImports(readFileSync(f, 'utf8')).some((s) => valueNames(s).includes('envBrand')))
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
  })
})
