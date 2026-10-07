// Pure, client-safe lab order status machine. No DB or node: imports.

export const LAB_ORDER_STATUSES = ['ordered', 'scheduled', 'collected', 'received', 'resulted', 'verified', 'reported', 'cancelled'] as const
export type LabOrderStatus = (typeof LAB_ORDER_STATUSES)[number]

export const LAB_TRANSITIONS: Record<LabOrderStatus, readonly LabOrderStatus[]> = {
  ordered: ['scheduled', 'collected', 'cancelled'],
  scheduled: ['ordered', 'collected', 'cancelled'],
  collected: ['received', 'cancelled'],
  received: ['resulted', 'cancelled'],
  resulted: ['verified'],
  verified: ['reported'],
  reported: [],
  cancelled: [],
}

export function canTransitionLabOrder(from: LabOrderStatus, to: LabOrderStatus): boolean {
  return LAB_TRANSITIONS[from]?.includes(to) ?? false
}

/** Statuses before a result exists; also exactly the cancellable set. */
export const PRE_RESULT_STATUSES = ['ordered', 'scheduled', 'collected', 'received'] as const
/** Statuses in which labs may enter or amend a result. */
export const RESULT_EDITABLE_STATUSES = ['received', 'resulted'] as const

export const LAB_STATUS_LABEL: Record<LabOrderStatus, string> = {
  ordered: 'Ordered',
  scheduled: 'Home collection booked',
  collected: 'Sample collected',
  received: 'Received at lab',
  resulted: 'Awaiting verification',
  verified: 'Verified',
  reported: 'Reported',
  cancelled: 'Cancelled',
}

export function fhirObservationStatusFor(s: LabOrderStatus): 'preliminary' | 'final' | null {
  if (s === 'resulted') return 'preliminary'
  if (s === 'verified' || s === 'reported') return 'final'
  return null
}

export const LIS_ACCEPTED_OBSERVATION_STATUSES = ['preliminary', 'final', 'amended', 'corrected'] as const

export function isAcceptedLisObservationStatus(s: string): boolean {
  return (LIS_ACCEPTED_OBSERVATION_STATUSES as readonly string[]).includes(s)
}
