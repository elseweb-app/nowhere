import { describe, it, expect } from 'vitest'
import { resolveTier, buildPolicy, keyStatus } from '../src/policy.js'
import { createMemoryStore } from './memory-store.js'
import { makeTestConfig, makeAuthor, createFakeClock } from './fixtures.js'

describe('resolveTier', () => {
  const tiers = makeTestConfig().pow.tiers

  it('gives a brand-new key the strictest tier', () => {
    const tier = resolveTier(tiers, { ageSeconds: 0, reports: 0 })
    expect(tier).toBe(tiers[0])
  })

  it('relaxes to a later tier once a key is old enough and clean', () => {
    const tier = resolveTier(tiers, { ageSeconds: tiers[1].minAgeSeconds, reports: 0 })
    expect(tier).toBe(tiers[1])
  })

  it('holds a reported key at the strictest tier regardless of age', () => {
    const tier = resolveTier(tiers, { ageSeconds: tiers[1].minAgeSeconds * 10, reports: 1 })
    expect(tier).toBe(tiers[0])
  })
})

describe('buildPolicy', () => {
  it('produces a document shaped by the baseline (unknown-key) tier', () => {
    const config = makeTestConfig()
    const policy = buildPolicy(config)
    expect(policy.pow.default_difficulty).toEqual(config.pow.tiers[0].difficulty)
    expect(policy.quotas.per_key_per_day).toBe(config.pow.tiers[0].quota.perKeyPerDay)
  })

  it('throws rather than serve a policy that would not validate against PolicySchema', () => {
    const config = makeTestConfig()
    config.protocolVersions = 'not-an-array'
    expect(() => buildPolicy(config)).toThrow()
  })
})

describe('keyStatus', () => {
  it('reports the full baseline quota for a key the store has never seen', async () => {
    const clock = createFakeClock()
    const config = makeTestConfig()
    const store = createMemoryStore()
    const author = await makeAuthor()
    const tier = config.pow.tiers[0]

    const status = await keyStatus({ store, config, pubkey: author.pubkey, now: clock.now() })

    expect(status.required_difficulty).toEqual(tier.difficulty)
    expect(status.remaining_quota.share).toBe(tier.quota.perKeyPerDay)
    expect(status.remaining_quota.vote).toBe(
      Math.min(tier.quota.perKeyPerDay, tier.quota.perKeyPerDayByKind.vote)
    )
  })

  it('decreases remaining quota as a key publishes', async () => {
    const clock = createFakeClock()
    const config = makeTestConfig()
    const store = createMemoryStore()
    const author = await makeAuthor()
    const tier = config.pow.tiers[0]

    await store.bumpQuota({ pubkey: author.pubkey, pageId: null, kind: 'share', at: clock.now() })
    const status = await keyStatus({ store, config, pubkey: author.pubkey, now: clock.now() })

    // The one publish counted against the overall per-day cap, so every kind's
    // remaining budget drops with it — a share event spends against both bounds.
    expect(status.remaining_quota.share).toBe(tier.quota.perKeyPerDay - 1)
    expect(status.remaining_quota.reply).toBe(tier.quota.perKeyPerDay - 1)
  })

  it('lets a per-kind cap be the tighter bound for that kind', async () => {
    const clock = createFakeClock()
    const config = makeTestConfig({
      pow: {
        tiers: [
          {
            minAgeSeconds: 0,
            difficulty: { share: 4, reply: 4, vote: 2 },
            quota: { perKeyPerDay: 50, perKeyPerPagePerDay: 10, perKeyPerDayByKind: { vote: 1 } },
          },
        ],
      },
    })
    const store = createMemoryStore()
    const author = await makeAuthor()

    await store.bumpQuota({ pubkey: author.pubkey, pageId: null, kind: 'vote', at: clock.now() })
    const status = await keyStatus({ store, config, pubkey: author.pubkey, now: clock.now() })

    expect(status.remaining_quota.vote).toBe(0)
    expect(status.remaining_quota.share).toBe(49)
  })
})
