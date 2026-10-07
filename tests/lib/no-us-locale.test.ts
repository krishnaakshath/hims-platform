// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Repo-wide guard (Wave A): money is INR via src/lib/format.ts and dates/times
// are IST via src/lib/india-time.ts -- pure formatters that render the same on
// the server and in the browser. So src/ must not grow new:
//   - toLocaleString / toLocaleDateString / toLocaleTimeString (viewer- or
//     server-zone dependent, hydration-mismatch prone),
//   - 'en-US' locales,
//   - Intl.DateTimeFormat / Intl.NumberFormat outside the shared time module,
//   - US-dollar currency presentation ('$' before an amount, USD).
// A genuine exception goes on the offending line (or the line above) with a
// comment containing `locale-guard-allow:` and a reason.
const SRC = join(__dirname, '..', '..', 'src')
const INTL_ALLOWED = new Set(['lib/india-time.ts'].map((p) => p.split('/').join(sep)))

const RULES: { name: string; re: RegExp; allowIn?: Set<string> }[] = [
  { name: 'toLocale*', re: /\.toLocale(Date|Time)?String\s*\(/ },
  { name: 'en-US locale', re: /['"`]en-US['"`]/ },
  { name: 'Intl formatter', re: /\bIntl\.(DateTimeFormat|NumberFormat)\b/, allowIn: INTL_ALLOWED },
  { name: '$ template amount', re: /\$\$\{/ },
  { name: '$ before cents/100', re: /(^|[\s>:·(])\$\{\([^)]*\/\s*100\b/ },
  { name: '$ label', re: /['"`(]\s*\$\s*(per\b|\)|['"`])/ },
  { name: '$ literal amount', re: /(^|[\s'"`>(])\$\s?\d[\d,]*\.\d{2}\b/ },
  { name: 'USD', re: /\bUSD\b/ },
]

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line)
const ALLOW = /locale-guard-allow:/

describe('no US locale / dollar formatting in src/', () => {
  it('finds no toLocale*, en-US, stray Intl formatters or $ amounts outside the allowlist', () => {
    const offenders: string[] = []
    for (const file of walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f))) {
      const rel = relative(SRC, file)
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (isComment(line) || ALLOW.test(line) || (i > 0 && ALLOW.test(lines[i - 1]))) return
        for (const rule of RULES) {
          if (rule.allowIn?.has(rel)) continue
          if (rule.re.test(line)) offenders.push(`${rel}:${i + 1} [${rule.name}] ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('the guard itself catches each banned form', () => {
    const samples = [
      "d.toLocaleDateString()", "x.toLocaleString('en-IN')", "fmt('en-US')", "new Intl.DateTimeFormat('en-IN')",
      "`$${v}`", "<p>Total: ${(cents / 100).toFixed(2)}</p>", 'placeholder="$ per unit"', "currency: 'USD'", "'Copay $45.00'",
    ]
    for (const s of samples) expect(RULES.some((r) => r.re.test(s)), s).toBe(true)
    for (const ok of ['formatPaise(cents)', '`${a}-${b}`', "s.replace(/x/g, '$1 ')", 'typeof t.$inferSelect']) {
      expect(RULES.some((r) => r.re.test(ok)), ok).toBe(false)
    }
  })
})
