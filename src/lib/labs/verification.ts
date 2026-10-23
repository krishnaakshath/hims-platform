// WS4 T11: who may verify a lab result (spec 3.4). Pure and client-safe: the worklist uses it to
// explain why Verify is unavailable, and verifyLabResult applies the same rule under the order lock.
//
// The verifier's department comes ONLY from the session's staff link (resolveSessionProvider ->
// provider.department_id), never a name match; the test's department is the department of its
// tariff service (lab_tests.service_id -> service_catalog.department_id). `admin` has no implicit
// clinical authority: an admin verifies only when linked to a provider of that department.
import type { LabOrderStatus } from '@/lib/labs/status'

export type VerifyDenial = 'not_resulted' | 'not_linked' | 'wrong_department' | 'self_verification'

export const VERIFY_DENIAL_MESSAGE: Record<VerifyDenial, string> = {
  not_resulted: 'This result is not ready for verification.',
  not_linked: 'Verification needs a pathologist or reporting specialist account linked to a provider. Settings → Staff.',
  wrong_department: 'Only a specialist of the department that reports this test can verify it.',
  self_verification: 'Results must be verified by someone other than the person who entered them.',
}

export function verificationDenial(i: {
  status: LabOrderStatus
  verifierDepartmentId: number | null
  testDepartmentId: number | null
  verifierUserId: number | null
  resultedByUserId: number | null
}): VerifyDenial | null {
  if (i.status !== 'resulted') return 'not_resulted'
  if (i.verifierDepartmentId === null) return 'not_linked'
  // A test with no tariff service (or a service without a department) has no reporting department.
  if (i.testDepartmentId === null || i.testDepartmentId !== i.verifierDepartmentId) return 'wrong_department'
  if (i.verifierUserId !== null && i.resultedByUserId === i.verifierUserId) return 'self_verification'
  return null
}
