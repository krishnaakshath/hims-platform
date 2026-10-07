import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { GET, POST } from '@/app/api/appointments/route'
import { PUT } from '@/app/api/appointments/[id]/route'
import { listActiveProviders } from '@/lib/queries/providers'
import { getDb } from '@/db/client'
import { appointments, auditLog } from '@/db/schema'

// Mutable so the role-gate tests below can act as a denied/allowed role.
const sessionRef = vi.hoisted(() => ({ current: { role: 'crc', name: 'Jamie Ruiz' } as { role: string; name: string } }))
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => sessionRef.current) }))

// Every POST in this file inserts a real appointment into the shared dev DB
// -- this file was previously missing cleanup entirely, and running the
// suite repeatedly left 30+ duplicate "Test visit" appointments per patient
// on RD-0001 through RD-0004. Track and delete each one created.
const createdIds: number[] = []
afterEach(async () => {
  while (createdIds.length > 0) {
    const id = createdIds.pop()!
    await getDb().delete(appointments).where(eq(appointments.id, id))
  }
})

describe('GET /api/appointments', () => {
  it('requires from and to query parameters', async () => {
    const req = new Request('http://localhost/api/appointments')
    const res = await GET(req as never)
    expect(res.status).toBe(400)
  })

  it('returns appointments within the given range', async () => {
    const req = new Request('http://localhost/api/appointments?from=2026-09-01&to=2026-09-30')
    const res = await GET(req as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.length).toBeGreaterThan(0)
  })

  it('treats bare from/to dates as whole IST days (00:15 IST belongs to that IST day)', async () => {
    const providers = await listActiveProviders()
    const post = new Request('http://localhost/api/appointments', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0001', providerId: providers[0].id, startsAt: '2026-12-20T00:15:00+05:30', endsAt: '2026-12-20T00:45:00+05:30', visitReason: 'IST day range' }),
    })
    const created = await POST(post as never)
    expect(created.status).toBe(201)
    const { id } = await created.json()
    createdIds.push(id)
    const res = await GET(new Request('http://localhost/api/appointments?from=2026-12-20&to=2026-12-20') as never)
    const ids = (await res.json()).map((a: { id: number }) => a.id)
    expect(ids).toContain(id)
    const prev = await GET(new Request('http://localhost/api/appointments?from=2026-12-19&to=2026-12-19') as never)
    expect((await prev.json()).map((a: { id: number }) => a.id)).not.toContain(id)
  })
})

