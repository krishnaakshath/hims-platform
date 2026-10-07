import { getTableColumns, sql } from 'drizzle-orm'
import { patients } from '@/db/schema'

// The ONE place that decides which `patients` columns may leave the
// credential functions. `portalPasswordHash` (scrypt hash of the portal
// password) and `mfaSecretEncrypted` (encrypted TOTP secret) are read only
// by the login/MFA functions in patient-portal.ts, by name. Every other read
// of patients selects `publicPatientColumns` (or names its own columns), so
// those values never reach route JSON, the Redis cache, exports, FHIR/C-CDA,
// search or reports. Pinned by tests/lib/no-credential-leak.test.ts.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { portalPasswordHash, mfaSecretEncrypted, ...publicColumns } = getTableColumns(patients)

export const publicPatientColumns = publicColumns

export type PublicPatientRow = Omit<typeof patients.$inferSelect, 'portalPasswordHash' | 'mfaSecretEncrypted'>

// Whether a portal password is set, computed in SQL so the hash itself is
// never selected.
export const patientPortalConfiguredSql = sql<boolean>`(${patients.portalPasswordHash} is not null)`
