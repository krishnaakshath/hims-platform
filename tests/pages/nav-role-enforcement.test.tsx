import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { ALL_ROLES, PAGE_GATES, gateIt, mockGetDb, mockRedirect, runPage } from './page-gates-harness'
import { NAV_ITEMS, NAV_TRAILING_ITEMS, NAV_BILLING_ITEMS, BILLING_ROLES } from '@/components/LeftNav'

// The harness itself (PageGateCase, runPage, PAGE_GATES, ALL_ROLES, and the
// mockRedirect/mockGetDb spies) lives in ./page-gates-harness.ts, a plain
// (non-`.test.`) module, so later tasks can import and extend PAGE_GATES
// without vitest re-registering the describe/it blocks below a second time.

// expect.soft so a red run lists every offending role, not just the first.
// A gap-tagged row's allowed and denied halves are separate tests so only
// the open half runs under `it.fails` (PageGateCase.gapOnly).
describe.each(PAGE_GATES)('$route', (c) => {
  const allowedGap = c.gapOnly === 'allowed' ? c.gap : undefined
  const deniedGap = c.gapOnly === 'allowed' ? undefined : c.gap

  gateIt({ gap: allowedGap })('admits every role the nav shows', async () => {
    for (const role of ALL_ROLES.filter((r) => c.allowed.includes(r))) {
      await runPage(c, role)
      expect.soft(mockRedirect, `${c.route} must not redirect ${role}`).not.toHaveBeenCalled()
    }
  })

  gateIt({ gap: deniedGap })('redirects every role the nav hides', async () => {
    for (const role of ALL_ROLES.filter((r) => !c.allowed.includes(r))) {
      await runPage(c, role)
      expect.soft(mockRedirect, `${c.route} must redirect ${role}`).toHaveBeenCalledWith(c.deniedRedirect?.[role] ?? '/')
    }
  })

  // Review Focus #1
  gateIt({ gap: deniedGap })('never touches the database for a role it denies', async () => {
    for (const role of ALL_ROLES.filter((r) => !c.allowed.includes(r))) {
      await runPage(c, role)
      expect.soft(mockGetDb, `${c.route} loaded data before denying ${role}`).not.toHaveBeenCalled()
    }
  })
})

function coveringRows(href: string) {
  const exact = PAGE_GATES.filter((r) => r.route === href)
  if (exact.length > 0) return exact
  return PAGE_GATES.filter((r) => r.route.startsWith(`${href}/`))
}

// Nav entries whose LeftNav roles knowingly disagree with POLICY.md's page
// gate until the named task updates the nav. Runs as `it.fails` like a
// gap-tagged PAGE_GATES row (RBAC_SHOW_GAPS=1 runs it normally).
const NAV_GAPS: Record<string, string> = {}

// Every gap tag was removed by the task that closed it. A row re-tagged
// later would silently run as `it.fails`; this keeps the tables honest.
it('PAGE_GATES has one row per route (a duplicate would run the same gate twice and hide a missing row)', () => {
  const routes = PAGE_GATES.map((r) => r.route)
  expect(routes.filter((r, i) => routes.indexOf(r) !== i)).toEqual([])
})

it('no PAGE_GATES row or nav entry still carries a gap tag', () => {
  expect(PAGE_GATES.filter((r) => r.gap).map((r) => r.route)).toEqual([])
  expect(NAV_GAPS).toEqual({})
})

describe('every role-restricted nav entry has a matching server-side gate', () => {
  const restricted = [...NAV_ITEMS, ...NAV_TRAILING_ITEMS].filter((i) => i.roles)

  // Review Focus #5 — a prefix rule that matches nothing is how this
  // whole class of bug gets reintroduced, so assert the count first.
  it.each(restricted)('$href has at least one gated page', (entry) => {
    expect(coveringRows(entry.href).length, `${entry.href} is hidden from some roles in the nav but no page under it is gated`).toBeGreaterThan(0)
  })

  describe.each(restricted)('$href', (entry) => {
    gateIt({ gap: NAV_GAPS[entry.href] })('is gated to exactly the roles the nav shows it to', () => {
      for (const row of coveringRows(entry.href)) {
        expect(new Set(row.allowed), `${row.route} disagrees with LeftNav's roles for ${entry.href}`).toEqual(new Set(entry.roles))
      }
    })
  })

  it.each(NAV_BILLING_ITEMS)('$href is gated to exactly BILLING_ROLES', (entry) => {
    const rows = coveringRows(entry.href)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(new Set(row.allowed)).toEqual(new Set(BILLING_ROLES))
  })

  it('does not gate a nav entry the nav shows to everyone', () => {
    for (const entry of [...NAV_ITEMS, ...NAV_TRAILING_ITEMS].filter((i) => !i.roles)) {
      expect(coveringRows(entry.href), `${entry.href} is visible to every role in the nav but a gate was added for it`).toEqual([])
    }
  })
})

// '(dashboard)/x/[id]/page.tsx' -> '/x/[id]'; route groups '(name)' drop out.
function toRoute(pageFile: string, root: string) {
  const segs = relative(root, pageFile).split(sep).slice(0, -1).filter((seg) => !/^\(.*\)$/.test(seg))
  return `/${segs.join('/')}`
}

function findPageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return findPageFiles(p)
    return /^page\.(t|j)sx?$/.test(e.name) ? [p] : []
  })
}

it('every (dashboard) page file has a PAGE_GATES row or an explicit exemption', () => {
  const EXEMPT = ['/', '/reports'] // '/' = per-role landing (dashboard-routing.test.tsx); '/reports' = bare redirect
  const root = join(process.cwd(), 'src', 'app', '(dashboard)')
  const routes = findPageFiles(root).map((f) => toRoute(f, root))
  expect(routes.length).toBeGreaterThan(40)
  expect(routes.filter((r) => !EXEMPT.includes(r) && !PAGE_GATES.some((g) => g.route === r))).toEqual([])
})
