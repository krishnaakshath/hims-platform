import type { Role } from '@/lib/auth'
import { PAGE_GATES } from './page-gates-harness'

// Wave E: "no dead links" for dashboards. A dashboard link is fine for a role
// when the page it points to admits that role, per the same PAGE_GATES table
// nav-role-enforcement pins every page gate with. Query strings and hashes
// are ignored; '[param]' route segments match any one path segment.

// Pages every signed-in role may open without a PAGE_GATES row: '/' routes each
// role to its own home (dashboard-routing.test.tsx); the queue display is the
// PIN-protected waiting-room screen (no session at all).
const OPEN_TO_ALL = ['/', '/display/queue']

function segments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

function matches(route: string, path: string): boolean {
  const r = segments(route)
  const p = segments(path)
  return r.length === p.length && r.every((seg, i) => /^\[.+\]$/.test(seg) || seg === p[i])
}

export function linkPath(href: string): string {
  return href.split(/[?#]/)[0] || '/'
}

/** True when `role` may open the page `href` points at (exact route rows win over dynamic ones). */
export function linkAdmits(href: string, role: Role): boolean {
  const path = linkPath(href)
  if (OPEN_TO_ALL.includes(path)) return true
  const exact = PAGE_GATES.find((g) => g.route === path)
  const row = exact ?? PAGE_GATES.find((g) => matches(g.route, path))
  return row ? row.allowed.includes(role) : false
}

/** Every internal href in a rendered container that `role` could NOT open. */
export function deadLinks(container: HTMLElement, role: Role): string[] {
  return [...container.querySelectorAll('a[href]')]
    .map((a) => a.getAttribute('href') ?? '')
    .filter((h) => h.startsWith('/'))
    .filter((h) => !linkAdmits(h, role))
}
