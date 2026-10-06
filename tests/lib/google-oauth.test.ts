import { describe, it, expect, vi, afterEach } from 'vitest'

describe('generatePkcePair', () => {
  it('produces a verifier and a challenge that is the base64url-SHA256 of the verifier', async () => {
    const { generatePkcePair } = await import('@/lib/google-oauth')
    const { createHash } = await import('crypto')
    const { verifier, challenge } = generatePkcePair()
    const expected = createHash('sha256').update(verifier).digest('base64url')
    expect(challenge).toBe(expected)
  })

  it('produces a different verifier each call', async () => {
    const { generatePkcePair } = await import('@/lib/google-oauth')
    const a = generatePkcePair()
    const b = generatePkcePair()
    expect(a.verifier).not.toBe(b.verifier)
  })
})

describe('verifyState', () => {
  it('returns true only when both states match exactly', async () => {
    const { verifyState } = await import('@/lib/google-oauth')
    expect(verifyState('abc123', 'abc123')).toBe(true)
    expect(verifyState('abc123', 'abc124')).toBe(false)
    expect(verifyState('abc123', '')).toBe(false)
  })

  // Regression test for a real RangeError: `timingSafeEqual` requires its
  // two buffers to have equal BYTE length. A naive `.length` guard compares
  // JS string length (UTF-16 code units), which can be equal between two
  // strings whose UTF-8 byte encodings differ -- e.g. 8 ASCII chars (8
  // bytes) vs 8 chars that are each 2 bytes in UTF-8 (16 bytes). Before the
  // fix, this combination reached `timingSafeEqual` with mismatched buffer
  // lengths and threw, uncaught, instead of returning false.
  it('does not throw for a multibyte-character state value, even when the JS string lengths match', async () => {
    const { verifyState } = await import('@/lib/google-oauth')
    const expected = 'a'.repeat(8) // 8 chars, 8 bytes in UTF-8
    const actual = 'é'.repeat(8) // 8 chars, 16 bytes in UTF-8 (each 'é' is 2 bytes)
    expect(expected.length).toBe(actual.length) // same JS string length...
    expect(Buffer.byteLength(expected)).not.toBe(Buffer.byteLength(actual)) // ...different byte length
    expect(() => verifyState(expected, actual)).not.toThrow()
    expect(verifyState(expected, actual)).toBe(false)
  })

  it('returns true for equal multibyte state values', async () => {
    const { verifyState } = await import('@/lib/google-oauth')
    const value = 'ééé'
    expect(verifyState(value, value)).toBe(true)
  })
})

describe('exchangeCodeForIdentity', () => {
  afterEach(() => {
    vi.doUnmock('jose')
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  function mockTokenFetch(idToken = 'fake-id-token') {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ id_token: idToken }),
      }))
    )
  }

  it('rejects an identity token whose email_verified claim is false', async () => {
    vi.doMock('jose', async () => {
      const actual = await vi.importActual<typeof import('jose')>('jose')
      return {
        ...actual,
        createRemoteJWKSet: vi.fn(() => vi.fn()),
        jwtVerify: vi.fn(async () => ({
          payload: {
            iss: 'https://accounts.google.com',
            sub: 'sub-123',
            email: 'staff@example.com',
            email_verified: false,
            nonce: 'expected-nonce',
          },
        })),
      }
    })
    mockTokenFetch()
    vi.resetModules()

    const { exchangeCodeForIdentity } = await import('@/lib/google-oauth')
    await expect(
      exchangeCodeForIdentity({
        code: 'abc',
        codeVerifier: 'verifier',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'http://localhost/api/auth/google/callback',
        nonce: 'expected-nonce',
      })
    ).rejects.toThrow(/unverified/i)
  })

  it('rejects an identity token that is missing the email_verified claim entirely', async () => {
    vi.doMock('jose', async () => {
      const actual = await vi.importActual<typeof import('jose')>('jose')
      return {
        ...actual,
        createRemoteJWKSet: vi.fn(() => vi.fn()),
        jwtVerify: vi.fn(async () => ({
          payload: {
            iss: 'https://accounts.google.com',
            sub: 'sub-123',
            email: 'staff@example.com',
            nonce: 'expected-nonce',
          },
        })),
      }
    })
    mockTokenFetch()
    vi.resetModules()

    const { exchangeCodeForIdentity } = await import('@/lib/google-oauth')
    await expect(
      exchangeCodeForIdentity({
        code: 'abc',
        codeVerifier: 'verifier',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'http://localhost/api/auth/google/callback',
        nonce: 'expected-nonce',
      })
    ).rejects.toThrow(/unverified/i)
  })
})
