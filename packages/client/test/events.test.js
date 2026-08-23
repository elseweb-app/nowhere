import { describe, it, expect } from 'vitest'
import { mine, signEvent, safeParseEvent } from '@elseweb/protocol'
import { buildShare, buildReply, buildVote, estimateEncodedBytes } from '../src/events.js'
import { isElsewebError } from '../src/errors.js'
import { createFakeClock, makeAuthor } from './helpers.js'

// Difficulty 0 everywhere: these tests are about envelope shape, not proof-of-work.
async function mineAndSign(draft, privateKey) {
  const mined = await mine(draft, 0)
  return signEvent(mined, privateKey)
}

async function makeIdentity() {
  const author = await makeAuthor()
  return { author, identity: { publicKey: author.pubkey, identityMode: 'persistent' } }
}

describe('buildShare', () => {
  it('produces an envelope that validates after mining and signing', async () => {
    const clock = createFakeClock()
    const { author, identity } = await makeIdentity()
    const draft = await buildShare({
      pageUrl: 'https://example.com/thread',
      text: 'hello world',
      identity,
      now: clock.now(),
    })
    const event = await mineAndSign(draft, author.privateKey)

    const result = safeParseEvent(event)
    expect(result.success).toBe(true)
  })

  it('omits parent_id, root_id and target_id rather than leaving them empty', async () => {
    const clock = createFakeClock()
    const { identity } = await makeIdentity()
    const draft = await buildShare({
      pageUrl: 'https://example.com/thread',
      text: 'hello',
      identity,
      now: clock.now(),
    })

    expect('parent_id' in draft).toBe(false)
    expect('root_id' in draft).toBe(false)
    expect('target_id' in draft).toBe(false)
    expect('anchor' in draft).toBe(false)
  })

  it('carries an anchor only when anchorId is given', async () => {
    const clock = createFakeClock()
    const { identity } = await makeIdentity()
    const draft = await buildShare({
      pageUrl: 'https://example.com/thread',
      text: 'hello',
      anchorId: 'post-123',
      identity,
      now: clock.now(),
    })

    expect(draft.anchor).toEqual({ id: 'post-123' })
  })

  it('raises INVALID_TARGET_URL for an unnormalizable page URL', async () => {
    const clock = createFakeClock()
    const { identity } = await makeIdentity()

    await expect(
      buildShare({ pageUrl: 'not a url', text: 'hello', identity, now: clock.now() })
    ).rejects.toSatisfy((error) => isElsewebError(error) && error.code === 'INVALID_TARGET_URL')
  })

  it('applies canonicalizeUrl before deriving the target', async () => {
    const clock = createFakeClock()
    const { identity } = await makeIdentity()
    const draft = await buildShare({
      pageUrl: 'https://example.com/raw?utm_source=x',
      text: 'hello',
      identity,
      now: clock.now(),
      canonicalizeUrl: () => 'https://example.com/canonical',
    })

    expect(draft.page_url).toBe('https://example.com/canonical')
  })
})

