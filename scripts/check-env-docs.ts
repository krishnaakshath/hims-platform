// npm run check:env-docs
//
// Fails when src/ reads a configuration variable that is neither documented in
// .env.docker.example (the single source for every setting, Docker-only
// deployment) nor listed in ALLOWED_UNDOCUMENTED below. New config must be
// added to .env.docker.example (with a comment) in the same change.
//
// What counts as "reading" a variable (static scan, no execution):
//   - process.env.NAME, process.env['NAME'], env.NAME, env['NAME']
//     (the codebase passes `env = process.env` into pure helpers)
//   - FOO_ENV = 'NAME' constants (src/lib/demo-features.ts, src/lib/features.ts)
//   - quoted names with an integration prefix ('BRAND_...', 'ABDM_...', 'NHCX_...', ...)
//     read through a lookup table rather than a member access
import fs from 'node:fs'
import path from 'node:path'

/** Read in src/ but deliberately not in .env.docker.example, with the reason. */
export const ALLOWED_UNDOCUMENTED: Record<string, string> = {
  NODE_ENV: 'set by Next.js / the Dockerfile (production), never by the operator',
  NEXT_RUNTIME: 'set by Next.js itself',
}

const MEMBER = /\benv(?:\.([A-Z][A-Z0-9_]+)|\[\s*['"`]([A-Z][A-Z0-9_]+)['"`]\s*\])/g
const ENV_CONST = /\b[A-Z][A-Z0-9_]*_ENV\s*=\s*['"`]([A-Z][A-Z0-9_]+)['"`]/g
const PREFIXED = /['"`]((?:BRAND|ABDM|ABHA|NHCX|SMTP|TWILIO|WHATSAPP|SMS|BLOB|KV_REST|SEED|HOSPITAL_UPI)_[A-Z0-9_]+)['"`]/g

/** Every variable name the source text reads. */
export function envNamesRead(source: string): Set<string> {
  const out = new Set<string>()
  for (const m of source.matchAll(MEMBER)) out.add(m[1] ?? m[2])
  for (const m of source.matchAll(ENV_CONST)) out.add(m[1])
  for (const m of source.matchAll(PREFIXED)) out.add(m[1])
  return out
}

/** Names assigned (commented out or not) in an env example file: `NAME=` or `# NAME=`. */
export function documentedNames(exampleText: string): Set<string> {
  const out = new Set<string>()
  for (const line of exampleText.split('\n')) {
    const m = /^\s*#?\s*([A-Z][A-Z0-9_]+)=/.exec(line)
    if (m) out.add(m[1])
  }
  return out
}

/** Sorted names read but neither documented nor allow-listed. */
export function undocumentedNames(read: Iterable<string>, documented: Set<string>, allowed: Record<string, string> = ALLOWED_UNDOCUMENTED): string[] {
  return [...new Set(read)].filter((n) => !documented.has(n) && !(n in allowed)).sort()
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listSourceFiles(p))
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(p)
  }
  return out
}

/** Scans <root>/src against <root>/.env.docker.example. */
export function checkEnvDocs(root: string): { read: string[]; missing: string[] } {
  const read = new Set<string>()
  for (const f of listSourceFiles(path.join(root, 'src'))) {
    for (const n of envNamesRead(fs.readFileSync(f, 'utf8'))) read.add(n)
  }
  const documented = documentedNames(fs.readFileSync(path.join(root, '.env.docker.example'), 'utf8'))
  return { read: [...read].sort(), missing: undocumentedNames(read, documented) }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)
if (isMain) {
  const { read, missing } = checkEnvDocs(process.cwd())
  if (missing.length > 0) {
    console.error(`Read in src/ but not documented in .env.docker.example: ${missing.join(', ')}`)
    console.error('Add each to .env.docker.example (placeholder value and a comment), or to ALLOWED_UNDOCUMENTED in scripts/check-env-docs.ts with a reason.')
    process.exit(1)
  }
  console.log(`ok: all ${read.length} variables read in src/ are documented`)
}
