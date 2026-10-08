import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { GET } from '@/app/api/patients/[anonId]/insurance-card/[side]/route'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' | 'pharmacy' | 'billing' | 'labs' | 'coder' | 'collector' = 'frontdesk'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Taylor Nguyen', userId: null })) }))

// The blob store is private -- this route streams the bytes itself via
// @vercel/blob's get() rather than letting the browser hit a stored URL
// directly. Mocked the same way as documents-download.test.ts.
vi.mock('@vercel/blob', () => ({
  get: vi.fn(async (urlOrPathname: string) => ({
    statusCode: 200 as const,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('fake-card-bytes'))
        controller.close()
      },
    }),
    headers: new Headers(),
    blob: {
      url: urlOrPathname,
      downloadUrl: urlOrPathname,
      pathname: urlOrPathname,
      contentDisposition: '',
      cacheControl: '',
      uploadedAt: new Date(),
      etag: 'test-etag',
      contentType: 'image/jpeg',
      size: 15,
    },
  })),
}))

// A dedicated throwaway patient: this file previously wrote card URLs onto
// (and then nulled the card URLs of) whatever real patient sorted first on
// the shared DB, which could wipe a genuine card on file.
const TEST_PATIENT_ID = 'RD-CARD-IMG-TEST'

beforeAll(async () => {
  await getDb().delete(patients).where(eq(patients.id, TEST_PATIENT_ID))
  await getDb().insert(patients).values({ id: TEST_PATIENT_ID, name: 'Card Image Test Patient', dob: '1990-01-01' })
})

afterAll(async () => {
  await getDb().delete(patients).where(eq(patients.id, TEST_PATIENT_ID))
})

afterEach(async () => {
  sessionRole = 'frontdesk'
  await getDb().update(patients).set({ primaryCardFrontUrl: null, primaryCardBackUrl: null }).where(eq(patients.id, TEST_PATIENT_ID))
})

function imageReq() {
  return new Request('http://localhost/api/patients/x/insurance-card/front')
}

describe('GET /api/patients/[anonId]/insurance-card/[side]', () => {
  it('streams the stored front-card image bytes', async () => {
    await getDb().update(patients).set({ primaryCardFrontUrl: 'https://blob.test/insurance-cards/stored-front' }).where(eq(patients.id, TEST_PATIENT_ID))

    const res = await GET(imageReq() as never, { params: Promise.resolve({ anonId: TEST_PATIENT_ID, side: 'front' }) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(await res.text()).toBe('fake-card-bytes')
  })

  it('returns 404 when no card is stored for that side', async () => {
    const res = await GET(imageReq() as never, { params: Promise.resolve({ anonId: TEST_PATIENT_ID, side: 'back' }) })
    expect(res.status).toBe(404)
  })

  // INSURANCE_CARD_READ_ROLES = admin, crc, pi, frontdesk, billing.
  it('serves billing the card image', async () => {
    sessionRole = 'billing'
    await getDb().update(patients).set({ primaryCardFrontUrl: 'https://blob.test/insurance-cards/stored-front' }).where(eq(patients.id, TEST_PATIENT_ID))
    const res = await GET(imageReq() as never, { params: Promise.resolve({ anonId: TEST_PATIENT_ID, side: 'front' }) })
    expect(res.status).toBe(200)
  })

  it('403s pharmacy and labs before reading the patient row', async () => {
    await getDb().update(patients).set({ primaryCardFrontUrl: 'https://blob.test/insurance-cards/stored-front' }).where(eq(patients.id, TEST_PATIENT_ID))
    for (const role of ['pharmacy', 'labs', 'coder', 'collector'] as const) {
      sessionRole = role
      const res = await GET(imageReq() as never, { params: Promise.resolve({ anonId: TEST_PATIENT_ID, side: 'front' }) })
      expect(res.status, `role ${role}`).toBe(403)
      expect(await res.json(), `body for ${role}`).toEqual({ error: 'Forbidden' })
    }
  })

  it('rejects an invalid side segment', async () => {
    const res = await GET(imageReq() as never, { params: Promise.resolve({ anonId: TEST_PATIENT_ID, side: 'sideways' }) })
    expect(res.status).toBe(400)
  })
})
