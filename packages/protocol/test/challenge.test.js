import { describe, it, expect } from 'vitest'
import { canonicalizeChallenge, signChallenge, verifyChallenge } from '../src/challenge.js'
import { challengeVectors, keyVectors } from './helpers/vectors.js'

// A consumer must never trust "this pubkey is mine" on its own word — the subject key
// has to sign a challenge scoped to one consumer and one action to prove control.

describe('canonicalizeChallenge', () => {
  for (const testCase of challengeVectors.cases) {
    it(testCase.name, () => {
      const { sig, ...body } = testCase.challenge
      void sig
      expect(canonicalizeChallenge(body)).toBe(testCase.canonical)
    })
  }

  it('omits sig from the canonical form', () => {
    const testCase = challengeVectors.cases[0]
    expect(canonicalizeChallenge(testCase.challenge)).toBe(testCase.canonical)
  })
})

describe('signChallenge', () => {
  it('produces a signature verifyChallenge accepts', async () => {
    const { sig, ...body } = challengeVectors.cases[0].challenge
    void sig
    const signed = await signChallenge(body, keyVectors.author.seed)
    const result = await verifyChallenge(signed, {
      now: challengeVectors.cases[0].now,
      audience: challengeVectors.cases[0].audience,
    })
    expect(result.valid).toBe(true)
  })
})

describe('verifyChallenge', () => {
  for (const testCase of challengeVectors.cases) {
    it(testCase.name, async () => {
      const result = await verifyChallenge(testCase.challenge, {
        now: testCase.now,
        audience: testCase.audience,
      })
      expect(result.reason).toBe(testCase.expect)
      expect(result.valid).toBe(testCase.expect === 'valid')
    })
  }

  it('rejects a signature that is valid but scoped to a different audience', async () => {
    // Domain separation: a signature made for one consumer must not verify against a
    // different consumer's expected audience, even though the signature itself is fine.
    const testCase = challengeVectors.cases[0]
    const result = await verifyChallenge(testCase.challenge, {
      now: testCase.now,
      audience: 'a-different-consumer',
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('audience_mismatch')
  })

  it('treats an absent expected audience as a mismatch, never as "any audience"', async () => {
    const testCase = challengeVectors.cases[0]
    const result = await verifyChallenge(testCase.challenge, { now: testCase.now })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('audience_mismatch')
  })

  it('rejects a mismatched action when the caller checks for one', async () => {
    const testCase = challengeVectors.cases[0]
    const result = await verifyChallenge(testCase.challenge, {
      now: testCase.now,
      audience: testCase.audience,
      action: 'delete-account',
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('action_mismatch')
  })

  it('rejects a mismatched resource when the caller checks for one', async () => {
    const testCase = challengeVectors.cases[0]
    const result = await verifyChallenge(testCase.challenge, {
      now: testCase.now,
      audience: testCase.audience,
      resource: 'account-99',
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('resource_mismatch')
  })

  it('rejects a mismatched subject when the caller checks for one', async () => {
    const testCase = challengeVectors.cases[0]
    const result = await verifyChallenge(testCase.challenge, {
      now: testCase.now,
      audience: testCase.audience,
      subject: keyVectors.issuer.pubkey,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('subject_mismatch')
  })

  it('does not check action, resource or subject unless the caller asks', async () => {
    const testCase = challengeVectors.cases[0]
    const result = await verifyChallenge(testCase.challenge, {
      now: testCase.now,
      audience: testCase.audience,
    })
    expect(result.valid).toBe(true)
  })

  it('treats expiry as exclusive at the boundary', async () => {
    const testCase = challengeVectors.cases[0]
    const options = { audience: testCase.audience }
    const expiresAt = testCase.challenge.expires_at
    expect(
      (await verifyChallenge(testCase.challenge, { ...options, now: expiresAt - 1 })).valid
    ).toBe(true)
    expect((await verifyChallenge(testCase.challenge, { ...options, now: expiresAt })).valid).toBe(
      false
    )
  })

  it('rejects an unknown challenge type rather than trusting it', async () => {
    const testCase = challengeVectors.cases[0]
    const unknown = { ...testCase.challenge, type: 'something-else' }
    const result = await verifyChallenge(unknown, {
      now: testCase.now,
      audience: testCase.audience,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('unsupported_type')
  })
})
