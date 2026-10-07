import { describe, it, expect } from 'vitest'
import { WORKLIST_BUCKETS, countWorklistBuckets, filterAndSortWorklist, parseWorklistParams, type WorklistRow } from '@/lib/follow-ups/worklist'

let nextId = 1
function row(over: Partial<WorklistRow> & Pick<WorklistRow, 'bucket'>): WorklistRow {
  const id = nextId++
  return {
    id,
    status: over.bucket === 'scheduled' ? 'scheduled' : over.bucket === 'missed' ? 'missed' : 'planned',
    dueDate: '2026-10-20',
    windowStart: '2026-10-17',
    windowEnd: '2026-10-27',
    reason: 'Review',
    appointment: null,
    prescribedBy: { providerId: 1, name: 'Dr A' },
    department: { id: 10, name: 'Medicine' },
    lastContact: null,
    patientId: `P-${id}`,
    patientName: `Patient ${id}`,
    uhid: null,
    phone: null,
    contactAttemptCount: 0,
    ...over,
  }
}

const appt = (iso: string) => ({ id: 1, startsAt: new Date(iso), endsAt: new Date(iso), status: 'scheduled' as const, providerId: 1, providerName: 'Dr A' })

describe('parseWorklistParams', () => {
  it('parseWorklistParams defaults and sanitises', () => {
    expect(parseWorklistParams({ bucket: 'nope', departmentId: '-3', providerId: '7' })).toEqual({ bucket: 'due', departmentId: null, providerId: 7 })
    expect(parseWorklistParams({})).toEqual({ bucket: 'due', departmentId: null, providerId: null })
    expect(parseWorklistParams({ bucket: 'all_open', departmentId: '4', providerId: '1.5' })).toEqual({ bucket: 'all_open', departmentId: 4, providerId: null })
    expect(parseWorklistParams({ bucket: ['overdue', 'due'], departmentId: ['0'], providerId: 'abc' })).toEqual({ bucket: 'overdue', departmentId: null, providerId: null })
    expect(parseWorklistParams({ providerId: '99999999999999999999' }).providerId).toBeNull()
    for (const b of WORKLIST_BUCKETS) expect(parseWorklistParams({ bucket: b }).bucket).toBe(b)
  })
})

describe('filterAndSortWorklist', () => {
  const rows = [
    row({ bucket: 'due', dueDate: '2026-10-22' }),
    row({ bucket: 'due', dueDate: '2026-10-18', prescribedBy: { providerId: 2, name: 'Dr B' } }),
    row({ bucket: 'overdue', windowEnd: '2026-10-10' }),
    row({ bucket: 'overdue', windowEnd: '2026-10-01', department: { id: 11, name: 'Ortho' } }),
    row({ bucket: 'upcoming', windowStart: '2026-11-05' }),
    row({ bucket: 'upcoming', windowStart: '2026-11-01' }),
    row({ bucket: 'scheduled', appointment: appt('2026-10-25T04:00:00Z') }),
    row({ bucket: 'scheduled', appointment: appt('2026-10-21T04:00:00Z') }),
    row({ bucket: 'missed', windowEnd: '2026-09-01' }),
    row({ bucket: 'missed', windowEnd: '2026-09-10', department: null }),
  ]
  const ids = (rs: WorklistRow[]) => rs.map((r) => r.id)
  const [due22, due18, ov10, ov01, up05, up01, sc25, sc21, mi01, mi10] = rows

  it('filters by bucket/department/provider and counts buckets', () => {
    expect(ids(filterAndSortWorklist(rows, { bucket: 'due', departmentId: null, providerId: null }))).toEqual([due18.id, due22.id])
    expect(ids(filterAndSortWorklist(rows, { bucket: 'due', departmentId: null, providerId: 2 }))).toEqual([due18.id])
    expect(ids(filterAndSortWorklist(rows, { bucket: 'overdue', departmentId: 11, providerId: null }))).toEqual([ov01.id])
    expect(ids(filterAndSortWorklist(rows, { bucket: 'missed', departmentId: 10, providerId: null }))).toEqual([mi01.id])
    expect(countWorklistBuckets(rows)).toEqual({ due: 2, overdue: 2, upcoming: 2, scheduled: 2, missed: 2 })
    expect(countWorklistBuckets([])).toEqual({ due: 0, overdue: 0, upcoming: 0, scheduled: 0, missed: 0 })
  })

  it('sorts overdue oldest window end first', () => {
    expect(ids(filterAndSortWorklist(rows, { bucket: 'overdue', departmentId: null, providerId: null }))).toEqual([ov01.id, ov10.id])
  })

  it('sorts upcoming by window start, scheduled by appointment time, missed by window end descending', () => {
    expect(ids(filterAndSortWorklist(rows, { bucket: 'upcoming', departmentId: null, providerId: null }))).toEqual([up01.id, up05.id])
    expect(ids(filterAndSortWorklist(rows, { bucket: 'scheduled', departmentId: null, providerId: null }))).toEqual([sc21.id, sc25.id])
    expect(ids(filterAndSortWorklist(rows, { bucket: 'missed', departmentId: null, providerId: null }))).toEqual([mi10.id, mi01.id])
  })

  it('all_open lists due, overdue, upcoming, scheduled, missed in that order and drops closed rows', () => {
    const closed = row({ bucket: 'closed' })
    expect(ids(filterAndSortWorklist([...rows, closed], { bucket: 'all_open', departmentId: null, providerId: null }))).toEqual([
      due18.id, due22.id, ov01.id, ov10.id, up01.id, up05.id, sc21.id, sc25.id, mi10.id, mi01.id,
    ])
  })

  it('does not mutate its input', () => {
    const copy = [...rows]
    filterAndSortWorklist(rows, { bucket: 'all_open', departmentId: null, providerId: null })
    expect(rows).toEqual(copy)
  })
})