describe('POST /api/appointments', () => {
  it('rejects a payload missing required fields', async () => {
    const req = new Request('http://localhost/api/appointments', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001' }) })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })

  it('rejects an end time that is not after the start time', async () => {
    const providers = await listActiveProviders()
    const req = new Request('http://localhost/api/appointments', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0001', providerId: providers[0].id, startsAt: '2026-10-01T10:00:00+05:30', endsAt: '2026-10-01T09:00:00+05:30', visitReason: 'Test visit' }),
    })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })

  it('creates a new scheduled appointment', async () => {
    const providers = await listActiveProviders()
    const req = new Request('http://localhost/api/appointments', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0001', providerId: providers[0].id, startsAt: '2026-10-01T09:00:00+05:30', endsAt: '2026-10-01T09:30:00+05:30', visitReason: 'Test visit' }),
    })
    const res = await POST(req as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdIds.push(body.id)
    expect(body.status).toBe('scheduled')
  })
})

describe('PUT /api/appointments/[id]', () => {
  it('rejects a payload with a field outside the allowlist (mass-assignment guard)', async () => {
    const providers = await listActiveProviders()
    const createReq = new Request('http://localhost/api/appointments', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0002', providerId: providers[0].id, startsAt: '2026-10-02T09:00:00+05:30', endsAt: '2026-10-02T09:30:00+05:30', visitReason: 'Test visit' }),
    })
    const created = await (await POST(createReq as never)).json()
    createdIds.push(created.id)

    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ patientId: 'RD-9999' }) })
    const res = await PUT(req as never, { params: Promise.resolve({ id: String(created.id) }) })
    expect(res.status).toBe(400)
  })

  it('updates an appointment status to no_show', async () => {
    const providers = await listActiveProviders()
    const createReq = new Request('http://localhost/api/appointments', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0003', providerId: providers[0].id, startsAt: '2026-10-03T09:00:00+05:30', endsAt: '2026-10-03T09:30:00+05:30', visitReason: 'Test visit' }),
    })
    const created = await (await POST(createReq as never)).json()
    createdIds.push(created.id)

    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ status: 'no_show' }) })
    const res = await PUT(req as never, { params: Promise.resolve({ id: String(created.id) }) })
    expect(res.status).toBe(200)
  })

  it('returns 404 for a nonexistent appointment', async () => {
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ status: 'completed' }) })
    const res = await PUT(req as never, { params: Promise.resolve({ id: '999999' }) })
    expect(res.status).toBe(404)
  })

  it('rejects a startsAt update that would put it after the existing endsAt', async () => {
    const providers = await listActiveProviders()
    const createReq = new Request('http://localhost/api/appointments', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0004', providerId: providers[0].id, startsAt: '2026-10-04T09:00:00+05:30', endsAt: '2026-10-04T09:30:00+05:30', visitReason: 'Test visit' }),
    })
    const created = await (await POST(createReq as never)).json()
    createdIds.push(created.id)

    // Only startsAt is sent -- the existing endsAt (09:30) is now before it.
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ startsAt: '2026-10-04T10:00:00+05:30' }) })
    const res = await PUT(req as never, { params: Promise.resolve({ id: String(created.id) }) })
    expect(res.status).toBe(400)
  })
})

describe('scheduling conflict detection', () => {
  it('rejects a new appointment that overlaps an existing one for the same provider', async () => {
    const providers = await listActiveProviders()
    const first = await POST(new Request('http://localhost/api/appointments', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0001', providerId: providers[0].id, startsAt: '2026-11-01T09:00:00+05:30', endsAt: '2026-11-01T09:30:00+05:30', visitReason: 'Test visit' }),
    }) as never)
    const firstBody = await first.json()
    createdIds.push(firstBody.id)

    const overlapping = await POST(new Request('http://localhost/api/appointments', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0002', providerId: providers[0].id, startsAt: '2026-11-01T09:15:00+05:30', endsAt: '2026-11-01T09:45:00+05:30', visitReason: 'Test visit' }),
    }) as never)
    expect(overlapping.status).toBe(409)
  })

  it('rejects rescheduling an appointment into a slot that conflicts with a different existing appointment', async () => {
    const providers = await listActiveProviders()
    const first = await POST(new Request('http://localhost/api/appointments', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0001', providerId: providers[0].id, startsAt: '2026-11-05T09:00:00+05:30', endsAt: '2026-11-05T09:30:00+05:30', visitReason: 'Test visit' }),
    }) as never)
    const firstBody = await first.json()
    createdIds.push(firstBody.id)

    const second = await POST(new Request('http://localhost/api/appointments', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0002', providerId: providers[0].id, startsAt: '2026-11-05T11:00:00+05:30', endsAt: '2026-11-05T11:30:00+05:30', visitReason: 'Test visit' }),
    }) as never)
    const secondBody = await second.json()
    createdIds.push(secondBody.id)

    // Reschedule the second appointment into the first one's slot.
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ startsAt: '2026-11-05T09:15:00+05:30', endsAt: '2026-11-05T09:45:00+05:30' }) })
    const res = await PUT(req as never, { params: Promise.resolve({ id: String(secondBody.id) }) })
    expect(res.status).toBe(409)
  })

  it('allows rescheduling an appointment to a partial update that keeps its own current slot (excludes itself from the conflict check)', async () => {
    const providers = await listActiveProviders()
    const created = await POST(new Request('http://localhost/api/appointments', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0001', providerId: providers[0].id, startsAt: '2026-11-06T09:00:00+05:30', endsAt: '2026-11-06T09:30:00+05:30', visitReason: 'Test visit' }),
    }) as never)
    const createdBody = await created.json()
    createdIds.push(createdBody.id)

    // Re-sends the appointment's own current startsAt -- must not conflict
    // with itself.
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ startsAt: '2026-11-06T09:00:00+05:30', endsAt: '2026-11-06T09:30:00+05:30' }) })
    const res = await PUT(req as never, { params: Promise.resolve({ id: String(createdBody.id) }) })
    expect(res.status).toBe(200)
  })
})

