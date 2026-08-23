// Reading (SPEC.md sections 5.2, 6.3, 13 and 14). The pool already merges and dedupes by
// `id`; this is what turns that flat list into something an application can render, and
// it is where the relay stops being trusted.
//
// Two verifications happen here and nowhere else, because a relay is untrusted input no
// matter how it was configured:
//   - `page_id` must equal hash(`page_url`) (section 6.3). A relay cannot re-derive
//     page identity, so a forged pairing is only ever caught client-side.
//   - `sig` must verify. The relay checked it too, but a hostile relay is exactly the
//     case a signature exists for.

import { deriveTarget } from '@elseweb/protocol'
import { keepAuthentic } from './authenticity.js'
import { assembleThreads } from './thread.js'
import { verifyEventAttestations, trustedAttestations } from './attestations.js'
import { deriveStanding } from './standing.js'
import { tallyVotes, rankEvents } from './ranking.js'
import { ElsewebError } from './errors.js'

async function resolveTarget(pageUrl, canonicalizeUrl) {
  try {
    return await deriveTarget(canonicalizeUrl ? canonicalizeUrl(pageUrl) : pageUrl)
  } catch (cause) {
    throw new ElsewebError('INVALID_TARGET_URL', `not a valid target URL: ${pageUrl}`, { cause })
  }
}

async function attestationCounts(events, { trustedIssuers, now }) {
  const counts = new Map()
  for (const event of events) {
    const outcomes = await verifyEventAttestations(event, { trustedIssuers, now })
    counts.set(event.id, trustedAttestations(outcomes).length)
  }
  return counts
}

export function createReader({ pool, clock, trustedIssuers = [], canonicalizeUrl, limit }) {
  async function collect(carried) {
    const authentic = await keepAuthentic(carried)
    const events = authentic.map(({ event }) => event)
    const relaysById = new Map(authentic.map(({ event, relays }) => [event.id, relays]))
    return { events, relaysById }
  }

  async function readTarget(pageUrl, { anchorId, timeoutMs } = {}) {
    const target = await resolveTarget(pageUrl, canonicalizeUrl)
    const carried = await pool.queryPage({ pageId: target.page_id, anchorId, timeoutMs })
    const { events, relaysById } = await collect(carried)

    const now = clock.now()
    const voteEvents = events.filter((event) => event.kind === 'vote')
    const standingByPubkey = await deriveStanding(events, { trustedIssuers, now })
    const voteScoreByEventId = tallyVotes({ voteEvents, standingByPubkey })
    const trustedAttestationCountByEventId = await attestationCounts(events, {
      trustedIssuers,
      now,
    })

    // Ranking happens before threading so the per-author cap and the view limit apply to
    // the shares that will actually be shown (SPEC.md section 14: a flood only succeeds
    // if it is displayed). Replies hang off whichever shares survived.
    const shares = rankEvents({
      events: events.filter((event) => event.kind === 'share'),
      voteScoreByEventId,
      trustedAttestationCountByEventId,
      now,
      limit,
    })
    const replies = events.filter((event) => event.kind === 'reply')
    const { threads, orphans } = assembleThreads({
      shares,
      replies,
      relaysById,
      voteScoreByEventId,
    })

    return { target, threads, orphans, votes: voteEvents, events, relaysById }
  }

  function readPage(pageUrl, options = {}) {
    return readTarget(pageUrl, options)
  }

  // Raw vote events for one target, so a consumer can recount and catch a relay that
  // misreports an aggregate (SPEC.md section 5.3).
  async function readVotes(targetId, { timeoutMs } = {}) {
    const carried = await pool.queryVotes({ targetId, timeoutMs })
    const { events } = await collect(carried)
    const voteEvents = events.filter((event) => event.kind === 'vote')
    const now = clock.now()
    const standingByPubkey = await deriveStanding(voteEvents, { trustedIssuers, now })
    return {
      votes: voteEvents,
      score: tallyVotes({ voteEvents, standingByPubkey }).get(targetId) ?? 0,
    }
  }

  async function readFeed({ cursor, timeoutMs, requiredClaims = [] } = {}) {
    const carried = await pool.queryFeed({ cursor, timeoutMs })
    const { events, relaysById } = await collect(carried)
    const now = clock.now()

    // The relay applies its own `feed_requires` filter; this applies the client's, against
    // the client's own trusted-issuer list. SPEC.md section 13: that is what lets a gated
    // feed and an open one coexist without either being privileged.
    const admitted = []
    for (const event of events) {
      if (requiredClaims.length === 0) {
        admitted.push(event)
        continue
      }
      const trusted = trustedAttestations(
        await verifyEventAttestations(event, { trustedIssuers, now })
      )
      const claims = new Set(trusted.map((attestation) => attestation.claim))
      if (requiredClaims.every((claim) => claims.has(claim))) admitted.push(event)
    }

    const standingByPubkey = await deriveStanding(admitted, { trustedIssuers, now })
    const voteScoreByEventId = tallyVotes({
      voteEvents: admitted.filter((event) => event.kind === 'vote'),
      standingByPubkey,
    })
    const trustedAttestationCountByEventId = await attestationCounts(admitted, {
      trustedIssuers,
      now,
    })

    return {
      events: rankEvents({
        events: admitted.filter((event) => event.kind === 'share'),
        voteScoreByEventId,
        trustedAttestationCountByEventId,
        now,
        limit,
      }),
      relaysById,
    }
  }

  return { readPage, readTarget, readVotes, readFeed }
}
