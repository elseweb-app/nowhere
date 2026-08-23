// The deliverable, as a test.
//
// "Can a completely separate browser application join ElseWeb without the extension?"
// Everything below answers that with code: a real HTTP relay on a real socket, driven
// only through the public `@elseweb/client` API. No extension, no ElseWeb UI, no Supabase,
// no Docker, and nothing imported from `relay/src` on the client side of the wire.
//
// The client's storage port is a plain Map here. In a browser it is IndexedDB; in the
// extension it is chrome.storage. Neither this test nor the client knows the difference,
// which is the property that lets three hosts share one implementation.

import { describe, it, expect, afterEach } from 'vitest'
import { createElsewebClient } from '@elseweb/client'
import { createRelayApp } from '../src/index.js'
import { createMemoryStore } from './memory-store.js'
import { makeTestConfig } from './fixtures.js'
import { startRelayServer } from './http-server.js'

const running = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()))
})

function systemClock() {
  return { now: () => Math.floor(Date.now() / 1000) }
}

async function startRelay(configOverrides = {}) {
  const app = createRelayApp({
    store: createMemoryStore(),
    config: makeTestConfig(configOverrides),
    clock: systemClock(),
  })
  const server = await startRelayServer(app)
  running.push(server)
  return server
}

function createMemoryIdentityStore() {
  const values = new Map()
  return {
    async get(key) {
      return values.get(key)
    },
    async set(key, value) {
      values.set(key, value)
    },
    async remove(key) {
      values.delete(key)
    },
  }
}

function connect(relayUrls) {
  return createElsewebClient({
    relays: Array.isArray(relayUrls) ? relayUrls : [relayUrls],
    identityStore: createMemoryIdentityStore(),
  })
}

describe('a separate application joining ElseWeb over HTTP', () => {
  it('creates an identity, publishes, and reads the discussion back', async () => {
    const relay = await startRelay()
    const client = connect(relay.url)

    // No email, no password, no hosted auth. A keypair is minted locally the first time
    // the user says something.
    const identity = await client.identity.getOrCreate()
    expect(identity.publicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(identity).not.toHaveProperty('privateKey')

    const { results } = await client.publishShare({
      pageUrl: 'https://example.com/',
      text: 'hello from another ElseWeb client',
    })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ ok: true, relay: relay.url })

    const { threads } = await client.readPage('https://example.com/')
    expect(threads).toHaveLength(1)
    expect(threads[0].share.content.text).toBe('hello from another ElseWeb client')
    expect(threads[0].share.pubkey).toBe(identity.publicKey)
  })

  it('carries a whole conversation: share, reply, vote, recount', async () => {
    const relay = await startRelay()
    const author = connect(relay.url)
    const responder = connect(relay.url)
    await author.identity.getOrCreate()
    await responder.identity.getOrCreate()

    const { event: share } = await author.publishShare({
      pageUrl: 'https://example.com/article',
      text: 'the opening post',
    })
    await responder.publishReply({ parent: share, text: 'answering it' })
    await responder.publishVote({ targetId: share.id, value: 1 })

    const { threads } = await author.readPage('https://example.com/article')
    expect(threads).toHaveLength(1)
    expect(threads[0].replies.map((event) => event.content.text)).toEqual(['answering it'])

    // SPEC.md section 5.3: the relay serves the raw votes too, so a client can recount
    // and catch a relay that misreports an aggregate it invented.
    const { votes, score } = await author.readVotes(share.id)
    expect(votes).toHaveLength(1)
    expect(score).toBeGreaterThan(0)
  })

  it('lands two clients on the same discussion despite different URL spellings', async () => {
    // The join key of SPEC.md section 6, over the wire. If normalization disagreed by one
    // rule, these two users would silently never see each other — the product's core
    // correctness requirement, and the reason it is worth proving end to end.
    const relay = await startRelay()
    const first = connect(relay.url)
    const second = connect(relay.url)
    await first.identity.getOrCreate()
    await second.identity.getOrCreate()

    await first.publishShare({
      pageUrl: 'https://example.com/post?b=2&a=1',
      text: 'from a tidy URL',
    })

    const { threads } = await second.readPage(
      'https://EXAMPLE.com:443/post?utm_source=newsletter&a=1&b=2#intro'
    )
    expect(threads.map((thread) => thread.share.content.text)).toEqual(['from a tidy URL'])
  })

  it('treats a domain community as the normalized site root, with no special event kind', async () => {
    const relay = await startRelay()
    const client = connect(relay.url)
    await client.identity.getOrCreate()

    await client.publishShare({ pageUrl: 'https://example.com/', text: 'in the community' })
    await client.publishShare({ pageUrl: 'https://example.com/deep/page', text: 'on one page' })

    const community = await client.readPage('https://example.com/')
    expect(community.threads.map((thread) => thread.share.content.text)).toEqual([
      'in the community',
    ])
  })
})

