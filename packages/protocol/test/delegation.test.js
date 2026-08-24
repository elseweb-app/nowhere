import { describe, it, expect } from 'vitest'
import {
  canonicalizeDelegation,
  canonicalizeRevocation,
  signDelegation,
  signRevocation,
  verifyDelegation,
  verifyRevocation,
} from '../src/delegation.js'
import { delegationVectors, keyVectors } from './helpers/vectors.js'

// A worker key lets one identity authorize compute on its behalf without sharing its
// private key. Every failure mode here — unsupported type, self-delegation, revoked,
// expired — MUST fail closed: none of them silently passes.

describe('canonicalizeDelegation', () => {
  for (const testCase of delegationVectors.cases) {
    it(testCase.name, () => {
      const { sig, ...body } = testCase.delegation
      void sig
      expect(canonicalizeDelegation(body)).toBe(testCase.canonical)
    })
  }
})

describe('canonicalizeRevocation', () => {
  for (const testCase of delegationVectors.revocations) {
    it(testCase.name, () => {
      const { sig, ...body } = testCase.revocation
      void sig
      expect(canonicalizeRevocation(body)).toBe(testCase.canonical)
    })
  }
})

describe('signDelegation', () => {
  it('produces a signature verifyDelegation accepts', async () => {
    const { sig, ...body } = delegationVectors.cases[0].delegation
    void sig
    const signed = await signDelegation(body, keyVectors.owner.seed)
    const result = await verifyDelegation(signed, { now: delegationVectors.cases[0].now })
    expect(result.valid).toBe(true)
  })
})

describe('verifyDelegation', () => {
  for (const testCase of delegationVectors.cases) {
    it(testCase.name, async () => {
      const result = await verifyDelegation(testCase.delegation, {
        now: testCase.now,
        revokedIds: testCase.revoked_ids,
      })
      expect(result.reason).toBe(testCase.expect)
      expect(result.valid).toBe(testCase.expect === 'valid')
    })
  }

  it('fails closed on a revoked authorization even before it expires', async () => {
    const testCase = delegationVectors.cases[0]
    const result = await verifyDelegation(testCase.delegation, {
      now: testCase.now,
      revokedIds: [testCase.delegation.authorization_id],
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('revoked')
  })

  it('treats an absent revoked-id set as "nothing known revoked", not "trust everyone"', async () => {
    const testCase = delegationVectors.cases[0]
    const result = await verifyDelegation(testCase.delegation, { now: testCase.now })
    expect(result.valid).toBe(true)
  })

  it('reports revoked ahead of expired', async () => {
    // Order is normative, same reasoning as attestations: telling a caller to check
    // expiry on something that's revoked regardless sends it down a pointless path.
    const expiredCase = delegationVectors.cases.find((c) => c.expect === 'expired')
    const result = await verifyDelegation(expiredCase.delegation, {
      now: expiredCase.now,
      revokedIds: [expiredCase.delegation.authorization_id],
    })
    expect(result.reason).toBe('revoked')
  })

  it('rejects when the caller requires a capability the delegation does not grant', async () => {
    const testCase = delegationVectors.cases[0]
    const result = await verifyDelegation(testCase.delegation, {
      now: testCase.now,
      requiredCapability: 'image.generate',
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('capability_missing')
  })

  it('accepts when the required capability is granted', async () => {
    const testCase = delegationVectors.cases[0]
    const result = await verifyDelegation(testCase.delegation, {
      now: testCase.now,
      requiredCapability: 'text.generate',
    })
    expect(result.valid).toBe(true)
  })

  it('treats expiry as exclusive at the boundary', async () => {
    const testCase = delegationVectors.cases[0]
    const expiresAt = testCase.delegation.expires_at
    expect((await verifyDelegation(testCase.delegation, { now: expiresAt - 1 })).valid).toBe(true)
    expect((await verifyDelegation(testCase.delegation, { now: expiresAt })).valid).toBe(false)
  })

  it('rejects an unknown delegation type rather than trusting it', async () => {
    const testCase = delegationVectors.cases[0]
    const unknown = { ...testCase.delegation, type: 'something-else' }
    const result = await verifyDelegation(unknown, { now: testCase.now })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('unsupported_type')
  })
})

describe('signRevocation', () => {
  it('produces a signature verifyRevocation accepts', async () => {
    const { sig, ...body } = delegationVectors.revocations[0].revocation
    void sig
    const signed = await signRevocation(body, keyVectors.owner.seed)
    const result = await verifyRevocation(signed)
    expect(result.valid).toBe(true)
  })
})

describe('verifyRevocation', () => {
  for (const testCase of delegationVectors.revocations) {
    it(testCase.name, async () => {
      const result = await verifyRevocation(testCase.revocation)
      expect(result.reason).toBe(testCase.expect)
      expect(result.valid).toBe(testCase.expect === 'valid')
    })
  }

  it('rejects an unknown revocation type rather than trusting it', async () => {
    const testCase = delegationVectors.revocations[0]
    const unknown = { ...testCase.revocation, type: 'something-else' }
    const result = await verifyRevocation(unknown)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('unsupported_type')
  })
})
