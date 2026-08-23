// SPEC.md §4: eleven verification steps, checked in order, first failure wins. Each
// test below drives exactly one step into failure while leaving every earlier step
// satisfied, so a wrong rejection code or a wrong order shows up immediately.
//
// Steps 1-10 additionally run against a store that throws on any method call
// (fixtures.createPoisonedStore) — if a rejection at those steps had touched storage,
// the test would fail with a thrown error instead of a clean typed rejection.

import { describe, it, expect } from 'vitest'
import { verifyIncomingEvent } from '../src/verify.js'
import { createMemoryStore } from './memory-store.js'
import {
  createFakeClock,
  createPoisonedStore,
  makeTestConfig,
  makeAuthor,
  makeAttestation,
  buildSignedShareEvent,
} from './fixtures.js'

function flipHexCharacter(hexString) {
  const targetIndex = 0
  const original = hexString[targetIndex]
  const replacement = original === 'a' ? 'b' : 'a'
  return replacement + hexString.slice(targetIndex + 1)
}

describe('verifyIncomingEvent — the eleven-step pipeline', () => {
  it('step 1: rejects an unsupported protocol version before touching storage', async () => {
    const clock = createFakeClock()
    const config = makeTestConfig()
    const author = await makeAuthor()
    const event = await buildSignedShareEvent({ ...author, now: clock.now() })

    const result = await verifyIncomingEvent(
      { ...event, v: 2 },
      { config, store: createPoisonedStore(), now: clock.now() }
    )

    expect(result.ok).toBe(false)
    expect(result.error.error.code).toBe('UNSUPPORTED_VERSION')
    expect(result.error.error.protocol_versions).toEqual(config.protocolVersions)
  })

  it('step 2: rejects an unaccepted kind before touching storage', async () => {
    const clock = createFakeClock()
    const config = makeTestConfig()
    const author = await makeAuthor()
    const event = await buildSignedShareEvent({ ...author, now: clock.now() })

    const result = await verifyIncomingEvent(
      { ...event, kind: 'poke' },
      { config, store: createPoisonedStore(), now: clock.now() }
    )

    expect(result.ok).toBe(false)
    expect(result.error.error.code).toBe('UNSUPPORTED_KIND')
    expect(result.error.error.kinds).toEqual(config.kinds)
  })

  it('step 3: rejects an event that fails its kind schema before touching storage', async () => {
    const clock = createFakeClock()
    const config = makeTestConfig()
    const author = await makeAuthor()
    const event = await buildSignedShareEvent({ ...author, now: clock.now() })
    const { page_url: omitted, ...withoutPageUrl } = event
    void omitted

    const result = await verifyIncomingEvent(withoutPageUrl, {
      config,
      store: createPoisonedStore(),
      now: clock.now(),
    })

    expect(result.ok).toBe(false)
    expect(result.error.error.code).toBe('SCHEMA_INVALID')
  })

  it('step 4: rejects a payload over the size limit before touching storage', async () => {
    const clock = createFakeClock()
    const config = makeTestConfig({ maxPayloadBytes: 10 })
    const author = await makeAuthor()
    const event = await buildSignedShareEvent({ ...author, now: clock.now() })

    const result = await verifyIncomingEvent(event, {
      config,
      store: createPoisonedStore(),
      now: clock.now(),
    })

    expect(result.ok).toBe(false)
    expect(result.error.error.code).toBe('PAYLOAD_TOO_LARGE')
    expect(result.error.error.max_payload_bytes).toBe(10)
  })

  it('step 5: rejects a stale created_at before touching storage', async () => {
    const clock = createFakeClock()
    const config = makeTestConfig()
    const author = await makeAuthor()
    const event = await buildSignedShareEvent({
      ...author,
      now: clock.now() - config.freshnessWindowSeconds - 1000,
    })

    const result = await verifyIncomingEvent(event, {
      config,
      store: createPoisonedStore(),
      now: clock.now(),
    })

    expect(result.ok).toBe(false)
    expect(result.error.error.code).toBe('STALE_TIMESTAMP')
    expect(result.error.error.freshness_window_seconds).toBe(config.freshnessWindowSeconds)
  })

  it('step 6: rejects an id that does not match the recomputed canonical hash', async () => {
    const clock = createFakeClock()
    const config = makeTestConfig()
    const author = await makeAuthor()
    const event = await buildSignedShareEvent({ ...author, now: clock.now() })
    const tamperedId = flipHexCharacter(event.id)

    const result = await verifyIncomingEvent(
      { ...event, id: tamperedId },
      { config, store: createPoisonedStore(), now: clock.now() }
    )

    expect(result.ok).toBe(false)
    expect(result.error.error.code).toBe('SCHEMA_INVALID')
    expect(result.error.error.field).toBe('id')
  })

  it('step 7: rejects a signature that does not verify, once the id is correct', async () => {
    const clock = createFakeClock()
    const config = makeTestConfig()
    const author = await makeAuthor()
    const event = await buildSignedShareEvent({ ...author, now: clock.now() })
    const tamperedSig = flipHexCharacter(event.sig)

    const result = await verifyIncomingEvent(
      { ...event, sig: tamperedSig },
      { config, store: createPoisonedStore(), now: clock.now() }
    )

    expect(result.ok).toBe(false)
    expect(result.error.error.code).toBe('SIGNATURE_INVALID')
  })

  it('step 8: rejects an event carrying an expired attestation', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()
    const issuer = await makeAuthor()
    const config = makeTestConfig({ attestations: { trustedIssuers: [issuer.pubkey] } })
    const attestation = await makeAttestation({
      issuerPrivateKey: issuer.privateKey,
      issuerPubkey: issuer.pubkey,
      subject: author.pubkey,
      issuedAt: clock.now() - 1000,
      expiresAt: clock.now() - 1,
    })
    const event = await buildSignedShareEvent({
      ...author,
      now: clock.now(),
      attestations: [attestation],
    })

    const result = await verifyIncomingEvent(event, {
      config,
      store: createPoisonedStore(),
      now: clock.now(),
    })

    expect(result.ok).toBe(false)
    expect(result.error.error.code).toBe('ATTESTATION_INVALID')
    expect(result.error.error.reason).toBe('expired')
  })

  it('step 9: rejects an event missing a claim this relay requires to publish', async () => {
    const clock = createFakeClock()
    const config = makeTestConfig({ attestations: { requiredFor: ['membership'] } })
    const author = await makeAuthor()
    const event = await buildSignedShareEvent({ ...author, now: clock.now(), attestations: [] })

    const result = await verifyIncomingEvent(event, {
      config,
      store: createPoisonedStore(),
      now: clock.now(),
    })

    expect(result.ok).toBe(false)
    expect(result.error.error.code).toBe('ATTESTATION_REQUIRED')
    expect(result.error.error.required_claims).toEqual(['membership'])
  })

  it('step 10: rejects insufficient proof-of-work before touching storage', async () => {
    const clock = createFakeClock()
    const config = makeTestConfig({
      pow: {
        tiers: [
          {
            minAgeSeconds: 0,
            difficulty: { share: 30, reply: 30, vote: 30 },
            quota: { perKeyPerDay: 5, perKeyPerPagePerDay: 2, perKeyPerDayByKind: { vote: 10 } },
          },
        ],
      },
    })
    const author = await makeAuthor()
    // Mined at difficulty 0: the id is essentially random with respect to 30 leading
    // zero bits, so it fails the relay's baseline requirement for all practical
    // purposes (odds of an accidental pass are 2^-30).
    const event = await buildSignedShareEvent({ ...author, now: clock.now(), difficulty: 0 })

    const result = await verifyIncomingEvent(event, {
      config,
      store: createPoisonedStore(),
      now: clock.now(),
    })

    expect(result.ok).toBe(false)
    expect(result.error.error.code).toBe('POW_INSUFFICIENT')
    expect(result.error.error.required_difficulty).toBe(30)
  })

  it('step 11: rejects a publish over quota, and this is the step allowed to touch storage', async () => {
    const clock = createFakeClock()
    const config = makeTestConfig()
    const store = createMemoryStore()
    const author = await makeAuthor()

    for (let index = 0; index < config.pow.tiers[0].quota.perKeyPerDay; index++) {
      await store.bumpQuota({ pubkey: author.pubkey, pageId: null, kind: 'vote', at: clock.now() })
    }

    const event = await buildSignedShareEvent({ ...author, now: clock.now() })
    const result = await verifyIncomingEvent(event, { config, store, now: clock.now() })

    expect(result.ok).toBe(false)
    expect(result.error.error.code).toBe('QUOTA_EXCEEDED')
    expect(result.error.error.retry_after).toBe(config.quotaWindowSeconds)
  })

  it('accepts an event that satisfies every step', async () => {
    const clock = createFakeClock()
    const config = makeTestConfig()
    const store = createMemoryStore()
    const author = await makeAuthor()
    const event = await buildSignedShareEvent({ ...author, now: clock.now() })

    const result = await verifyIncomingEvent(event, { config, store, now: clock.now() })

    expect(result.ok).toBe(true)
    expect(result.event.id).toBe(event.id)
  })
})
