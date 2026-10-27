// WS4 T11: a reporting department for DB tests that verify lab results. Verification requires the
// verifier's staff link to a provider of the test's tariff-service department (spec 3.4), so a test
// creates a department + service, maps its lab tests to that service, and links verifier users to
// a provider of the department. Everything is scoped to this fixture's own rows.
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { departments, labTests, providers, serviceCatalog, staffMembers } from '@/db/schema'

export interface LabDepartmentFixture {
  departmentId: number
  serviceId: number
  /** Maps the given lab tests to this department's service. */
  mapTests(testIds: number[]): Promise<void>
  /** A provider in this department, linked (active staff) to each given user; returns the provider id. */
  linkUsers(userIds: number[], providerName?: string): Promise<number>
  /** Links a user to an existing provider (e.g. a doctor in another department). */
  linkUserToProvider(userId: number, providerId: number): Promise<void>
  cleanup(): Promise<void>
}

export async function createLabDepartmentFixture(tag: string): Promise<LabDepartmentFixture> {
  const db = getDb()
  const code = `T${tag.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(-12)}`
  const [d] = await db.insert(departments).values({ code, name: `TEST lab dept ${tag}`, kind: 'diagnostic' }).returning()
  const [svc] = await db.insert(serviceCatalog).values({ code, name: `TEST lab service ${tag}`, departmentId: d.id, category: 'investigation_lab', hsnSac: '999316' }).returning()
  const testIds: number[] = []
  const providerIds: number[] = []
  const staffIds: number[] = []
  async function linkUserToProvider(userId: number, providerId: number) {
    const [s] = await db.insert(staffMembers).values({ name: `TEST staff ${tag} ${userId}`, userId, providerId, department: 'Laboratory', title: 'Test', hireDate: '2024-01-01' }).returning()
    staffIds.push(s.id)
  }
  return {
    departmentId: d.id,
    serviceId: svc.id,
    async mapTests(ids) {
      if (ids.length === 0) return
      testIds.push(...ids)
      await db.update(labTests).set({ serviceId: svc.id }).where(inArray(labTests.id, ids))
    },
    async linkUsers(userIds, providerName = `TEST Dr Pathologist ${tag}`) {
      const [p] = await db.insert(providers).values({ name: providerName, specialty: 'Pathology', colorTag: '#000000', departmentId: d.id }).returning()
      providerIds.push(p.id)
      for (const userId of userIds) await linkUserToProvider(userId, p.id)
      return p.id
    },
    linkUserToProvider,
    async cleanup() {
      if (staffIds.length) await db.delete(staffMembers).where(inArray(staffMembers.id, staffIds))
      if (testIds.length) await db.update(labTests).set({ serviceId: null }).where(inArray(labTests.id, testIds))
      await db.delete(serviceCatalog).where(eq(serviceCatalog.id, svc.id))
      if (providerIds.length) await db.delete(providers).where(inArray(providers.id, providerIds))
      await db.delete(departments).where(eq(departments.id, d.id))
    },
  }
}
