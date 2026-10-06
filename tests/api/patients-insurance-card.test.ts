// @vitest-environment node
//
// This route reads a real multipart FormData body via `request.formData()`.
// Under this project's default jsdom test environment, `File`/`FormData` are
// jsdom's own realm-specific classes, but the `Request` used to construct
// the test request falls through to Node's native (undici) implementation
// (jsdom doesn't provide one). undici's FormData-body serialization does a
// strict webidl brand check on each value, which a jsdom File fails even
// though it's a genuine File -- see tests/api/login.test.ts and
// tests/lib/auth.test.ts for the same class of jsdom/Node realm mismatch.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST as uploadRoute } from '@/app/api/patients/[anonId]/insurance-card/route'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' = 'frontdesk'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Taylor Nguyen' })) }))
vi.mock('@vercel/blob', () => ({ put: vi.fn(async (path: string) => ({ url: `https://blob.test/${path}` })) }))

afterEach(async () => {
  sessionRole = 'frontdesk'
  const [patientRow] = await getDb().select().from(patients).limit(1)
  await getDb().update(patients).set({ primaryCardFrontUrl: null, primaryCardBackUrl: null }).where(eq(patients.id, patientRow.id))
})

function formDataReq(side: string, file: File) {
  const fd = new FormData()
  fd.set('side', side)
  fd.set('file', file)
  return new Request('http://localhost', { method: 'POST', body: fd })
}

describe('POST /api/patients/[anonId]/insurance-card', () => {
  it('uploads a front-side card image and stores the URL on the patient', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const file = new File([new Uint8Array([1, 2, 3])], 'card.jpg', { type: 'image/jpeg' })
    const res = await uploadRoute(formDataReq('front', file) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    expect(res.status).toBe(200)
    const [updated] = await getDb().select().from(patients).where(eq(patients.id, patientRow.id))
    expect(updated.primaryCardFrontUrl).toContain('https://blob.test/')
  })

  it('rejects a non-image content type', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const file = new File([new Uint8Array([1, 2, 3])], 'card.pdf', { type: 'application/pdf' })
    const res = await uploadRoute(formDataReq('front', file) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    expect(res.status).toBe(400)
  })

  it('rejects a session role that cannot write insurance data', async () => {
    sessionRole = 'pi'
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const file = new File([new Uint8Array([1, 2, 3])], 'card.jpg', { type: 'image/jpeg' })
    const res = await uploadRoute(formDataReq('front', file) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    expect(res.status).toBe(403)
  })
})
