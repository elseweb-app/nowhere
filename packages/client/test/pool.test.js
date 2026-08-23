import { describe, it, expect } from 'vitest'
import { difficultyOf } from '@elseweb/protocol'
import { createRelay } from '../src/relay.js'
import { createRelayPool } from '../src/pool.js'
import {
  createFakeClock,
  jsonResponse,
  makePolicy,
  makeStubFetch,
  makeAuthor,
  makeShareEvent,
  makeShareDraft,
} from './helpers.js'

function makeRelay({ url, clock, policy, onPublish, onQuery, readable = true, writable = true }) {
  const fetch = makeStubFetch({
    policy,
    onPublish: onPublish ?? (() => jsonResponse({})),
    onQuery: onQuery ?? (() => jsonResponse({ events: [] })),
  })
  return createRelay({ url, fetch, clock, readable, writable })
}

describe('reading: dedupe and fault tolerance', () => {
  it('deduplicates the same event arriving from three relays', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()
    const event = await makeShareEvent({ ...author, now: clock.now() })

    const relays = ['a', 'b', 'c'].map((label) =>
      makeRelay({
        url: `https://relay-${label}.example`,
        clock,
        policy: makePolicy(),
        onQuery: () => jsonResponse({ events: [event] }),
      })
    )
    const pool = createRelayPool({ relays, clock })

    const merged = await pool.queryPage({ pageId: event.page_id })

    expect(merged).toHaveLength(1)
    expect(merged[0].event.id).toBe(event.id)
    expect(new Set(merged[0].relays)).toEqual(
      new Set(['https://relay-a.example', 'https://relay-b.example', 'https://relay-c.example'])
    )
  })

  it('does not let a slow or failing relay break the read', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()
    const eventA = await makeShareEvent({ ...author, now: clock.now(), text: 'from a' })
    const eventC = await makeShareEvent({ ...author, now: clock.now(), text: 'from c' })

    const healthyA = makeRelay({
      url: 'https://relay-a.example',
      clock,
      policy: makePolicy(),
      onQuery: () => jsonResponse({ events: [eventA] }),
    })
    // Stands in for a relay that is down or deliberately slow: its fetch never
    // resolves except when the caller's own timeout aborts it.
    const neverRespond = async (url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
    const timingOutRelay = createRelay({
      url: 'https://relay-b.example',
      fetch: neverRespond,
      clock,
    })
    const healthyC = makeRelay({
      url: 'https://relay-c.example',
      clock,
      policy: makePolicy(),
      onQuery: () => jsonResponse({ events: [eventC] }),
    })

    const pool = createRelayPool({ relays: [healthyA, timingOutRelay, healthyC], clock })
    const merged = await pool.queryPage({ pageId: eventA.page_id, timeoutMs: 20 })

    const ids = merged.map((entry) => entry.event.id).sort()
    expect(ids).toEqual([eventA.id, eventC.id].sort())
  })
})

