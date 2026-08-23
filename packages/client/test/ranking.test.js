import { describe, it, expect } from 'vitest'
import { tallyVotes, rankEvents } from '../src/ranking.js'

const NOW = 1_700_000_000

function makeEvent({ id, pubkey, createdAt, attestations = [], identityMode = 'persistent' }) {
  return {
    id,
    pubkey,
    created_at: createdAt,
    identity_mode: identityMode,
    attestations,
  }
}

function makeVote({ id, pubkey, targetId, createdAt, value }) {
  return { id, pubkey, target_id: targetId, created_at: createdAt, content: { value } }
}

describe('rankEvents', () => {
  it('does not simply reproduce chronological order', () => {
    const older = makeEvent({
      id: 'older',
      pubkey: 'author-strong',
      createdAt: NOW - 3600,
      attestations: [{ type: 'issuer-signed' }],
    })
    const newer = makeEvent({ id: 'newer', pubkey: 'author-weak', createdAt: NOW - 10 })

    const ranked = rankEvents({
      events: [newer, older],
      voteScoreByEventId: new Map([['older', 20]]),
      now: NOW,
    })

    // Chronological order would put `newer` first; a strongly attested, well-voted
    // older event must be able to outrank a bare-minimum brand-new one.
    expect(ranked.map((event) => event.id)).toEqual(['older', 'newer'])
  })

  it('caps a single dominant author instead of letting them fill the view', () => {
    const dominant = Array.from({ length: 20 }, (_, index) =>
      makeEvent({ id: `dominant-${index}`, pubkey: 'author-dominant', createdAt: NOW - index })
    )
    const others = ['author-b', 'author-c', 'author-d'].map((pubkey, index) =>
      makeEvent({ id: `other-${pubkey}`, pubkey, createdAt: NOW - 1000 - index })
    )

    const ranked = rankEvents({
      events: [...dominant, ...others],
      now: NOW,
      limit: 10,
      maxPerAuthor: 3,
    })

    const countByAuthor = new Map()
    for (const event of ranked) {
      countByAuthor.set(event.pubkey, (countByAuthor.get(event.pubkey) ?? 0) + 1)
    }

    expect(countByAuthor.get('author-dominant')).toBeLessThanOrEqual(3)
    expect(countByAuthor.size).toBeGreaterThan(1)
  })

  it('weights trusted attestations rather than mere presence of the array', () => {
    // Both events carry one attestation each and are otherwise identical, so only the
    // caller's precomputed trust map can be why one outranks the other — a bare,
    // untrusted `attestations` array must not buy a rank boost on its own (SPEC.md
    // section 8).
    const trustedEvent = makeEvent({
      id: 'trusted',
      pubkey: 'author-a',
      createdAt: NOW - 10,
      attestations: [{ type: 'issuer-signed' }],
    })
    const untrustedEvent = makeEvent({
      id: 'untrusted',
      pubkey: 'author-b',
      createdAt: NOW - 10,
      attestations: [{ type: 'issuer-signed' }],
    })

    const ranked = rankEvents({
      events: [untrustedEvent, trustedEvent],
      trustedAttestationCountByEventId: new Map([['trusted', 1]]),
      now: NOW,
    })

    expect(ranked.map((event) => event.id)).toEqual(['trusted', 'untrusted'])
  })

  it('does not throw when an event has no attestations field at all', () => {
    const event = { id: 'bare', pubkey: 'author-a', created_at: NOW, identity_mode: 'persistent' }
    expect(() => rankEvents({ events: [event], now: NOW })).not.toThrow()
  })

  it('caps to the requested view size', () => {
    const events = Array.from({ length: 30 }, (_, index) =>
      makeEvent({ id: `event-${index}`, pubkey: `author-${index}`, createdAt: NOW - index })
    )

    const ranked = rankEvents({ events, now: NOW, limit: 12, maxPerAuthor: 5 })

    expect(ranked).toHaveLength(12)
  })
})

describe('tallyVotes', () => {
  it('weights by voter standing rather than counting votes raw', () => {
    const lowStandingDownvotes = Array.from({ length: 10 }, (_, index) =>
      makeVote({
        id: `low-${index}`,
        pubkey: `low-voter-${index}`,
        targetId: 'target',
        createdAt: NOW,
        value: -1,
      })
    )
    const highStandingUpvotes = [
      makeVote({
        id: 'high-0',
        pubkey: 'high-voter-0',
        targetId: 'target',
        createdAt: NOW,
        value: 1,
      }),
      makeVote({
        id: 'high-1',
        pubkey: 'high-voter-1',
        targetId: 'target',
        createdAt: NOW,
        value: 1,
      }),
    ]

    const standingByPubkey = Object.fromEntries([
      ...Array.from({ length: 10 }, (_, index) => [`low-voter-${index}`, 1]),
      ['high-voter-0', 50],
      ['high-voter-1', 50],
    ])

    const scores = tallyVotes({
      voteEvents: [...lowStandingDownvotes, ...highStandingUpvotes],
      standingByPubkey,
    })

    // Raw count would be 2 upvotes against 10 downvotes: net -8. Weighted by standing,
    // two well-established voters outweigh ten fresh ones.
    expect(scores.get('target')).toBe(2 * 50 - 10 * 1)
    expect(scores.get('target')).toBeGreaterThan(0)
  })

  it('keeps only the effective vote per voter, per the SPEC.md section 5.3 tie rule', () => {
    const earlier = makeVote({
      id: 'aaa',
      pubkey: 'voter',
      targetId: 'target',
      createdAt: NOW,
      value: 1,
    })
    const later = makeVote({
      id: 'bbb',
      pubkey: 'voter',
      targetId: 'target',
      createdAt: NOW + 10,
      value: -1,
    })

    const scores = tallyVotes({
      voteEvents: [earlier, later],
      standingByPubkey: { voter: 1 },
    })

    expect(scores.get('target')).toBe(-1)
  })

  it('breaks a tie on created_at by the lexicographically greater id', () => {
    const lowerId = makeVote({
      id: 'aaa',
      pubkey: 'voter',
      targetId: 'target',
      createdAt: NOW,
      value: -1,
    })
    const higherId = makeVote({
      id: 'bbb',
      pubkey: 'voter',
      targetId: 'target',
      createdAt: NOW,
      value: 1,
    })

    const scores = tallyVotes({
      voteEvents: [lowerId, higherId],
      standingByPubkey: { voter: 1 },
    })

    expect(scores.get('target')).toBe(1)
  })

  it('defaults unrecognized voters to the baseline standing rather than throwing', () => {
    const vote = makeVote({
      id: 'aaa',
      pubkey: 'stranger',
      targetId: 'target',
      createdAt: NOW,
      value: 1,
    })
    const scores = tallyVotes({ voteEvents: [vote], standingByPubkey: {} })
    expect(scores.get('target')).toBe(1)
  })
})