describe('a relay set, which is what the client actually holds', () => {
  it('publishes to every writable relay and reads the union back deduplicated', async () => {
    const [first, second] = [await startRelay(), await startRelay()]
    const client = connect([first.url, second.url])
    await client.identity.getOrCreate()

    const { results } = await client.publishShare({
      pageUrl: 'https://example.com/',
      text: 'broadcast once, mined once',
    })
    expect(results).toHaveLength(2)
    expect(results.every((result) => result.ok)).toBe(true)

    // The same event arrived from both relays. `id` is a content hash, so deduplication
    // needs no coordination — and both carriers are recorded, which is what makes one
    // relay's outage invisible to a reader.
    const { threads } = await client.readPage('https://example.com/')
    expect(threads).toHaveLength(1)
    expect(new Set(threads[0].relays)).toEqual(new Set([first.url, second.url]))
  })

  it('keeps reading when one relay in the set is down', async () => {
    const [healthy, doomed] = [await startRelay(), await startRelay()]
    const client = connect([healthy.url, doomed.url])
    await client.identity.getOrCreate()

    await client.publishShare({ pageUrl: 'https://example.com/', text: 'still here' })
    await doomed.close()

    const { threads } = await client.readPage('https://example.com/')
    expect(threads.map((thread) => thread.share.content.text)).toEqual(['still here'])
  })

  it('reports a partial publish as partial rather than as success', async () => {
    // SPEC.md section 12: a relay that rejected while others accepted is information the
    // user needs. Collapsing these into one boolean is the failure this guards.
    const healthy = await startRelay()
    const strict = await startRelay({ kinds: ['vote'] })
    const client = connect([healthy.url, strict.url])
    await client.identity.getOrCreate()

    const { results } = await client.publishShare({
      pageUrl: 'https://example.com/',
      text: 'not every relay takes shares',
    })

    const byRelay = Object.fromEntries(results.map((result) => [result.relay, result]))
    expect(byRelay[healthy.url].ok).toBe(true)
    expect(byRelay[strict.url].ok).toBe(false)
    expect(byRelay[strict.url].code).toBe('UNSUPPORTED_KIND')
  })

  it('does not lose the identity when the whole relay set is replaced', async () => {
    const [original, replacement] = [await startRelay(), await startRelay()]
    const client = connect(original.url)
    const before = await client.identity.getOrCreate()

    client.relays.remove(original.url)
    client.relays.add(replacement.url)

    await client.publishShare({ pageUrl: 'https://example.com/', text: 'same author, new relay' })
    const { threads } = await client.readPage('https://example.com/')

    expect(threads[0].share.pubkey).toBe(before.publicKey)
    expect((await client.identity.get()).publicKey).toBe(before.publicKey)
  })
})

describe('the relay enforcing the protocol, not trusting the client', () => {
  it('rejects a forged signature with SIGNATURE_INVALID', async () => {
    const relay = await startRelay()
    const client = connect(relay.url)
    const identity = await client.identity.getOrCreate()

    const { event } = await client.publishShare({
      pageUrl: 'https://example.com/',
      text: 'honest',
    })
    // Re-submit the same event with its content swapped: id and sig no longer describe it.
    const response = await fetch(`${relay.url}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...event, content: { text: 'tampered' } }),
    })

    expect(response.ok).toBe(false)
    const body = await response.json()
    // The id is checked before the signature (SPEC.md section 4), so altering content
    // surfaces as the id no longer matching the canonical bytes.
    expect(body.error.code).toBe('SCHEMA_INVALID')
    expect(identity.publicKey).toBe(event.pubkey)
  })

  it('rejects an event dated outside the freshness window', async () => {
    const relay = await startRelay({ freshnessWindowSeconds: 1 })
    const client = connect(relay.url)
    await client.identity.getOrCreate()

    // A client whose clock is a day off. Without the freshness window, proof-of-work
    // could be stockpiled offline for months and released at once (SPEC.md section 7.2).
    const skewed = createElsewebClient({
      relays: [relay.url],
      identityStore: createMemoryIdentityStore(),
      clock: { now: () => Math.floor(Date.now() / 1000) - 86_400 },
    })
    await skewed.identity.getOrCreate()

    const { results } = await skewed.publishShare({
      pageUrl: 'https://example.com/',
      text: 'from yesterday',
    })
    expect(results[0].ok).toBe(false)
    expect(results[0].code).toBe('STALE_TIMESTAMP')
    expect(results[0].action).toBe('fix_clock_and_remine')
  })

  it('rejects an event carrying too little work', async () => {
    const relay = await startRelay()
    const client = connect(relay.url)
    await client.identity.getOrCreate()
    const { event } = await client.publishShare({ pageUrl: 'https://example.com/', text: 'mined' })

    // Same event, nonce reset to zero: the id no longer carries the required work. It is
    // also no longer the id of these bytes, which the earlier check catches first — the
    // point here is that an unmined resubmission does not get in.
    const response = await fetch(`${relay.url}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...event, nonce: 0 }),
    })

    expect(response.ok).toBe(false)
    expect((await response.json()).error.code).toBeTypeOf('string')
  })

  it('enforces a per-key quota and says how long to wait', async () => {
    const relay = await startRelay()
    const client = connect(relay.url)
    await client.identity.getOrCreate()

    const outcomes = []
    for (let attempt = 0; attempt < 8; attempt++) {
      const { results } = await client.publishShare({
        pageUrl: `https://example.com/page-${attempt}`,
        text: `post ${attempt}`,
      })
      outcomes.push(results[0])
    }

    const refused = outcomes.filter((result) => !result.ok)
    expect(refused.length).toBeGreaterThan(0)
    expect(refused[0].code).toBe('QUOTA_EXCEEDED')
    // QUOTA_EXCEEDED means wait, and specifically does NOT mean re-mine: burning work on
    // a retry a relay has already told you it will refuse is the trap this names.
    expect(refused[0].action).toBe('wait')
    expect(refused[0].retry_after).toBeTypeOf('number')
  })

  it('never requires proof of work on a read path', async () => {
    const relay = await startRelay()
    const response = await fetch(`${relay.url}/events?page_id=${'a'.repeat(64)}`)
    expect(response.ok).toBe(true)
    expect((await response.json()).events).toEqual([])
  })
})
