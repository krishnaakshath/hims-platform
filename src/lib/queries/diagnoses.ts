// Shared `diagnoses` filters (SP6, ruling 3). Removal of an encounter diagnosis is a soft void
// (`voided_at`), so every legacy reader of the patient's diagnosis list adds `liveDiagnosis`.
// SP6 rows written without a code store `code = ''` (the legacy column is NOT NULL); readers
// that need a real code value (billing) add `withCodeValue` too.
import { isNull, ne, type SQL } from 'drizzle-orm'
import { diagnoses } from '@/db/schema'

export const liveDiagnosis: SQL = isNull(diagnoses.voidedAt)
export const withCodeValue: SQL = ne(diagnoses.code, '')
