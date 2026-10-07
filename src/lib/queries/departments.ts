import { getDb } from '@/db/client'
import { departments, type Department } from '@/db/schema'
import { asc, eq } from 'drizzle-orm'

export const DEPARTMENT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,15}$/

export async function listDepartments(opts: { activeOnly?: boolean } = {}): Promise<Department[]> {
  const q = getDb().select().from(departments)
  const filtered = opts.activeOnly ? q.where(eq(departments.isActive, true)) : q
  return filtered.orderBy(asc(departments.name))
}

export async function getDepartmentById(id: number): Promise<Department | null> {
  const [row] = await getDb().select().from(departments).where(eq(departments.id, id)).limit(1)
  return row ?? null
}

export async function getDepartmentByCode(code: string): Promise<Department | null> {
  const [row] = await getDb().select().from(departments).where(eq(departments.code, code)).limit(1)
  return row ?? null
}

export async function createDepartment(input: { code: string; name: string; kind: Department['kind'] }): Promise<Department> {
  const [row] = await getDb().insert(departments).values({ code: input.code, name: input.name, kind: input.kind }).returning()
  return row
}

export async function updateDepartment(
  id: number,
  patch: Partial<{ name: string; kind: Department['kind']; isActive: boolean }>,
): Promise<Department | null> {
  if (Object.keys(patch).length === 0) return getDepartmentById(id)
  const [row] = await getDb().update(departments).set(patch).where(eq(departments.id, id)).returning()
  return row ?? null
}
