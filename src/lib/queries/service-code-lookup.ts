// SP4: the procedure codes SP6 maps to a service, read by TABLE detection (plan ruling 9).
// SP4 never imports SP6 modules: when `service_procedure_codes` does not exist every service is
// unmapped (unconstrained); once SP6 is merged the check switches on with no code change.
import { sql } from 'drizzle-orm'
import type { ProcedureCodeRef } from '@/lib/billing/charge-rules'
import type { WriteExecutor } from './executor'

type Executor = Pick<WriteExecutor, 'execute'>

/** The service's mapped codes, primary first; [] when SP6's table is absent or nothing is mapped. */
export async function loadMappedProcedureCodes(executor: Executor, serviceId: number): Promise<ProcedureCodeRef[]> {
  const probe = await executor.execute<{ present: boolean }>(sql`select to_regclass('public.service_procedure_codes') is not null as present`)
  if (!probe.rows[0]?.present) return []
  const rows = await executor.execute<{ kind: string; code: string }>(sql`
    select code_system_kind::text as kind, code from service_procedure_codes
    where service_id = ${serviceId} order by is_primary desc, id`)
  return rows.rows.map((r) => ({ kind: r.kind, code: r.code }))
}