describe('buildReply', () => {
  async function makeRootShare(clock, author) {
    const identity = { publicKey: author.pubkey, identityMode: 'persistent' }
    const draft = await buildShare({
      pageUrl: 'https://example.com/thread',
      text: 'root post',
      identity,
      now: clock.now(),
    })
    return mineAndSign(draft, author.privateKey)
  }

  it('produces an envelope that validates after mining and signing', async () => {
    const clock = createFakeClock()
    const { author, identity } = await makeIdentity()
    const root = await makeRootShare(clock, author)

    const draft = await buildReply({
      parent: root,
      text: 'a reply',
      identity,
      now: clock.now(),
    })
    const event = await mineAndSign(draft, author.privateKey)

    expect(safeParseEvent(event).success).toBe(true)
  })

  it('omits target_id, matching a reply that carries no vote field', async () => {
    const clock = createFakeClock()
    const { author, identity } = await makeIdentity()
    const root = await makeRootShare(clock, author)

    const draft = await buildReply({ parent: root, text: 'a reply', identity, now: clock.now() })

    expect('target_id' in draft).toBe(false)
  })

  it("matches the root's page_id, page_url and anchor exactly", async () => {
    const clock = createFakeClock()
    const { author, identity } = await makeIdentity()
    const root = await buildShare({
      pageUrl: 'https://example.com/thread',
      text: 'root',
      anchorId: 'post-1',
      identity,
      now: clock.now(),
    })
    const rootEvent = await mineAndSign(root, author.privateKey)

    const reply = await buildReply({
      parent: rootEvent,
      text: 'a reply',
      identity,
      now: clock.now(),
    })

    expect(reply.page_id).toBe(rootEvent.page_id)
    expect(reply.page_url).toBe(rootEvent.page_url)
    expect(reply.anchor).toEqual(rootEvent.anchor)
    expect(reply.root_id).toBe(rootEvent.id)
    expect(reply.parent_id).toBe(rootEvent.id)
  })

  it('resolves root_id to the thread root, not the direct parent, for a reply-to-reply', async () => {
    const clock = createFakeClock()
    const { author, identity } = await makeIdentity()
    const root = await makeRootShare(clock, author)

    const firstReplyDraft = await buildReply({
      parent: root,
      text: 'first reply',
      identity,
      now: clock.now(),
    })
    const firstReply = await mineAndSign(firstReplyDraft, author.privateKey)

    const secondReplyDraft = await buildReply({
      parent: firstReply,
      text: 'second reply',
      identity,
      now: clock.now(),
    })

    expect(secondReplyDraft.parent_id).toBe(firstReply.id)
    expect(secondReplyDraft.root_id).toBe(root.id)
    expect(secondReplyDraft.root_id).not.toBe(firstReply.id)
  })

  it('rejects a root whose page_id does not match hash(page_url)', async () => {
    const clock = createFakeClock()
    const { identity } = await makeIdentity()
    const forgedRoot = {
      kind: 'share',
      id: 'a'.repeat(64),
      page_id: 'b'.repeat(64), // does not hash from page_url below
      page_url: 'https://example.com/thread',
    }

    await expect(
      buildReply({ parent: forgedRoot, text: 'a reply', identity, now: clock.now() })
    ).rejects.toSatisfy((error) => isElsewebError(error) && error.code === 'INVALID_TARGET_URL')
  })

  it('accepts the explicit ids form for a caller that only has ids', async () => {
    const clock = createFakeClock()
    const { identity } = await makeIdentity()

    const draft = await buildReply({
      parentId: 'c'.repeat(64),
      rootId: 'd'.repeat(64),
      pageUrl: 'https://example.com/thread',
      text: 'a reply',
      identity,
      now: clock.now(),
    })

    expect(draft.parent_id).toBe('c'.repeat(64))
    expect(draft.root_id).toBe('d'.repeat(64))
    expect('anchor' in draft).toBe(false)
  })
})

describe('buildVote', () => {
  it('produces an envelope that validates after mining and signing', async () => {
    const clock = createFakeClock()
    const { author, identity } = await makeIdentity()
    const draft = buildVote({
      targetId: 'e'.repeat(64),
      value: 1,
      identity,
      now: clock.now(),
    })
    const event = await mineAndSign(draft, author.privateKey)

    expect(safeParseEvent(event).success).toBe(true)
  })

  it('omits page_id and page_url, which a vote never carries', async () => {
    const clock = createFakeClock()
    const { identity } = await makeIdentity()
    const draft = buildVote({ targetId: 'e'.repeat(64), value: -1, identity, now: clock.now() })

    expect('page_id' in draft).toBe(false)
    expect('page_url' in draft).toBe(false)
  })

  it('refuses a value other than 1 or -1', async () => {
    const clock = createFakeClock()
    const { identity } = await makeIdentity()

    expect(() =>
      buildVote({ targetId: 'e'.repeat(64), value: 2, identity, now: clock.now() })
    ).toThrow()
  })
})

describe('estimateEncodedBytes', () => {
  it('accounts for the nonce, id and sig fields not yet on the draft', async () => {
    const clock = createFakeClock()
    const { identity } = await makeIdentity()
    const draft = await buildShare({
      pageUrl: 'https://example.com/thread',
      text: 'hello',
      identity,
      now: clock.now(),
    })

    const estimate = estimateEncodedBytes(draft)
    const draftBytes = new TextEncoder().encode(JSON.stringify(draft)).length

    expect(estimate).toBeGreaterThan(draftBytes)
  })
})
