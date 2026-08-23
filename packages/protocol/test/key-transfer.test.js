import { describe, it, expect } from 'vitest'
import {
  generateTransferCode,
  wrapKey,
  unwrapKey,
  TRANSFER_CODE_ENTROPY_BITS,
} from '../src/key-transfer.js'
import { keyVectors } from './helpers/vectors.js'

// A photograph of the QR is enough to attack the envelope offline, at leisure, where an
// expiry timestamp gives no protection at all. Entropy is the only thing defending a
// captured envelope, which is why the code is generated rather than chosen.

const seed = keyVectors.author.seed

describe('generateTransferCode', () => {
  it('carries at least 60 bits of entropy', () => {
    expect(TRANSFER_CODE_ENTROPY_BITS).toBeGreaterThanOrEqual(60)
  })

  it('is different every time', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateTransferCode()))
    expect(codes.size).toBe(50)
  })

  it('has a stable length', () => {
    const a = generateTransferCode()
    const b = generateTransferCode()
    expect(a.length).toBe(b.length)
  })
})

describe('wrapKey and unwrapKey', () => {
  it('round trips the seed', async () => {
    const code = generateTransferCode()
    const envelope = await wrapKey({ seed, code, expiresAt: 2000000000 })
    expect(await unwrapKey({ envelope, code, now: 1755900000 })).toBe(seed)
  })

  it('never puts the seed or the code in the envelope', async () => {
    const code = generateTransferCode()
    const envelope = await wrapKey({ seed, code, expiresAt: 2000000000 })
    const serialized = JSON.stringify(envelope)
    expect(serialized).not.toContain(seed)
    expect(serialized).not.toContain(code)
  })

  it('declares its parameters so another implementation can decrypt it', async () => {
    const envelope = await wrapKey({ seed, code: generateTransferCode(), expiresAt: 2000000000 })
    expect(envelope.v).toBe(1)
    expect(envelope.type).toBe('key-transfer')
    expect(envelope.kdf.name).toBe('PBKDF2-HMAC-SHA256')
    expect(envelope.kdf.iterations).toBeGreaterThanOrEqual(600000)
    expect(envelope.kdf.salt).toMatch(/^[0-9a-f]+$/)
    expect(envelope.cipher.name).toBe('AES-256-GCM')
    expect(envelope.cipher.iv).toMatch(/^[0-9a-f]+$/)
    expect(envelope.ciphertext).toMatch(/^[0-9a-f]+$/)
    expect(envelope.expires_at).toBe(2000000000)
  })

  it('uses a fresh salt and iv for every envelope', async () => {
    const code = generateTransferCode()
    const a = await wrapKey({ seed, code, expiresAt: 2000000000 })
    const b = await wrapKey({ seed, code, expiresAt: 2000000000 })
    expect(a.kdf.salt).not.toBe(b.kdf.salt)
    expect(a.cipher.iv).not.toBe(b.cipher.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('fails on the wrong transfer code', async () => {
    const envelope = await wrapKey({ seed, code: generateTransferCode(), expiresAt: 2000000000 })
    await expect(
      unwrapKey({ envelope, code: generateTransferCode(), now: 1755900000 })
    ).rejects.toThrow()
  })

  it('fails on a tampered ciphertext rather than returning wrong bytes', async () => {
    const code = generateTransferCode()
    const envelope = await wrapKey({ seed, code, expiresAt: 2000000000 })
    const flipped =
      envelope.ciphertext.slice(0, -2) + (envelope.ciphertext.endsWith('00') ? '11' : '00')
    await expect(
      unwrapKey({ envelope: { ...envelope, ciphertext: flipped }, code, now: 1755900000 })
    ).rejects.toThrow()
  })

  it('refuses an expired envelope', async () => {
    const code = generateTransferCode()
    const envelope = await wrapKey({ seed, code, expiresAt: 1755900000 })
    await expect(unwrapKey({ envelope, code, now: 1755900001 })).rejects.toThrow()
  })

  it('treats expiry as exclusive at the boundary', async () => {
    // Same convention as attestations, so the two are never read differently.
    const code = generateTransferCode()
    const envelope = await wrapKey({ seed, code, expiresAt: 1755900000 })
    expect(await unwrapKey({ envelope, code, now: 1755899999 })).toBe(seed)
    await expect(unwrapKey({ envelope, code, now: 1755900000 })).rejects.toThrow()
  })

  it('does not send anything anywhere', async () => {
    // The private key never reaches a server, encrypted or not. If this module ever
    // grows a fetch call, this is the test that should have stopped it.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/key-transfer.js', import.meta.url), 'utf8')
    )
    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toMatch(/XMLHttpRequest|WebSocket|sendBeacon/)
  })
})
