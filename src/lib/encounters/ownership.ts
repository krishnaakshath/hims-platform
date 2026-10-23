// WS1 T1: the one check behind every doctor-workspace write on an encounter (notes, vitals,
// allergies, diagnoses, orders, prescriptions). Routes call it after their role gate and before
// any write; it never writes or audits itself.
//
// Rules: admin may write any encounter; pi only an encounter whose provider is the doctor the
// session acts as (resolveDoctorQueueProvider, the same resolver every other pi ownership check
// uses: no linked profile is a denial); crc only when the caller opts in (allowCrc, e.g. vitals);
// every other role is refused before any query. A completed or cancelled visit is closed to
// writes unless the caller opts in (allowClosed, e.g. a late addendum or an allergy update).
import type { EncounterRow } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { getEncounterById } from '@/lib/queries/encounters'

const INT4_MAX = 2147483647

/** A route's [id] segment as an encounter id: plain decimal digits, 1..2147483647, else null. */
export function parseEncounterId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n >= 1 && n <= INT4_MAX ? n : null
}

export type EncounterWriteCheck =
  | { ok: true; encounter: EncounterRow; actingProviderId: number | null }
  | { ok: false; status: 403 | 404 | 409; body: { error: string; code?: 'not_owner' | 'visit_closed' } }

// A fresh object per call, so no caller can mutate a shared refusal.
const forbidden = (): EncounterWriteCheck => ({ ok: false, status: 403, body: { error: 'Forbidden' } })

export async function checkEncounterWriter(
  session: Session,
  encounterId: number,
  opts: { allowCrc?: boolean; allowClosed?: boolean } = {},
): Promise<EncounterWriteCheck> {
  const role = session.role
  if (role !== 'admin' && role !== 'pi' && !(role === 'crc' && opts.allowCrc)) return forbidden()

  const encounter = await getEncounterById(encounterId)
  if (!encounter) return { ok: false, status: 404, body: { error: 'Not found' } }

  let actingProviderId: number | null = null
  if (role === 'pi') {
    const provider = await resolveDoctorQueueProvider(session)
    if (!provider) return forbidden()
    if (provider.id !== encounter.providerId) return { ok: false, status: 403, body: { error: 'Forbidden', code: 'not_owner' } }
    actingProviderId = provider.id
  }

  if (!opts.allowClosed && (encounter.status === 'completed' || encounter.status === 'cancelled')) {
    return { ok: false, status: 409, body: { error: 'Visit is closed', code: 'visit_closed' } }
  }
  return { ok: true, encounter, actingProviderId }
}