describe('appointments visitReason length (patient-facing)', () => {
  const slot = { startsAt: '2026-11-13T09:00:00+05:30', endsAt: '2026-11-13T09:30:00+05:30' }

  async function apptsAtSlot(providerId: number) {
    const rows = await getDb().select().from(appointments).where(eq(appointments.startsAt, new Date(slot.startsAt)))
    const mine = rows.filter((r) => r.providerId === providerId)
    for (const r of mine) if (!createdIds.includes(r.id)) createdIds.push(r.id)
    return mine
  }
  function postAppt(body: Record<string, unknown>) {
    return POST(new Request('http://localhost/api/appointments', { method: 'POST', body: JSON.stringify(body) }) as never)
  }

  it('POST rejects a 141-char visitReason with the existing 400 shape and creates nothing', async () => {
    const providers = await listActiveProviders()
    const visitReason = `len141-${Date.now()}-`.padEnd(141, 'x')
    const res = await postAppt({ patientId: 'RD-0001', providerId: providers[0].id, ...slot, visitReason })
    const rows = await apptsAtSlot(providers[0].id)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Invalid appointment payload')
    expect(body.details.fieldErrors.visitReason).toBeDefined()
    expect(rows).toHaveLength(0)
  })

  it('POST accepts a 140-char visitReason (after trimming) and stores the trimmed value', async () => {
    const providers = await listActiveProviders()
    const visitReason = `len140-${Date.now()}-`.padEnd(140, 'y')
    const res = await postAppt({ patientId: 'RD-0001', providerId: providers[0].id, ...slot, visitReason: ` ${visitReason}  ` })
    const body = await res.json()
    if (body?.id) createdIds.push(body.id)
    await apptsAtSlot(providers[0].id)
    expect(res.status).toBe(201)
    expect(body.visitReason).toBe(visitReason)
  })

  it('PUT rejects a 141-char visitReason and leaves the stored reason unchanged', async () => {
    const providers = await listActiveProviders()
    const created = await postAppt({ patientId: 'RD-0001', providerId: providers[0].id, ...slot, visitReason: 'Original reason' })
    const createdBody = await created.json()
    if (createdBody?.id) createdIds.push(createdBody.id)
    expect(created.status).toBe(201)

    const tooLong = 'z'.repeat(141)
    const res = await PUT(new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ visitReason: tooLong }) }) as never, { params: Promise.resolve({ id: String(createdBody.id) }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid appointment update')
    const [row] = await getDb().select().from(appointments).where(eq(appointments.id, createdBody.id))
    expect(row.visitReason).toBe('Original reason')

    const ok = await PUT(new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ visitReason: `  ${'w'.repeat(140)} ` }) }) as never, { params: Promise.resolve({ id: String(createdBody.id) }) })
    expect(ok.status).toBe(200)
    const [after] = await getDb().select().from(appointments).where(eq(appointments.id, createdBody.id))
    expect(after.visitReason).toBe('w'.repeat(140))
  })
})


