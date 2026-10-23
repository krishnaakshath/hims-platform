// Pure converter: WHO ICD-10 ClaML (the official icd102019en.xml) to the code-system importer CSV.
// Only `category` classes become rows (chapters and blocks are grouping and are dropped, so a
// three-character category has no parent). A category with subcategories is not selectable.
// Fourth-character modifiers (WHO's `ModifiedBy` on a category with no listed subcategories, such as
// E10-E14 .0-.9) are expanded into subcategory rows "<base title>: <modifier label>". The optional
// fifth-character modifiers are not expanded.
// Excludes, sex and age edits are not derived from ClaML and are left empty.
// No code-set content is stored in the repository; this file only transforms what the owner fetched.

const HEADER = 'code,display,parent_code,selectable,active,effective_from,effective_to,sex,age_min_years,age_max_years,excludes'
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''
    }
    return ENTITIES[e] ?? m
  })
}

function cleanDisplay(raw: string): string {
  let t = decode(raw.replace(/<[^>]*>/g, ' ')).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  t = t.replace(/^[=+\-@\s]+/, '') // importer forbids a leading = + - @
  return t.length > 500 ? t.slice(0, 500).trim() : t
}

function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function convertWhoIcd10(source: string): { csv: string; codeCount: number } {
  // Fourth-character modifiers: modifier code -> [[".0", label], ...]
  const fourth = new Map<string, [string, string][]>()
  const modRe = /<Modifier\s+code="([^"]+)">([\s\S]*?)<\/Modifier>/g
  let m: RegExpExecArray | null
  const fourthIds = new Set<string>()
  while ((m = modRe.exec(source)) !== null) if (/<SubClass\s+code="\./.test(m[2])) fourthIds.add(m[1])
  const mcRe = /<ModifierClass\s+([^>]*?)>([\s\S]*?)<\/ModifierClass>/g
  while ((m = mcRe.exec(source)) !== null) {
    const modifier = /modifier="([^"]+)"/.exec(m[1])?.[1]
    const code = /\scode="([^"]+)"|^code="([^"]+)"/.exec(m[1])
    const sub = code?.[1] ?? code?.[2]
    if (!modifier || !sub || !fourthIds.has(modifier) || !sub.startsWith('.')) continue
    const label = /<Rubric\s[^>]*kind="preferred"[^>]*>\s*<Label[^>]*>([\s\S]*?)<\/Label>/.exec(m[2])?.[1]
    if (label === undefined) continue
    const list = fourth.get(modifier) ?? []
    list.push([sub, cleanDisplay(label)])
    fourth.set(modifier, list)
  }

  const classRe = /<Class\s+([^>]*?)>([\s\S]*?)<\/Class>/g
  const rows: { code: string; display: string; parent: string | null; hasChildren: boolean }[] = []
  while ((m = classRe.exec(source)) !== null) {
    const attrs = m[1]
    if (!/kind="category"/.test(attrs)) continue
    const code = /code="([^"]+)"/.exec(attrs)?.[1]
    if (!code) continue
    const body = m[2]
    const label = /<Rubric\s[^>]*kind="preferred"[^>]*>\s*<Label[^>]*>([\s\S]*?)<\/Label>/.exec(body)?.[1]
    if (label === undefined) throw new Error(`Category ${code} has no preferred label`)
    const display = cleanDisplay(label)
    if (!display) throw new Error(`Category ${code} has an empty label`)
    const parent = /<SuperClass\s+code="([^"]+)"/.exec(body)?.[1] ?? null
    let hasChildren = /<SubClass\s/.test(body)
    const base = code.toUpperCase()
    rows.push({ code: base, display, parent: parent ? parent.toUpperCase() : null, hasChildren })
    if (!hasChildren) {
      const modId = [...body.matchAll(/<ModifiedBy\s+[^>]*?code="([^"]+)"/g)].map((x) => x[1]).find((id) => fourth.has(id))
      if (modId) {
        for (const [sub, subLabel] of fourth.get(modId) as [string, string][]) {
          rows.push({ code: `${base}${sub}`, display: `${display}: ${subLabel}`, parent: base, hasChildren: false })
        }
        hasChildren = true
        rows[rows.findIndex((r) => r.code === base)].hasChildren = true
      }
    }
  }
  if (rows.length === 0) throw new Error('No ICD-10 categories found in the source')
  const isCat = new Set(rows.map((r) => r.code))
  const lines = rows.map((r) => [
    r.code, csvCell(r.display), r.parent && isCat.has(r.parent) ? r.parent : '',
    r.hasChildren ? 'no' : 'yes', 'yes', '', '', '', '', '', '',
  ].join(','))
  return { csv: `${HEADER}\n${lines.join('\n')}\n`, codeCount: rows.length }
}
