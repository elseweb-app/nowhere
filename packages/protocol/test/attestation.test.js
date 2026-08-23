import { describe, it, expect } from 'vitest'
import { canonicalizeAttestation, verifyAttestation } from '../src/attestation.js'
import { attestationVectors, keyVectors } from './helpers/vectors.js'

// An attestation must be checkable by any third party holding only public information.
// A claim only the issuing relay can verify is that relay's private database, and it
// does not belong on the wire.

describe('canonicalizeAttestation', () => {
  for (const testCase of attestationVectors.cases) {
    it(testCase.name, () => {
      const { sig, ...body } = testCase.attestation
      void sig
      expect(canonicalizeAttestation(body)).toBe(testCase.canonical)
    })
  }

  it('omits sig from the canonical form', () => {
    const testCase = attestationVectors.cases[0]
    expect(canonicalizeAttestation(testCase.attestation)).toBe(testCase.canonical)
  })
})

describe('verifyAttestation', () => {
  for (const testCase of attestationVectors.cases) {
    it(testCase.name, async () => {
      const trustedIssuers = testCase.trusted_issuers ?? attestationVectors.trusted_issuers
      const result = await verifyAttestation(testCase.attestation, {
        now: testCase.now,
        trustedIssuers,
      })
      expect(result.reason).toBe(testCase.expect)
      expect(result.valid).toBe(testCase.expect === 'valid')
    })
  }

  it('rejects an attestation whose subject is not the event author', async () => {
    // subject must equal the event's pubkey, or anyone could carry someone else's claim.
    const testCase = attestationVectors.cases[0]
    const result = await verifyAttestation(testCase.attestation, {
      now: testCase.now,
      trustedIssuers: attestationVectors.trusted_issuers,
      subject: keyVectors.issuer.pubkey,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('subject_mismatch')
  })

  it('accepts when the subject matches', async () => {
    const testCase = attestationVectors.cases[0]
    const result = await verifyAttestation(testCase.attestation, {
      now: testCase.now,
      trustedIssuers: attestationVectors.trusted_issuers,
      subject: keyVectors.author.pubkey,
    })
    expect(result.valid).toBe(true)
  })

  it('treats expiry as exclusive at the boundary', async () => {
    const testCase = attestationVectors.cases[0]
    const expiresAt = testCase.attestation.expires_at
    const options = { trustedIssuers: attestationVectors.trusted_issuers }
    expect(
      (await verifyAttestation(testCase.attestation, { ...options, now: expiresAt - 1 })).valid
    ).toBe(true)
    expect(
      (await verifyAttestation(testCase.attestation, { ...options, now: expiresAt })).valid
    ).toBe(false)
  })

  it('trusts nobody when the trusted issuer list is absent', async () => {
    // An absent list must never be read as "trust everybody".
    const testCase = attestationVectors.cases[0]
    const result = await verifyAttestation(testCase.attestation, { now: testCase.now })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('untrusted_issuer')
  })

  it('reports the untrusted issuer ahead of the expiry', async () => {
    // Order is normative: telling a client to refresh an attestation from an issuer it
    // would reject anyway sends it down a pointless path.
    const expiredCase = attestationVectors.cases.find((c) => c.expect === 'expired')
    const result = await verifyAttestation(expiredCase.attestation, {
      now: expiredCase.now,
      trustedIssuers: [],
    })
    expect(result.reason).toBe('untrusted_issuer')
  })

  it('rejects an unknown attestation type rather than trusting it', async () => {
    const unknown = { ...attestationVectors.cases[0].attestation, type: 'host-account' }
    const result = await verifyAttestation(unknown, {
      now: attestationVectors.cases[0].now,
      trustedIssuers: attestationVectors.trusted_issuers,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('unsupported_type')
  })
})