describe('publishing', () => {
  it('mines once at the highest difficulty required across writable relays', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()

    const publishedBodies = []
    const relayLow = makeRelay({
      url: 'https://relay-low.example',
      clock,
      policy: makePolicy({ pow: { default_difficulty: { share: 4 } } }),
      onPublish: (event) => {
        publishedBodies.push({ relay: 'low', id: event.id })
        return jsonResponse({})
      },
    })
    const relayHigh = makeRelay({
      url: 'https://relay-high.example',
      clock,
      policy: makePolicy({ pow: { default_difficulty: { share: 7 } } }),
      onPublish: (event) => {
        publishedBodies.push({ relay: 'high', id: event.id })
        return jsonResponse({})
      },
    })

    const pool = createRelayPool({ relays: [relayLow, relayHigh], clock })
    const unsigned = await makeShareDraft({ pubkey: author.pubkey, now: clock.now() })

    const { event, results } = await pool.publish({
      event: unsigned,
      privateKey: author.privateKey,
    })

    expect(difficultyOf(event.id)).toBeGreaterThanOrEqual(7)
    expect(publishedBodies).toHaveLength(2)
    // The same mined event went to both relays: one mining pass, not one per relay.
    expect(publishedBodies[0].id).toBe(publishedBodies[1].id)
    expect(results.every((result) => result.ok)).toBe(true)
  })

  it('reports per-relay outcomes separately rather than collapsing to one boolean', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()

    const relayAccepts = makeRelay({
      url: 'https://relay-accepts.example',
      clock,
      policy: makePolicy(),
    })
    let quotaCalls = 0
    const relayQuotaExceeded = makeRelay({
      url: 'https://relay-quota.example',
      clock,
      policy: makePolicy(),
      onPublish: () => {
        quotaCalls += 1
        return jsonResponse(
          { error: { code: 'QUOTA_EXCEEDED', message: 'slow down', retry_after: 3600 } },
          { status: 429 }
        )
      },
    })

    const pool = createRelayPool({ relays: [relayAccepts, relayQuotaExceeded], clock })
    const unsigned = await makeShareDraft({ pubkey: author.pubkey, now: clock.now() })

    const { results } = await pool.publish({ event: unsigned, privateKey: author.privateKey })

    const accepted = results.find((result) => result.relay === 'https://relay-accepts.example')
    const rejected = results.find((result) => result.relay === 'https://relay-quota.example')

    expect(accepted.ok).toBe(true)
    expect(rejected.ok).toBe(false)
    expect(rejected.code).toBe('QUOTA_EXCEEDED')
    expect(rejected.action).toBe('wait')
    expect(rejected.retry_after).toBe(3600)
    // QUOTA_EXCEEDED must never trigger a re-mine: exactly one publish attempt.
    expect(quotaCalls).toBe(1)
  })

  it('surfaces ATTESTATION_REQUIRED without retrying blindly', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()

    let calls = 0
    const relay = makeRelay({
      url: 'https://relay-gated.example',
      clock,
      policy: makePolicy(),
      onPublish: () => {
        calls += 1
        return jsonResponse(
          {
            error: {
              code: 'ATTESTATION_REQUIRED',
              message: 'membership required',
              required_claims: ['membership'],
              trusted_issuers: [],
            },
          },
          { status: 403 }
        )
      },
    })

    const pool = createRelayPool({ relays: [relay], clock })
    const unsigned = await makeShareDraft({ pubkey: author.pubkey, now: clock.now() })

    const { results } = await pool.publish({ event: unsigned, privateKey: author.privateKey })

    expect(results[0].code).toBe('ATTESTATION_REQUIRED')
    expect(results[0].action).toBe('surface_to_user')
    expect(calls).toBe(1)
  })

  it('re-mines exactly once, and only against the relay that demanded more work', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()

    const easyRelay = makeRelay({
      url: 'https://relay-easy.example',
      clock,
      policy: makePolicy({ pow: { default_difficulty: { share: 0 } } }),
    })

    let strictCalls = 0
    const strictRelay = makeRelay({
      url: 'https://relay-strict.example',
      clock,
      policy: makePolicy({ pow: { default_difficulty: { share: 0 } } }),
      onPublish: (event) => {
        strictCalls += 1
        if (strictCalls === 1) {
          return jsonResponse(
            { error: { code: 'POW_INSUFFICIENT', message: 'not enough', required_difficulty: 6 } },
            { status: 400 }
          )
        }
        expect(difficultyOf(event.id)).toBeGreaterThanOrEqual(6)
        return jsonResponse({})
      },
    })

    const pool = createRelayPool({ relays: [easyRelay, strictRelay], clock })
    const unsigned = await makeShareDraft({ pubkey: author.pubkey, now: clock.now() })

    const { results, remined } = await pool.publish({
      event: unsigned,
      privateKey: author.privateKey,
    })

    expect(strictCalls).toBe(2)
    expect(remined).toBeDefined()
    expect(results.every((result) => result.ok)).toBe(true)
  })

  it('excludes a relay whose policy cannot be fetched, without failing the others', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()

    // A relay whose fetch always answers with something that fails PolicySchema —
    // standing in for a down or misbehaving relay, per packages/client/AGENTS.md
    // "Failure is normal".
    const brokenRelay = createRelay({
      url: 'https://relay-broken.example',
      fetch: async () => jsonResponse({ not: 'a policy' }),
      clock,
    })
    const healthyRelay = makeRelay({
      url: 'https://relay-healthy.example',
      clock,
      policy: makePolicy(),
    })

    const pool = createRelayPool({ relays: [brokenRelay, healthyRelay], clock })
    const unsigned = await makeShareDraft({ pubkey: author.pubkey, now: clock.now() })

    const { results } = await pool.publish({ event: unsigned, privateKey: author.privateKey })

    const broken = results.find((result) => result.relay === 'https://relay-broken.example')
    const healthy = results.find((result) => result.relay === 'https://relay-healthy.example')

    expect(broken.ok).toBe(false)
    expect(broken.code).toBe('RELAY_UNREACHABLE')
    expect(healthy.ok).toBe(true)
  })

  it('skips and reports a relay whose policy does not list the event kind', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()

    const voteOnlyRelay = makeRelay({
      url: 'https://relay-vote-only.example',
      clock,
      policy: makePolicy({ kinds: ['vote'] }),
    })
    const shareRelay = makeRelay({
      url: 'https://relay-share.example',
      clock,
      policy: makePolicy(),
    })

    const pool = createRelayPool({ relays: [voteOnlyRelay, shareRelay], clock })
    const unsigned = await makeShareDraft({ pubkey: author.pubkey, now: clock.now() })

    const { results } = await pool.publish({ event: unsigned, privateKey: author.privateKey })

    const skipped = results.find((result) => result.relay === 'https://relay-vote-only.example')
    const accepted = results.find((result) => result.relay === 'https://relay-share.example')

    expect(skipped.ok).toBe(false)
    expect(skipped.code).toBe('UNSUPPORTED_KIND')
    expect(skipped.kinds).toEqual(['vote'])
    expect(accepted.ok).toBe(true)
  })

  it('rejects an oversized event before mining, with the tightest max_payload_bytes', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()

    let publishCalls = 0
    const relay = makeRelay({
      url: 'https://relay-tiny.example',
      clock,
      policy: makePolicy({ max_payload_bytes: 32 }),
      onPublish: () => {
        publishCalls += 1
        return jsonResponse({})
      },
    })

    const pool = createRelayPool({ relays: [relay], clock })
    const unsigned = await makeShareDraft({
      pubkey: author.pubkey,
      now: clock.now(),
      text: 'this share is far too long to fit in thirty-two bytes',
    })

    let caught = null
    try {
      await pool.publish({ event: unsigned, privateKey: author.privateKey })
    } catch (error) {
      caught = error
    }

    expect(caught).not.toBeNull()
    expect(caught.code).toBe('PAYLOAD_TOO_LARGE')
    expect(caught.max_payload_bytes).toBe(32)
    // The relay was never even asked: the check ran before mining, not after.
    expect(publishCalls).toBe(0)
  })

  it('rebuilds and re-mines once when created_at is already outside the freshness window', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()

    let receivedCreatedAt = null
    const relay = makeRelay({
      url: 'https://relay-freshness.example',
      clock,
      policy: makePolicy({ freshness_window_seconds: 5 }),
      onPublish: (event) => {
        receivedCreatedAt = event.created_at
        return jsonResponse({})
      },
    })

    const pool = createRelayPool({ relays: [relay], clock })
    // Built as though mining had already been running a while before publish() ever
    // gets to check freshness: created_at is 100 seconds old against a 5-second window.
    const unsigned = await makeShareDraft({ pubkey: author.pubkey, now: clock.now() - 100 })

    const { event, results } = await pool.publish({
      event: unsigned,
      privateKey: author.privateKey,
    })

    expect(receivedCreatedAt).toBe(clock.now())
    expect(event.created_at).toBe(clock.now())
    expect(event.created_at).not.toBe(unsigned.created_at)
    expect(results.every((result) => result.ok)).toBe(true)
  })
})

describe('a single-relay set', () => {
  it('goes through the same publish and read paths as a multi-relay set', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()

    const relay = makeRelay({
      url: 'https://only-relay.example',
      clock,
      policy: makePolicy(),
      onQuery: () => jsonResponse({ events: [] }),
    })
    const pool = createRelayPool({ relays: [relay], clock })

    const unsigned = await makeShareDraft({ pubkey: author.pubkey, now: clock.now() })

    const { results } = await pool.publish({ event: unsigned, privateKey: author.privateKey })
    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(true)

    const published = await makeShareEvent({ ...author, now: clock.now() })
    const relayWithEvent = makeRelay({
      url: 'https://only-relay.example',
      clock,
      policy: makePolicy(),
      onQuery: () => jsonResponse({ events: [published] }),
    })
    const readPool = createRelayPool({ relays: [relayWithEvent], clock })
    const merged = await readPool.queryPage({ pageId: published.page_id })

    expect(merged).toHaveLength(1)
    expect(merged[0].relays).toEqual(['https://only-relay.example'])
  })
})
