import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { eq, inArray, like } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, departments, homeCollectionWindows, labServiceAreaPins, labTests, serviceCatalog } from '@/db/schema'
import type { Session } from '@/lib/auth'
import {
  addServiceAreaPins, createCollectionWindow, getActiveServicePins, isLocalPatientPin, listCollectionWindows,
  listLabTestsWithSetup, listServiceAreaPins, setServiceAreaPinActive, updateCollectionWindow, updateLabTestSetup,
} from '@/lib/queries/lab-setup'

const RUN = `${Date.now()}`
const PROBE_USER = `TEST_SP5_SETUP-${RUN}`
const S: Session = { role: 'admin', name: PROBE_USER, userId: null }
const PINS = ['990001', '990002']
const WINDOW_PREFIX = `TEST-SP5-${RUN.slice(-6)}`
const DEPT_CODE = `TSP5S${RUN.slice(-8)}`

let deptId = 0
let consultationId = 0
let investigationId = 0
let labTestId = 0

describe.skipIf(!process.env.DATABASE_URL)('lab setup (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    // Leftovers from an aborted earlier run of this file would make the counts below wrong.
    await db.delete(labServiceAreaPins).where(inArray(labServiceAreaPins.pinCode, PINS))
    const [d] = await db.insert(departments).values({ code: DEPT_CODE, name: 'TEST_SP5 setup dept', kind: 'diagnostic' }).returning()
    deptId = d.id
    const [c] = await db.insert(serviceCatalog).values({ code: `TC${RUN.slice(-8)}`, name: 'TEST_SP5 consult', departmentId: d.id, category: 'consultation', hsnSac: '999311' }).returning()
    const [i] = await db.insert(serviceCatalog).values({ code: `TI${RUN.slice(-8)}`, name: 'TEST_SP5 CBC', departmentId: d.id, category: 'investigation_lab', hsnSac: '999316' }).returning()
    consultationId = c.id
    investigationId = i.id
    const [t] = await db.insert(labTests).values({ name: `TEST_SP5 test ${RUN}`, code: `TEST-SP5-${RUN}` }).returning()
    labTestId = t.id
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(labTests).where(eq(labTests.id, labTestId))
    await db.delete(serviceCatalog).where(inArray(serviceCatalog.id, [consultationId, investigationId]))
    await db.delete(departments).where(eq(departments.id, deptId))
    await db.delete(labServiceAreaPins).where(inArray(labServiceAreaPins.pinCode, PINS))
    await db.delete(homeCollectionWindows).where(like(homeCollectionWindows.label, `${WINDOW_PREFIX}%`))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
  })

  it('adds, de-duplicates and reactivates PINs', async () => {
    expect(await addServiceAreaPins(PINS, 'Test area', S)).toMatchObject({ added: 2, reactivated: 0, unchanged: 0 })
    expect(await addServiceAreaPins(['990002'], null, S)).toMatchObject({ added: 0, reactivated: 0, unchanged: 1 })
    const [row] = (await listServiceAreaPins()).filter((p) => p.pinCode === '990001')
    expect(row.areaLabel).toBe('Test area')
    const off = await setServiceAreaPinActive(row.id, false, S)
    expect(off?.isActive).toBe(false)
    expect(await isLocalPatientPin('990001')).toBe(false)
    expect(await addServiceAreaPins(['990001'], null, S)).toMatchObject({ added: 0, reactivated: 1 })
    // A null label never wipes the stored one.
    const [again] = (await listServiceAreaPins()).filter((p) => p.pinCode === '990001')
    expect(again).toMatchObject({ isActive: true, areaLabel: 'Test area' })
    expect(await isLocalPatientPin('990001')).toBe(true)
    expect(await isLocalPatientPin(' 990001 ')).toBe(true)
    expect(await isLocalPatientPin('990009')).toBe(false)
    expect(await isLocalPatientPin(null)).toBe(false)
    expect((await getActiveServicePins()).has('990002')).toBe(true)
    expect(await setServiceAreaPinActive(2147483000, false, S)).toBeNull()

    const audits = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))
    const pinAudits = audits.filter((a) => a.action === 'changed lab service area')
    expect(pinAudits.map((a) => a.details)).toEqual(expect.arrayContaining(['added=2 reactivated=0', `pin=${row.id} active=false`, 'added=0 reactivated=1']))
  })

  it('refuses an overlapping active window but allows touching windows', async () => {
    const a = await createCollectionWindow({ label: `${WINDOW_PREFIX} A`, startTime: '05:00', endTime: '06:00', capacity: 3 }, S)
    expect(a.ok).toBe(true)
    expect(await createCollectionWindow({ label: `${WINDOW_PREFIX} B`, startTime: '05:30', endTime: '06:30', capacity: 3 }, S)).toEqual({ ok: false, error: 'overlap' })
    const c = await createCollectionWindow({ label: `${WINDOW_PREFIX} C`, startTime: '06:00', endTime: '07:00', capacity: 3 }, S)
    expect(c.ok).toBe(true)
    if (!a.ok || !c.ok) return

    // Moving C into A overlaps; deactivating A first makes it fine.
    expect(await updateCollectionWindow(c.window.id, { startTime: '05:45' }, S)).toEqual({ ok: false, error: 'overlap' })
    const offA = await updateCollectionWindow(a.window.id, { isActive: false }, S)
    expect(offA).toMatchObject({ ok: true, window: { isActive: false } })
    expect(await updateCollectionWindow(c.window.id, { startTime: '05:45' }, S)).toMatchObject({ ok: true, window: { startTime: '05:45', endTime: '07:00' } })
    // Reactivating A now overlaps C.
    expect(await updateCollectionWindow(a.window.id, { isActive: true }, S)).toEqual({ ok: false, error: 'overlap' })
    expect(await updateCollectionWindow(2147483000, { capacity: 2 }, S)).toEqual({ ok: false, error: 'not_found' })

    const ours = (await listCollectionWindows()).filter((w) => w.label.startsWith(WINDOW_PREFIX))
    expect(ours.map((w) => w.label)).toEqual([`${WINDOW_PREFIX} A`, `${WINDOW_PREFIX} C`])
    expect((await listCollectionWindows(false)).some((w) => w.id === a.window.id)).toBe(false)

    const audits = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))
    expect(audits.filter((x) => x.action === 'created home collection window').map((x) => x.details)).toEqual(
      expect.arrayContaining([`window=${a.window.id}`, `window=${c.window.id}`]),
    )
    expect(audits.some((x) => x.action === 'changed home collection window' && x.details === `window=${c.window.id}`)).toBe(true)
  })

  // A patch that sets only one end is merged with the stored window; an inverted result is refused, not left to the DB check (a 500).
  it('refuses an end before the start after merging the stored window', async () => {
    const w = await createCollectionWindow({ label: `${WINDOW_PREFIX} D`, startTime: '03:00', endTime: '04:00', capacity: 1 }, S)
    expect(w.ok).toBe(true)
    if (!w.ok) return
    await expect(updateCollectionWindow(w.window.id, { startTime: '04:30' }, S)).resolves.toEqual({ ok: false, error: 'invalid_times' })
  })

  it('maps a lab test to an investigation service only', async () => {
    expect(await updateLabTestSetup(labTestId, { serviceId: consultationId }, S)).toEqual({ ok: false, error: 'service_not_investigation' })
    expect(await updateLabTestSetup(labTestId, { serviceId: 2147483000 }, S)).toEqual({ ok: false, error: 'service_not_found' })
    expect(await updateLabTestSetup(2147483000, { sampleType: 'blood' }, S)).toEqual({ ok: false, error: 'not_found' })

    const ok = await updateLabTestSetup(labTestId, { serviceId: investigationId, sampleType: 'blood', container: 'edta_lavender' }, S)
    expect(ok).toMatchObject({ ok: true, test: { id: labTestId, sampleType: 'blood', container: 'edta_lavender', serviceId: investigationId, serviceName: 'TEST_SP5 CBC' } })
    const listed = (await listLabTestsWithSetup()).find((t) => t.id === labTestId)
    expect(listed).toMatchObject({ serviceCode: `TI${RUN.slice(-8)}`, category: 'lab' })

    const cleared = await updateLabTestSetup(labTestId, { serviceId: null }, S)
    expect(cleared).toMatchObject({ ok: true, test: { serviceId: null, serviceCode: null, serviceName: null, sampleType: 'blood' } })

    const audits = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))
    expect(audits.filter((a) => a.action === 'changed lab test setup').map((a) => a.details)).toEqual(
      expect.arrayContaining([`labTest=${labTestId} fields=container,sampleType,serviceId`, `labTest=${labTestId} fields=serviceId`]),
    )
  })
})
