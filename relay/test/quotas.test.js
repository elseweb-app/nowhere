import { describe, it, expect } from 'vitest'
import { checkQuota } from '../src/quotas.js'
import { makeTestConfig } from './fixtures.js'

function fakeStoreWithUsage(usage) {
  return {
    async quotaUsage() {
      return usage
    },
  }
}

describe('checkQuota', () => {
  const config = makeTestConfig()
  const tier = config.pow.tiers[0]
  const shareEvent = { pubkey: 'author', page_id: 'page', kind: 'share' }
  const voteEvent = { pubkey: 'author', kind: 'vote' }

  it('allows a publish under every limit', async () => {
    const store = fakeStoreWithUsage({ perKey: 0, perKeyPerPage: 0, perKeyPerKind: 0 })
    const result = await checkQuota({ store, config, event: shareEvent, tier, now: 0 })
    expect(result.withinQuota).toBe(true)
  })

  it('rejects once the per-key daily cap is reached, carrying retry_after', async () => {
    const store = fakeStoreWithUsage({
      perKey: tier.quota.perKeyPerDay,
      perKeyPerPage: 0,
      perKeyPerKind: 0,
    })
    const result = await checkQuota({ store, config, event: shareEvent, tier, now: 0 })
    expect(result.withinQuota).toBe(false)
    expect(result.retryAfter).toBe(config.quotaWindowSeconds)
  })

  it('rejects once the per-(pubkey, page) daily cap is reached', async () => {
    const store = fakeStoreWithUsage({
      perKey: 0,
      perKeyPerPage: tier.quota.perKeyPerPagePerDay,
      perKeyPerKind: 0,
    })
    const result = await checkQuota({ store, config, event: shareEvent, tier, now: 0 })
    expect(result.withinQuota).toBe(false)
  })

  it('does not apply the per-page cap to a vote, which carries no page_id', async () => {
    const store = fakeStoreWithUsage({
      perKey: 0,
      perKeyPerPage: tier.quota.perKeyPerPagePerDay,
      perKeyPerKind: 0,
    })
    const result = await checkQuota({ store, config, event: voteEvent, tier, now: 0 })
    expect(result.withinQuota).toBe(true)
  })

  it('rejects once the per-kind daily cap is reached', async () => {
    const store = fakeStoreWithUsage({
      perKey: 0,
      perKeyPerPage: 0,
      perKeyPerKind: tier.quota.perKeyPerDayByKind.vote,
    })
    const result = await checkQuota({ store, config, event: voteEvent, tier, now: 0 })
    expect(result.withinQuota).toBe(false)
  })
})
