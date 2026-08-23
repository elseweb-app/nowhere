import { describe, it, expect } from 'vitest'
import {
  sha256,
  toHex,
  fromHex,
  generateKeyPair,
  publicKeyFromPrivate,
  sign,
  verify,
} from '../src/crypto.js'
import { keyVectors, canonicalVectors } from './helpers/vectors.js'

describe('hex encoding', () => {
  it('round trips', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 127, 128, 255])
    expect(toHex(bytes)).toBe('00010f107f80ff')
    expect(fromHex('00010f107f80ff')).toEqual(bytes)
  })

  it('emits lowercase', () => {
    expect(toHex(new Uint8Array([0xab, 0xcd]))).toBe('abcd')
  })

  it('rejects malformed hex', () => {
    expect(() => fromHex('abc')).toThrow()
    expect(() => fromHex('zz')).toThrow()
  })
})

describe('sha256', () => {
  it('matches a known digest', async () => {
    const digest = await sha256(new TextEncoder().encode('abc'))
    expect(toHex(digest)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('produces the id of a canonical vector', async () => {
    const vector = canonicalVectors[0]
    const digest = await sha256(new TextEncoder().encode(vector.canonical))
    expect(toHex(digest)).toBe(vector.id)
  })
})

describe('Ed25519', () => {
  it('derives the vector public keys from their seeds', async () => {
    expect(await publicKeyFromPrivate(keyVectors.author.seed)).toBe(keyVectors.author.pubkey)
    expect(await publicKeyFromPrivate(keyVectors.issuer.seed)).toBe(keyVectors.issuer.pubkey)
  })

  it('reproduces a vector signature exactly', async () => {
    const vector = canonicalVectors[0]
    const digest = await sha256(new TextEncoder().encode(vector.canonical))
    expect(await sign(keyVectors.author.seed, digest)).toBe(vector.sig)
  })

  it('verifies a vector signature', async () => {
    const vector = canonicalVectors[0]
    const digest = await sha256(new TextEncoder().encode(vector.canonical))
    expect(await verify(keyVectors.author.pubkey, digest, vector.sig)).toBe(true)
  })

  it('rejects a signature over different bytes', async () => {
    const vector = canonicalVectors[0]
    const other = await sha256(new TextEncoder().encode('something else'))
    expect(await verify(keyVectors.author.pubkey, other, vector.sig)).toBe(false)
  })

  it('rejects a signature from the wrong key', async () => {
    const vector = canonicalVectors[0]
    const digest = await sha256(new TextEncoder().encode(vector.canonical))
    expect(await verify(keyVectors.issuer.pubkey, digest, vector.sig)).toBe(false)
  })
})

describe('generateKeyPair', () => {
  it('produces an extractable private key usable for signing', async () => {
    // Extractability is not optional: a user must be able to move their identity to
    // another device, and a key that cannot leave its runtime strands its owner forever.
    const pair = await generateKeyPair()
    expect(pair.privateKey).toMatch(/^[0-9a-f]{64}$/)
    expect(pair.publicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(await publicKeyFromPrivate(pair.privateKey)).toBe(pair.publicKey)

    const message = await sha256(new TextEncoder().encode('round trip'))
    const signature = await sign(pair.privateKey, message)
    expect(await verify(pair.publicKey, message, signature)).toBe(true)
  })

  it('produces a different key every time', async () => {
    const a = await generateKeyPair()
    const b = await generateKeyPair()
    expect(a.privateKey).not.toBe(b.privateKey)
  })
})
