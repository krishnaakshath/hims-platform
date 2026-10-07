import type { WorklistRow } from '@/lib/follow-ups/worklist'

export function row(over: Partial<WorklistRow> = {}): WorklistRow {
  return {
    id: 1, status: 'planned', bucket: 'overdue', dueDate: '2026-10-10', windowStart: '2026-10-07', windowEnd: '2026-10-17',
    reason: 'BP review', appointment: null, prescribedBy: { providerId: 7, name: 'Dr. K' }, department: { id: 2, name: 'Cardiology' },
    lastContact: null, patientId: 'RD-0001', patientName: 'Asha Rao', uhid: 'UH-000042', phone: '+91 98765 43210', contactAttemptCount: 0,
    ...over,
  }
}
