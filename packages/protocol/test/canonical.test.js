import { describe, it, expect } from 'vitest'
import { canonicalize, canonicalBytes } from '../src/canonical.js'
import { computeId, signEvent, verifyEvent } from '../src/event.js'
import { canonicalVectors, keyVectors } from './helpers/vectors.js'

// These vectors are the contract. A second implementation of this protocol is checked
// against them, so they are never edited to make an implementation pass.

describe('canonicalize', () => {
  for (const vector of canonicalVectors) {
    it(vector.name, () => {
      expect(canonicalize(vector.event)).toBe(vector.canonical)
    })
  }

  it('omits id and sig from the canonical form', () => {
    const vector = canonicalVectors[0]
    const withIdAndSig = { ...vector.event, id: vector.id, sig: vector.sig }
    expect(canonicalize(withIdAndSig)).toBe(vector.canonical)
  })

  it('is independent of the key order of the input object', () => {
    const vector = canonicalVectors[0]
    const reversed = Object.fromEntries(Object.entries(vector.event).reverse())
    expect(canonicalize(reversed)).toBe(vector.canonical)
  })

  it('treats an absent field and a null field as different, and rejects the null', () => {
    const vector = canonicalVectors[0]
    expect(() => canonicalize({ ...vector.event, anchor: null })).toThrow()
  })

  it('rejects non-integer numbers', () => {
    const vector = canonicalVectors[0]
    expect(() => canonicalize({ ...vector.event, created_at: 1755900000.5 })).toThrow()
  })

  it('encodes as UTF-8 bytes', () => {
    const vector = canonicalVectors.find((v) => v.name.includes('unicode'))
    expect(canonicalBytes(vector.event)).toEqual(new TextEncoder().encode(vector.canonical))
  })
})

describe('computeId', () => {
  for (const vector of canonicalVectors) {
    it(vector.name, async () => {
      expect(await computeId(vector.event)).toBe(vector.id)
    })
  }
})

describe('signEvent and verifyEvent', () => {
  for (const vector of canonicalVectors) {
    it(vector.name, async () => {
      const signed = await signEvent(vector.event, keyVectors.author.seed)
      expect(signed.id).toBe(vector.id)
      expect(signed.sig).toBe(vector.sig)
      expect(await verifyEvent(signed)).toBe(true)
    })
  }

  it('rejects an event whose id does not match its content', async () => {
    const vector = canonicalVectors[0]
    const tampered = { ...vector.event, id: 'ff'.repeat(32), sig: vector.sig }
    expect(await verifyEvent(tampered)).toBe(false)
  })

  it('rejects an event whose content was changed after signing', async () => {
    const vector = canonicalVectors[0]
    const signed = await signEvent(vector.event, keyVectors.author.seed)
    const tampered = { ...signed, content: { text: 'başka bir şey' } }
    expect(await verifyEvent(tampered)).toBe(false)
  })

  it('rejects a signature made by a different key', async () => {
    const vector = canonicalVectors[0]
    const signed = await signEvent(vector.event, keyVectors.issuer.seed)
    expect(await verifyEvent({ ...signed, pubkey: keyVectors.author.pubkey })).toBe(false)
  })
})
