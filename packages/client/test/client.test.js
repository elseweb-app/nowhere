import { describe, it, expect } from 'vitest'
import { createElsewebClient } from '../src/client.js'
import { createFakeClock, createFakeStorage, jsonResponse, makePolicy } from './helpers.js'

// One relay's worth of stub endpoints that actually keeps what it is given, so a test can
// publish and then read the same event back through the public API — the shape the
// end-to-end proof takes, minus the socket.
function makeStoringRelay({ policy = makePolicy() } = {}) {
  const stored = []
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/policy')) return jsonResponse(policy)
    if (parsed.pathname.endsWith('/events') && options.method === 'POST') {
      stored.push(JSON.parse(options.body))
      return jsonResponse({ ok: true })
    }
    if (parsed.pathname.endsWith('/events')) {
      const pageId = parsed.searchParams.get('page_id')
      const targetId = parsed.searchParams.get('target_id')
      return jsonResponse({
        events: stored.filter((event) =>
          targetId ? event.target_id === targetId : event.page_id === pageId
        ),
      })
    }
    throw new Error(`unhandled stub request: ${url}`)
  }
  return { fetch, stored }
}

function makeClient({ fetch, clock, storage }) {
  return createElsewebClient({
    relays: ['https://relay.example'],
    identityStore: storage,
    clock,
    fetch,
  })
}

describe('identity', () => {
  it('never hands a private key back to the consumer', async () => {
    // The seed leaves the device only inside the encrypted envelope of SPEC.md section 15.
    // A consumer that is never given one cannot leak it, which is stronger than asking.
    const storage = createFakeStorage()
    const { fetch } = makeStoringRelay()
    const client = makeClient({ fetch, clock: createFakeClock(), storage })

    const created = await client.identity.getOrCreate()

    expect(created.publicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(created).not.toHaveProperty('privateKey')
    expect(await client.identity.get()).not.toHaveProperty('privateKey')
  })

  it('reuses the identity already in the injected store', async () => {
    const storage = createFakeStorage()
    const { fetch } = makeStoringRelay()
    const clock = createFakeClock()

    const first = await makeClient({ fetch, clock, storage }).identity.getOrCreate()
    // A second client over the same storage port is what a page reload looks like.
    const second = await makeClient({ fetch, clock, storage }).identity.getOrCreate()

    expect(second.publicKey).toBe(first.publicKey)
  })

  it('refuses to publish before an identity exists', async () => {
    const { fetch } = makeStoringRelay()
    const client = makeClient({ fetch, clock: createFakeClock(), storage: createFakeStorage() })

    await expect(
      client.publishShare({ pageUrl: 'https://example.com/', text: 'hello' })
    ).rejects.toMatchObject({ code: 'NO_IDENTITY', action: 'create_identity' })
  })
})

describe('publish and read through the public API', () => {
  it('publishes a share and reads it back on the same page', async () => {
    const storage = createFakeStorage()
    const { fetch } = makeStoringRelay()
    const client = makeClient({ fetch, clock: createFakeClock(), storage })
    await client.identity.getOrCreate()

    const { results } = await client.publishShare({
      pageUrl: 'https://example.com/',
      text: 'hello from a plain consumer',
    })
    expect(results.every((result) => result.ok)).toBe(true)

    const { threads } = await client.readPage('https://example.com/')
    expect(threads).toHaveLength(1)
    expect(threads[0].share.content.text).toBe('hello from a plain consumer')
  })

  it('normalizes the page URL so two spellings reach the same discussion', async () => {
    // The join key of SPEC.md section 6: a reader arriving with tracking parameters and a
    // fragment must land on what the author published to, or the two never see each other.
    const storage = createFakeStorage()
    const { fetch } = makeStoringRelay()
    const client = makeClient({ fetch, clock: createFakeClock(), storage })
    await client.identity.getOrCreate()

    await client.publishShare({ pageUrl: 'https://example.com/post', text: 'same page' })
    const { threads } = await client.readPage('https://example.com/post?utm_source=x#section')

    expect(threads).toHaveLength(1)
    expect(threads[0].share.content.text).toBe('same page')
  })

  it('threads a reply onto the share it answers', async () => {
    const storage = createFakeStorage()
    const { fetch } = makeStoringRelay()
    const client = makeClient({ fetch, clock: createFakeClock(), storage })
    await client.identity.getOrCreate()

    const { event: share } = await client.publishShare({
      pageUrl: 'https://example.com/',
      text: 'the share',
    })
    await client.publishReply({ parent: share, text: 'the reply' })

    const { threads } = await client.readPage('https://example.com/')
    expect(threads).toHaveLength(1)
    expect(threads[0].replies.map((event) => event.content.text)).toEqual(['the reply'])
  })

  it('counts a vote through readVotes', async () => {
    const storage = createFakeStorage()
    const { fetch } = makeStoringRelay()
    const client = makeClient({ fetch, clock: createFakeClock(), storage })
    await client.identity.getOrCreate()

    const { event: share } = await client.publishShare({
      pageUrl: 'https://example.com/',
      text: 'worth voting on',
    })
    await client.publishVote({ targetId: share.id, value: 1 })

    const { votes, score } = await client.readVotes(share.id)
    expect(votes).toHaveLength(1)
    expect(score).toBeGreaterThan(0)
  })
})

describe('the relay set', () => {
  it('is editable at runtime without touching identity', async () => {
    // SPEC.md section 12: the keypair is the identity, a relay is only a place events are
    // kept. Removing every relay and adding new ones must lose nothing.
    const storage = createFakeStorage()
    const { fetch } = makeStoringRelay()
    const client = makeClient({ fetch, clock: createFakeClock(), storage })
    const before = await client.identity.getOrCreate()

    client.relays.add('https://second.example')
    expect(client.relays.list().map((relay) => relay.url)).toEqual([
      'https://relay.example',
      'https://second.example',
    ])

    client.relays.remove('https://relay.example')
    client.relays.remove('https://second.example')
    expect(client.relays.list()).toEqual([])
    expect((await client.identity.get()).publicKey).toBe(before.publicKey)
  })
})
