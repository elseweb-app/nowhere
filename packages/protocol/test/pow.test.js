import { describe, it, expect } from 'vitest'
import { leadingZeroBits, difficultyOf, mine, hasSufficientWork, isFresh } from '../src/pow.js'
import { fromHex } from '../src/crypto.js'
import { powVectors } from './helpers/vectors.js'

describe('leadingZeroBits', () => {
  for (const { digest, bits } of powVectors.leading_zero_bits) {
    it(`${digest.slice(0, 8)}… has ${bits} leading zero bits`, () => {
      expect(leadingZeroBits(fromHex(digest))).toBe(bits)
    })
  }
})

describe('difficultyOf', () => {
  for (const vector of powVectors.mined) {
    it(`a mined event at ${vector.required_difficulty} bits reports its difficulty`, () => {
      expect(difficultyOf(vector.id)).toBe(vector.actual_difficulty)
      expect(difficultyOf(vector.id)).toBeGreaterThanOrEqual(vector.required_difficulty)
    })
  }
})

describe('hasSufficientWork', () => {
  for (const vector of powVectors.mined) {
    it(`accepts the ${vector.required_difficulty} bit vector at its own difficulty`, async () => {
      expect(await hasSufficientWork(vector.event, vector.required_difficulty)).toBe(true)
    })

    it(`rejects the ${vector.required_difficulty} bit vector one bit above what it carries`, async () => {
      expect(await hasSufficientWork(vector.event, vector.actual_difficulty + 1)).toBe(false)
    })
  }

  it('recomputes the digest rather than trusting a supplied id', async () => {
    const vector = powVectors.mined[0]
    const lying = { ...vector.event, id: '00'.repeat(32), content: { text: 'tampered' } }
    expect(await hasSufficientWork(lying, vector.required_difficulty)).toBe(false)
  })
})

describe('mine', () => {
  it('finds the same nonce the vector did, searching from zero', async () => {
    const vector = powVectors.mined[0]
    const { nonce, ...base } = vector.event
    void nonce
    const mined = await mine(base, vector.required_difficulty)
    expect(mined.nonce).toBe(vector.nonce)
    expect(mined.id).toBe(vector.id)
  })

  it('produces an event that satisfies its own difficulty', async () => {
    const vector = powVectors.mined[0]
    const { nonce, ...base } = vector.event
    void nonce
    const mined = await mine({ ...base, created_at: base.created_at + 1 }, 8)
    expect(await hasSufficientWork(mined, 8)).toBe(true)
  })

  it('reports progress', async () => {
    const vector = powVectors.mined[1]
    const { nonce, ...base } = vector.event
    void nonce
    let calls = 0
    await mine(base, vector.required_difficulty, { onProgress: () => calls++ })
    expect(calls).toBeGreaterThan(0)
  })

  it('can be cancelled', async () => {
    // Mining must never trap the user in a UI that appears to hang.
    const vector = powVectors.mined[2]
    const { nonce, ...base } = vector.event
    void nonce
    const controller = new AbortController()
    const promise = mine(base, 32, { signal: controller.signal })
    controller.abort()
    await expect(promise).rejects.toThrow()
  })

  it('gives up at a bounded effort instead of running forever', async () => {
    const vector = powVectors.mined[0]
    const { nonce, ...base } = vector.event
    void nonce
    await expect(mine(base, 40, { maxIterations: 1000 })).rejects.toThrow()
  })
})

describe('isFresh', () => {
  const now = 1755900000
  const windowSeconds = 300

  it('accepts an event created now', () => {
    expect(isFresh(now, { now, windowSeconds })).toBe(true)
  })

  it('accepts the boundaries in both directions', () => {
    expect(isFresh(now - windowSeconds, { now, windowSeconds })).toBe(true)
    expect(isFresh(now + windowSeconds, { now, windowSeconds })).toBe(true)
  })

  it('rejects an event that is too old', () => {
    // Without this, months of offline mining can be released in one burst and the
    // proof-of-work accomplishes nothing at all.
    expect(isFresh(now - windowSeconds - 1, { now, windowSeconds })).toBe(false)
  })

  it('rejects an event from the future', () => {
    expect(isFresh(now + windowSeconds + 1, { now, windowSeconds })).toBe(false)
  })
})
