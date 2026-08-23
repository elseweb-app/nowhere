// SPEC.md §13: the feed is cross-page, so per-(pubkey, page_id) quotas never bound it —
// it needs, and gets, its own attestation gate and its own diversity/volume bounds.

import { describe, it, expect } from 'vitest'
import { buildFeed, diversifyByAuthor } from '../src/feed.js'
import { buildPolicy } from '../src/policy.js'
import { makeTestConfig, makeAuthor, makeAttestation, createFakeClock } from './fixtures.js'

function fakeFeedStore(events) {
  return {
    async feedPage({ limit }) {
      return { events: events.slice(0, limit), nextCursor: null }
    },
  }
}

describe('diversifyByAuthor', () => {
  it('caps how many events one author contributes', () => {
    const events = [{ pubkey: 'a' }, { pubkey: 'a' }, { pubkey: 'a' }, { pubkey: 'b' }]
    const result = diversifyByAuthor(events, { maxEvents: 10, maxPerAuthor: 2 })
    expect(result.filter((event) => event.pubkey === 'a')).toHaveLength(2)
    expect(result.filter((event) => event.pubkey === 'b')).toHaveLength(1)
  })

  it('bounds the total regardless of how diverse the candidates are', () => {
    const events = [{ pubkey: 'a' }, { pubkey: 'b' }, { pubkey: 'c' }]
    const result = diversifyByAuthor(events, { maxEvents: 2, maxPerAuthor: 5 })
    expect(result).toHaveLength(2)
  })
})

describe('buildFeed', () => {
  it('excludes an event with no attestation for a claim the relay requires', async () => {
    const clock = createFakeClock()
    const config = makeTestConfig({
      feed: { maxEvents: 10, maxPerAuthor: 10, candidatePoolSize: 10 },
    })
    const policy = buildPolicy(config)
    const author = await makeAuthor()
    const store = fakeFeedStore([{ pubkey: author.pubkey, attestations: [], kind: 'share' }])

    const result = await buildFeed({ store, config, policy, cursor: undefined, now: clock.now() })

    expect(result.events).toHaveLength(0)
  })

  it('includes an event carrying a verified claim from a trusted issuer', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()
    const issuer = await makeAuthor()
    const config = makeTestConfig({
      attestations: { trustedIssuers: [issuer.pubkey], feedRequires: ['membership'] },
      feed: { maxEvents: 10, maxPerAuthor: 10, candidatePoolSize: 10 },
    })
    const policy = buildPolicy(config)
    const attestation = await makeAttestation({
      issuerPrivateKey: issuer.privateKey,
      issuerPubkey: issuer.pubkey,
      subject: author.pubkey,
      issuedAt: clock.now() - 10,
      expiresAt: clock.now() + 10_000,
    })
    const store = fakeFeedStore([
      { pubkey: author.pubkey, attestations: [attestation], kind: 'share' },
    ])

    const result = await buildFeed({ store, config, policy, cursor: undefined, now: clock.now() })

    expect(result.events).toHaveLength(1)
  })

  it('applies its own author-diversity bound, independent of any page-level quota', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()
    const issuer = await makeAuthor()
    const config = makeTestConfig({
      attestations: { trustedIssuers: [issuer.pubkey], feedRequires: ['membership'] },
      feed: { maxEvents: 10, maxPerAuthor: 2, candidatePoolSize: 10 },
    })
    const policy = buildPolicy(config)
    const attestation = await makeAttestation({
      issuerPrivateKey: issuer.privateKey,
      issuerPubkey: issuer.pubkey,
      subject: author.pubkey,
      issuedAt: clock.now() - 10,
      expiresAt: clock.now() + 10_000,
    })
    const candidates = Array.from({ length: 5 }, () => ({
      pubkey: author.pubkey,
      attestations: [attestation],
      kind: 'share',
    }))
    const store = fakeFeedStore(candidates)

    const result = await buildFeed({ store, config, policy, cursor: undefined, now: clock.now() })

    expect(result.events).toHaveLength(2)
  })
})
