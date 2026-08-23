import { describe, it, expect } from 'vitest'
import { signEvent, deriveTarget } from '@elseweb/protocol'
import { createReader } from '../src/read.js'
import { createRelay } from '../src/relay.js'
import { createRelayPool } from '../src/pool.js'
import {
  createFakeClock,
  jsonResponse,
  makePolicy,
  makeStubFetch,
  makeAuthor,
  makeShareEvent,
} from './helpers.js'

function makeRelay({ url, clock, events }) {
  const fetch = makeStubFetch({
    policy: makePolicy(),
    onPublish: () => jsonResponse({ ok: true }),
    onQuery: () => jsonResponse({ events }),
  })
  return createRelay({ url, fetch, clock })
}

function makeReader({ clock, events, trustedIssuers = [] }) {
  const pool = createRelayPool({
    relays: [makeRelay({ url: 'https://relay.example', clock, events })],
    clock,
  })
  return createReader({ pool, clock, trustedIssuers })
}

async function makeReply({ privateKey, pubkey, now, parent, text = 'a reply' }) {
  return signEvent(
    {
      v: 1,
      kind: 'reply',
      pubkey,
      created_at: now,
      identity_mode: 'persistent',
      nonce: 0,
      attestations: [],
      page_id: parent.page_id,
      page_url: parent.page_url,
      parent_id: parent.id,
      root_id: parent.kind === 'share' ? parent.id : parent.root_id,
      content: { text },
    },
    privateKey
  )
}

describe('readTarget', () => {
  it('assembles replies under the share they belong to', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()
    const share = await makeShareEvent({ ...author, now: clock.now() })
    const reply = await makeReply({ ...author, now: clock.now() + 1, parent: share })

    const reader = makeReader({ clock, events: [share, reply] })
    const { threads, orphans } = await reader.readPage('https://example.com/')

    expect(threads).toHaveLength(1)
    expect(threads[0].share.id).toBe(share.id)
    expect(threads[0].replies.map((event) => event.id)).toEqual([reply.id])
    expect(orphans).toEqual([])
  })

  it('keeps a reply whose parent is missing as an orphan rather than dropping it', async () => {
    // SPEC.md section 5.2: in a federation the parent may live on a relay this reader does
    // not use. Dropping it would make the network look emptier the fewer relays someone
    // configured, which is exactly backwards.
    const clock = createFakeClock()
    const author = await makeAuthor()
    const absentParent = await makeShareEvent({ ...author, now: clock.now(), text: 'elsewhere' })
    const orphan = await makeReply({ ...author, now: clock.now() + 1, parent: absentParent })

    const reader = makeReader({ clock, events: [orphan] })
    const { threads, orphans } = await reader.readPage('https://example.com/')

    expect(threads).toEqual([])
    expect(orphans.map((event) => event.id)).toEqual([orphan.id])
  })

  it('drops an event whose page_id does not hash its page_url', async () => {
    // SPEC.md section 6.3: a relay MUST treat page_id as opaque and never re-derive it,
    // so a forged pairing between a hash and a URL is caught client-side or nowhere.
    const clock = createFakeClock()
    const author = await makeAuthor()
    const honest = await makeShareEvent({ ...author, now: clock.now() })
    const elsewhere = await deriveTarget('https://not-this-page.example/')
    const forged = await signEvent(
      { ...honest, id: undefined, sig: undefined, page_id: elsewhere.page_id },
      author.privateKey
    )

    const reader = makeReader({ clock, events: [honest, forged] })
    const { threads } = await reader.readPage('https://example.com/')

    expect(threads.map((thread) => thread.share.id)).toEqual([honest.id])
  })

  it('drops an event whose signature does not verify', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()
    const honest = await makeShareEvent({ ...author, now: clock.now() })
    const tampered = { ...honest, content: { text: 'not what was signed' } }

    const reader = makeReader({ clock, events: [honest, tampered] })
    const { threads } = await reader.readPage('https://example.com/')

    expect(threads).toHaveLength(1)
    expect(threads[0].share.id).toBe(honest.id)
  })

  it('raises INVALID_TARGET_URL rather than querying for an unusable URL', async () => {
    const clock = createFakeClock()
    const reader = makeReader({ clock, events: [] })

    await expect(reader.readPage('javascript:alert(1)')).rejects.toMatchObject({
      code: 'INVALID_TARGET_URL',
    })
  })
})
