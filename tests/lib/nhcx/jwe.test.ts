// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { CompactEncrypt, importX509 } from 'jose'
import { randomBytes } from 'node:crypto'
import { envelope, openHcxPayload, sealHcxPayload } from '@/lib/nhcx/jwe'
import { buildRequestHeaders, toJoseHeader } from '@/lib/nhcx/headers'
import { hasOpenssl, makeTestKeyPairAndCert } from '../../helpers/selfsigned'

const OPENSSL = hasOpenssl()
const CURRENT = OPENSSL ? makeTestKeyPairAndCert('TPA1@sbx', 30) : null
const PREVIOUS = OPENSSL ? makeTestKeyPairAndCert('TPA1@sbx', 30) : null
const H = buildRequestHeaders({ sender: 'P1@sbx', recipient: 'TPA1@sbx', now: new Date('2026-10-08T06:02:26.605Z') })

describe.skipIf(!OPENSSL)('HCX JWE', () => {
  it('round-trips a sealed payload and exposes the protocol headers', async () => {
    const jwe = await sealHcxPayload({ resourceType: 'Bundle' }, H, CURRENT!.certPem)
    expect(jwe.split('.')).toHaveLength(5)
    const r = await openHcxPayload(jwe, [CURRENT!.privateKeyPem])
    expect(r).toMatchObject({ ok: true, fhir: { resourceType: 'Bundle' }, protectedHeader: { alg: 'RSA-OAEP-256', enc: 'A256GCM', 'x-hcx-sender_code': 'P1@sbx' } })
    expect(envelope(jwe)).toEqual({ payload: jwe })
  })
  it('a payload sealed for the previous key still opens during rotation', async () => {
    const jwe = await sealHcxPayload({ resourceType: 'Bundle', id: 'old' }, H, PREVIOUS!.certPem)
    expect(await openHcxPayload(jwe, [CURRENT!.privateKeyPem])).toEqual({ ok: false, problem: 'decrypt_failed' })
    expect(await openHcxPayload(jwe, [CURRENT!.privateKeyPem, PREVIOUS!.privateKeyPem])).toMatchObject({ ok: true, fhir: { id: 'old' } })
  })
  it('accepts RSA-OAEP from a v0.8 sender and refuses dir/ECDH before trying keys', async () => {
    const v08 = await new CompactEncrypt(new TextEncoder().encode('{"resourceType":"Bundle"}'))
      .setProtectedHeader({ alg: 'RSA-OAEP', enc: 'A256GCM', ...toJoseHeader(H) })
      .encrypt(await importX509(CURRENT!.certPem, 'RSA-OAEP'))
    expect(await openHcxPayload(v08, [CURRENT!.privateKeyPem])).toMatchObject({ ok: true })
    const dir = await new CompactEncrypt(new TextEncoder().encode('{}')).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).encrypt(randomBytes(32))
    expect(await openHcxPayload(dir, ['not even a key'])).toEqual({ ok: false, problem: 'bad_alg' })
    const fakeEcdh = [Buffer.from(JSON.stringify({ alg: 'ECDH-ES', enc: 'A256GCM' })).toString('base64url'), '', 'aa', 'bb', 'cc'].join('.')
    expect(await openHcxPayload(fakeEcdh, ['x'])).toEqual({ ok: false, problem: 'bad_alg' })
  })
  it('a tampered ciphertext fails closed', async () => {
    const jwe = await sealHcxPayload({ resourceType: 'Bundle' }, H, CURRENT!.certPem)
    const parts = jwe.split('.')
    parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1)
    expect(await openHcxPayload(parts.join('.'), [CURRENT!.privateKeyPem])).toEqual({ ok: false, problem: 'decrypt_failed' })
    expect(await openHcxPayload('not-a-jwe', [CURRENT!.privateKeyPem])).toEqual({ ok: false, problem: 'decrypt_failed' })
  })
  it('a non-JSON plaintext is not_json', async () => {
    const jwe = await new CompactEncrypt(new TextEncoder().encode('hello')).setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM' })
      .encrypt(await importX509(CURRENT!.certPem, 'RSA-OAEP-256'))
    expect(await openHcxPayload(jwe, [CURRENT!.privateKeyPem])).toEqual({ ok: false, problem: 'not_json' })
  })
})
