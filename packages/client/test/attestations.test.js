import { describe, it, expect } from 'vitest'
import { generateKeyPair } from '@elseweb/protocol'
import { verifyEventAttestations, trustedAttestations } from '../src/attestations.js'
import { makeAttestation, makeAuthor, createFakeClock } from './helpers.js'

// SPEC.md section 8.1's check order matters because the reason a verifier reports
// changes what a client does next. These tests keep "trusted", "untrusted issuer" and
// "expired" as three genuinely distinguishable outcomes, not one collapsed boolean.
describe('verifyEventAttestations', () => {
  it('reports a trusted, unexpired attestation as valid', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()
    const issuer = await generateKeyPair()
    const attestation = await makeAttestation({
      issuerPrivateKey: issuer.privateKey,
      issuerPubkey: issuer.publicKey,
      subject: author.pubkey,
      issuedAt: clock.now() - 100,
      expiresAt: clock.now() + 1000,
    })

    const [outcome] = await verifyEventAttestations(
      { pubkey: author.pubkey, attestations: [attestation] },
      { trustedIssuers: [issuer.publicKey], now: clock.now() }
    )

    expect(outcome.valid).toBe(true)
    expect(outcome.reason).toBe('valid')
  })

  it('distinguishes an untrusted issuer from an expired attestation', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()
    const issuer = await generateKeyPair()
    const untrustedAttestation = await makeAttestation({
      issuerPrivateKey: issuer.privateKey,
      issuerPubkey: issuer.publicKey,
      subject: author.pubkey,
      issuedAt: clock.now() - 100,
      expiresAt: clock.now() + 1000,
    })
    const expiredAttestation = await makeAttestation({
      issuerPrivateKey: issuer.privateKey,
      issuerPubkey: issuer.publicKey,
      subject: author.pubkey,
      issuedAt: clock.now() - 1000,
      expiresAt: clock.now() - 1,
    })

    const [untrustedOutcome] = await verifyEventAttestations(
      { pubkey: author.pubkey, attestations: [untrustedAttestation] },
      { trustedIssuers: [], now: clock.now() }
    )
    const [expiredOutcome] = await verifyEventAttestations(
      { pubkey: author.pubkey, attestations: [expiredAttestation] },
      { trustedIssuers: [issuer.publicKey], now: clock.now() }
    )

    expect(untrustedOutcome.valid).toBe(false)
    expect(untrustedOutcome.reason).toBe('untrusted_issuer')
    expect(expiredOutcome.valid).toBe(false)
    expect(expiredOutcome.reason).toBe('expired')
    // Same shape of failure ("not counted"), genuinely different reasons.
    expect(untrustedOutcome.reason).not.toBe(expiredOutcome.reason)
  })

  it('trusts nobody when no trusted-issuer list is supplied, never everybody', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()
    const issuer = await generateKeyPair()
    const attestation = await makeAttestation({
      issuerPrivateKey: issuer.privateKey,
      issuerPubkey: issuer.publicKey,
      subject: author.pubkey,
      issuedAt: clock.now() - 100,
      expiresAt: clock.now() + 1000,
    })

    const [outcome] = await verifyEventAttestations(
      { pubkey: author.pubkey, attestations: [attestation] },
      { now: clock.now() }
    )

    expect(outcome.valid).toBe(false)
    expect(outcome.reason).toBe('untrusted_issuer')
  })

  it('ignores an unrecognized attestation type rather than throwing', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()

    const outcomes = await verifyEventAttestations(
      { pubkey: author.pubkey, attestations: [{ type: 'host-account' }] },
      { trustedIssuers: [], now: clock.now() }
    )

    expect(outcomes[0].valid).toBe(false)
    expect(outcomes[0].reason).toBe('unsupported_type')
  })

  it('tolerates an event with no attestations field at all', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()

    const outcomes = await verifyEventAttestations(
      { pubkey: author.pubkey },
      { trustedIssuers: [], now: clock.now() }
    )

    expect(outcomes).toEqual([])
  })
})

describe('trustedAttestations', () => {
  it('keeps only the outcomes that verified as trusted', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()
    const issuer = await generateKeyPair()
    const trusted = await makeAttestation({
      issuerPrivateKey: issuer.privateKey,
      issuerPubkey: issuer.publicKey,
      subject: author.pubkey,
      issuedAt: clock.now() - 100,
      expiresAt: clock.now() + 1000,
    })
    const expired = await makeAttestation({
      issuerPrivateKey: issuer.privateKey,
      issuerPubkey: issuer.publicKey,
      subject: author.pubkey,
      issuedAt: clock.now() - 1000,
      expiresAt: clock.now() - 1,
    })

    const outcomes = await verifyEventAttestations(
      { pubkey: author.pubkey, attestations: [trusted, expired] },
      { trustedIssuers: [issuer.publicKey], now: clock.now() }
    )

    expect(trustedAttestations(outcomes)).toEqual([trusted])
  })
})
