import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { lookupPatients, PATIENT_LOOKUP_MAX_PAGE_SIZE } from '@/lib/queries/search'

// Wave C P0-04: the patient picker's server search. Fixtures are created
// and deleted by id (TEST_WC_ prefix) on the shared DB.
const P1 = 'TEST_WC_LK1'
const P2 = 'TEST_WC_LK2'
const P3 = 'TEST_WC_LK3'
const IDS = [P1, P2, P3]

beforeAll(async () => {
  await getDb().delete(patients).where(inArray(patients.id, IDS))
  await getDb().insert(patients).values([
    { id: P1, name: 'Zyxwq Testwc Alpha', dob: '1990-01-01', gender: 'female', uhid: 'TWCUH0001A', phone: '+919812345671' },
    { id: P2, name: 'Zyxwq Testwc Beta', dob: '2001-06-15', gender: 'male', uhid: 'TWCUH0002B', phone: '+919812345672' },
    // Name contains P1's UHID: an exact UHID hit must still rank first.
    { id: P3, name: 'Aaa Testwc Gamma TWCUH0001A', dob: '1975-12-31', uhid: null, phone: null },
  ])
})

afterAll(async () => {
  await getDb().delete(patients).where(inArray(patients.id, IDS))
})

const ids = (r: { results: { id: string }[] }) => r.results.map((p) => p.id).filter((id) => IDS.includes(id))

describe('lookupPatients', () => {
  it('matches a name substring case-insensitively, ordered by name', async () => {
    const r = await lookupPatients('zyxwq TESTWC', { includePhone: false })
    expect(ids(r)).toEqual([P1, P2])
  })

  it('matches a UHID prefix or the exact UHID case-insensitively, never a mid-UHID substring', async () => {
    expect(ids(await lookupPatients('twcuh0002', { includePhone: false }))).toEqual([P2])
    expect(ids(await lookupPatients('twcuh0002b', { includePhone: false }))).toEqual([P2])
    expect(ids(await lookupPatients('UH0002B', { includePhone: false }))).toEqual([])
  })

  it('ranks an exact UHID match ahead of name matches', async () => {
    const r = await lookupPatients('TWCUH0001A', { includePhone: false })
    expect(r.results[0].id).toBe(P1)
    expect(ids(r)).toEqual([P1, P3])
  })

  it('matches a mobile number however it is typed (last 10 digits)', async () => {
    for (const q of ['9812345671', '+91 98123 45671', '09812345671', '91-9812345671']) {
      expect(ids(await lookupPatients(q, { includePhone: false })), q).toEqual([P1])
    }
  })

  it('matches the anonymous chart id (exact or prefix)', async () => {
    expect(ids(await lookupPatients('test_wc_lk3', { includePhone: false }))).toEqual([P3])
  })

  it('treats LIKE wildcards in the query literally', async () => {
    expect(ids(await lookupPatients('Zyxwq%Alpha', { includePhone: false }))).toEqual([])
    expect(ids(await lookupPatients('Zyxwq_Testwc', { includePhone: false }))).toEqual([])
  })

  it('returns a minimal projection; the phone only when asked for', async () => {
    const without = (await lookupPatients('TWCUH0001A', { includePhone: false })).results[0]
    expect(Object.keys(without).sort()).toEqual(['ageYears', 'gender', 'id', 'name', 'uhid'])
    expect(without).toMatchObject({ id: P1, name: 'Zyxwq Testwc Alpha', uhid: 'TWCUH0001A', gender: 'female' })
    expect(typeof without.ageYears).toBe('number')
    const withPhone = (await lookupPatients('TWCUH0001A', { includePhone: true })).results[0]
    expect(Object.keys(withPhone).sort()).toEqual(['ageYears', 'gender', 'id', 'name', 'phone', 'uhid'])
    expect(withPhone.phone).toBe('+919812345671')
  })

  it('returns nothing for a query shorter than 2 characters', async () => {
    expect((await lookupPatients(' z ', { includePhone: false })).results).toEqual([])
  })

  it('pages with hasMore and caps the page size', async () => {
    const p1 = await lookupPatients('zyxwq testwc', { includePhone: false, page: 1, pageSize: 1 })
    expect(p1.results.map((p) => p.id)).toEqual([P1])
    expect(p1.hasMore).toBe(true)
    const p2 = await lookupPatients('zyxwq testwc', { includePhone: false, page: 2, pageSize: 1 })
    expect(p2.results.map((p) => p.id)).toEqual([P2])
    expect(p2.hasMore).toBe(false)
    const big = await lookupPatients('zyxwq testwc', { includePhone: false, pageSize: 500 })
    expect(big.pageSize).toBe(PATIENT_LOOKUP_MAX_PAGE_SIZE)
  })
})