// Role gate (POLICY.md: appointments are admin/crc/pi/frontdesk). The denied
// roles send VALID payloads, so if a gate regresses the call would really
// create/change a row -- every returned id is tracked and deleted by id.
describe('appointments role gate', () => {
  const probeName = `t7-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const probeIds: number[] = []
  afterAll(async () => {
    sessionRef.current = { role: 'crc', name: 'Jamie Ruiz' }
    for (const id of probeIds) await getDb().delete(appointments).where(eq(appointments.id, id))
    // Audit rows are append-only compliance records: only remove the ones
    // this run wrote under its own unique probe user name.
    await getDb().delete(auditLog).where(eq(auditLog.userName, probeName))
  })

  async function fixtureAppointment() {
    const providers = await listActiveProviders()
    const [row] = await getDb().insert(appointments).values({
      patientId: 'RD-0001', providerId: providers[0].id,
      startsAt: new Date('2026-12-07T09:00:00+05:30'), endsAt: new Date('2026-12-07T09:30:00+05:30'),
      visitReason: 'T7 gate fixture', status: 'scheduled',
    }).returning()
    probeIds.push(row.id)
    return { row, providers }
  }

  for (const role of ['pharmacy', 'billing', 'labs']) {
    it(`403s ${role} on GET, POST and PUT without creating or changing a row`, async () => {
      const { row, providers } = await fixtureAppointment()
      sessionRef.current = { role, name: probeName }

      const getRes = await GET(new Request('http://localhost/api/appointments?from=2026-09-01&to=2026-09-30') as never)
      expect(getRes.status).toBe(403)
      expect(await getRes.json()).toEqual({ error: 'Forbidden' })

      const postRes = await POST(new Request('http://localhost/api/appointments', {
        method: 'POST',
        body: JSON.stringify({ patientId: 'RD-0002', providerId: providers[0].id, startsAt: '2026-12-08T09:00:00+05:30', endsAt: '2026-12-08T09:30:00+05:30', visitReason: 'T7 denied POST' }),
      }) as never)
      const postBody = await postRes.json()
      if (typeof postBody?.id === 'number') probeIds.push(postBody.id) // regression safety: never leak a row
      expect(postRes.status).toBe(403)
      expect(postBody).toEqual({ error: 'Forbidden' })
      const leaked = await getDb().select().from(appointments).where(eq(appointments.visitReason, 'T7 denied POST'))
      for (const r of leaked) probeIds.push(r.id)
      expect(leaked).toHaveLength(0)

      const putRes = await PUT(new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ status: 'cancelled' }) }) as never, { params: Promise.resolve({ id: String(row.id) }) })
      expect(putRes.status).toBe(403)
      expect(await putRes.json()).toEqual({ error: 'Forbidden' })
      const [after] = await getDb().select().from(appointments).where(eq(appointments.id, row.id))
      expect(after.status).toBe('scheduled')
    })
  }

  it('admits frontdesk on GET with a valid range', async () => {
    sessionRef.current = { role: 'frontdesk', name: probeName }
    const res = await GET(new Request('http://localhost/api/appointments?from=2026-09-01&to=2026-09-30') as never)
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  })

  for (const role of ['frontdesk', 'pi', 'admin']) {
    it(`admits ${role} on POST and PUT`, async () => {
      sessionRef.current = { role, name: probeName }
      const providers = await listActiveProviders()
      const day = { frontdesk: '12-10', pi: '12-11', admin: '12-12' }[role]
      const post = await POST(new Request('http://localhost/api/appointments', {
        method: 'POST',
        body: JSON.stringify({ patientId: 'RD-0003', providerId: providers[0].id, startsAt: `2026-${day}T09:00:00+05:30`, endsAt: `2026-${day}T09:30:00+05:30`, visitReason: 'T7 allowed role' }),
      }) as never)
      const created = await post.json()
      if (typeof created?.id === 'number') probeIds.push(created.id)
      expect(post.status).toBe(201)
      const put = await PUT(new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ status: 'completed' }) }) as never, { params: Promise.resolve({ id: String(created.id) }) })
      expect(put.status).toBe(200)
    })
  }
})
