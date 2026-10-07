// SP6 Task 10: worklist search-param parsing and backlog age buckets (pure).
import { describe, it, expect } from 'vitest'
import {
  BACKLOG_AGE_BUCKETS, WORKLIST_ASSIGNEE_FILTERS, WORKLIST_PAGE_SIZE, WORKLIST_STATUS_FILTERS, backlogAgeBucket,
  parseCodingWorklistParams,
} from '@/lib/coding/worklist'

describe('parseCodingWorklistParams', () => {
  it('defaults and sanitises params', () => {
    expect(parseCodingWorklistParams({})).toEqual({
      status: 'pending', assignee: 'all', encounterType: null, departmentId: null, fromDate: null, toDate: null, page: 1,
    })
    expect(parseCodingWorklistParams({ status: 'bogus', page: '-3' })).toMatchObject({ status: 'pending', assignee: 'all', page: 1 })
    expect(parseCodingWorklistParams({ from: '2026-10-09', to: '2026-10-01' })).toMatchObject({ fromDate: '2026-10-01', toDate: '2026-10-09' })
    expect(parseCodingWorklistParams({ from: '2026-02-30' }).fromDate).toBeNull()
  })

  it('accepts every known value and takes the first of a repeated param', () => {
    for (const s of WORKLIST_STATUS_FILTERS) expect(parseCodingWorklistParams({ status: s }).status).toBe(s)
    for (const a of WORKLIST_ASSIGNEE_FILTERS) expect(parseCodingWorklistParams({ assignee: a }).assignee).toBe(a)
    expect(parseCodingWorklistParams({ status: ['queried', 'coded'], type: 'ipd', department: '4', page: '3' }))
      .toMatchObject({ status: 'queried', encounterType: 'ipd', departmentId: 4, page: 3 })
  })

  it('refuses junk types, departments, pages and dates', () => {
    expect(parseCodingWorklistParams({ type: 'lab', department: '0', page: '1.5' })).toMatchObject({ encounterType: null, departmentId: null, page: 1 })
    expect(parseCodingWorklistParams({ department: '99999999999', page: '1e3' })).toMatchObject({ departmentId: null, page: 1 })
    expect(parseCodingWorklistParams({ from: '2026-1-1', to: 'yesterday' })).toMatchObject({ fromDate: null, toDate: null })
    expect(parseCodingWorklistParams({ to: '2026-10-09' })).toMatchObject({ fromDate: null, toDate: '2026-10-09' })
    expect(parseCodingWorklistParams({ page: '9999999' }).page).toBeLessThanOrEqual(10000)
  })

  it('pages are 50 rows', () => { expect(WORKLIST_PAGE_SIZE).toBe(50) })
})

describe('backlogAgeBucket', () => {
  it.each([
    ['2026-10-07', '0-2'], ['2026-10-04', '3-7'], ['2026-09-30', '8-30'], ['2026-09-08', '31+'],
  ])('completed %s is %s on 2026-10-09', (d, b) => {
    expect(backlogAgeBucket(d, '2026-10-09')).toBe(b)
  })

  it('has inclusive lower bounds and treats today (or a future date) as fresh', () => {
    expect(backlogAgeBucket('2026-10-09', '2026-10-09')).toBe('0-2')
    expect(backlogAgeBucket('2026-10-12', '2026-10-09')).toBe('0-2')
    expect(backlogAgeBucket('2026-10-06', '2026-10-09')).toBe('3-7')
    expect(backlogAgeBucket('2026-10-02', '2026-10-09')).toBe('3-7')
    expect(backlogAgeBucket('2026-10-01', '2026-10-09')).toBe('8-30')
    expect(backlogAgeBucket('2026-09-09', '2026-10-09')).toBe('8-30')
    expect(BACKLOG_AGE_BUCKETS).toEqual(['0-2', '3-7', '8-30', '31+'])
  })
})
