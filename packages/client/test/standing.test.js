import { describe, it, expect } from 'vitest'
import { generateKeyPair } from '@elseweb/protocol'
import { deriveStanding } from '../src/standing.js'
import { makeAttestation, makeAuthor, makeShareEvent, createFakeClock } from './helpers.js'

describe('deriveStanding', () => {
  it('gives a trusted, attested author more standing than a bare persistent one', async () => {
    const clock = createFakeClock()
    const issuer = await generateKeyPair()
    const attestedAuthor = await makeAuthor()
    const bareAuthor = await makeAuthor()

    const attestation = await makeAttestation({
      issuerPrivateKey: issuer.privateKey,
      issuerPubkey: issuer.publicKey,
      subject: attestedAuthor.pubkey,
      issuedAt: clock.now() - 100,
      expiresAt: clock.now() + 1000,
    })

    const attestedEvent = await makeShareEvent({
      ...attestedAuthor,
      now: clock.now(),
      attestations: [attestation],
    })
    const bareEvent = await makeShareEvent({ ...bareAuthor, now: clock.now() })

    const standingByPubkey = await deriveStanding([attestedEvent, bareEvent], {
      trustedIssuers: [issuer.publicKey],
      now: clock.now(),
    })

    expect(standingByPubkey[attestedAuthor.pubkey]).toBeGreaterThan(
      standingByPubkey[bareAuthor.pubkey]
    )
  })

  it('does not let an untrusted issuer buy standing', async () => {
    const clock = createFakeClock()
    const issuer = await generateKeyPair()
    const author = await makeAuthor()

    const attestation = await makeAttestation({
      issuerPrivateKey: issuer.privateKey,
      issuerPubkey: issuer.publicKey,
      subject: author.pubkey,
      issuedAt: clock.now() - 100,
      expiresAt: clock.now() + 1000,
    })
    const event = await makeShareEvent({ ...author, now: clock.now(), attestations: [attestation] })

    // Note the empty trusted-issuer list: the issuer is real and the signature is
    // valid, but nobody has vouched for it here.
    const standingByPubkey = await deriveStanding([event], { trustedIssuers: [], now: clock.now() })

    expect(standingByPubkey[author.pubkey]).toBe(2) // base(1) + persistent identity(1), no attestation credit
  })

  it('gives an ephemeral identity less standing than a persistent one, all else equal', async () => {
    const clock = createFakeClock()
    const persistentAuthor = await makeAuthor()
    const ephemeralAuthor = await makeAuthor()

    const persistentEvent = await makeShareEvent({ ...persistentAuthor, now: clock.now() })
    const ephemeralEvent = await makeShareEvent({
      ...ephemeralAuthor,
      now: clock.now(),
      identityMode: 'ephemeral',
    })

    const standingByPubkey = await deriveStanding([persistentEvent, ephemeralEvent], {
      trustedIssuers: [],
      now: clock.now(),
    })

    expect(standingByPubkey[persistentAuthor.pubkey]).toBeGreaterThan(
      standingByPubkey[ephemeralAuthor.pubkey]
    )
  })

  it('keeps the best standing seen across several events from the same author', async () => {
    const clock = createFakeClock()
    const issuer = await generateKeyPair()
    const author = await makeAuthor()

    const attestation = await makeAttestation({
      issuerPrivateKey: issuer.privateKey,
      issuerPubkey: issuer.publicKey,
      subject: author.pubkey,
      issuedAt: clock.now() - 100,
      expiresAt: clock.now() + 1000,
    })

    const unattestedEvent = await makeShareEvent({ ...author, now: clock.now(), text: 'first' })
    const attestedEvent = await makeShareEvent({
      ...author,
      now: clock.now(),
      text: 'second',
      attestations: [attestation],
    })

    const standingByPubkey = await deriveStanding([unattestedEvent, attestedEvent], {
      trustedIssuers: [issuer.publicKey],
      now: clock.now(),
    })

    expect(standingByPubkey[author.pubkey]).toBe(1 + 4 + 1)
  })
})
