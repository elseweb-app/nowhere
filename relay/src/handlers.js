// One function per SPEC.md §10 endpoint. Each is pure: decoded input plus injected
// deps in, `{ status, body }` out. router.js is the only thing that touches
// Request/Response; nothing here knows HTTP exists.

import { buildPolicy, keyStatus } from './policy.js'
import { verifyIncomingEvent } from './verify.js'
import { buildFeed, diversifyByAuthor } from './feed.js'
import { schemaInvalidError, statusForCode } from './errors.js'

const HEX64 = /^[0-9a-f]{64}$/

function invalid(field, message) {
  const error = schemaInvalidError({ message, field })
  return { status: statusForCode(error.error.code), body: error }
}

// Vote resolution per SPEC.md §5.3: at most one vote per (pubkey, target_id) is
// effective. A later created_at replaces an earlier one; on a tie the
// lexicographically greater id wins, so independent relays converge on the same
// aggregate from the same raw events.
function effectiveVoteWins(candidate, incumbent) {
  if (!incumbent) return true
  if (candidate.created_at !== incumbent.created_at) {
    return candidate.created_at > incumbent.created_at
  }
  return candidate.id > incumbent.id
}

function aggregateVotes(voteEvents) {
  const effectiveByVoter = new Map()
  for (const voteEvent of voteEvents) {
    const incumbent = effectiveByVoter.get(voteEvent.pubkey)
    if (effectiveVoteWins(voteEvent, incumbent)) {
      effectiveByVoter.set(voteEvent.pubkey, voteEvent)
    }
  }

  let up = 0
  let down = 0
  for (const voteEvent of effectiveByVoter.values()) {
    if (voteEvent.content.value === 1) up += 1
    else down += 1
  }
  return { up, down, value: up - down }
}

export function handleGetPolicy({ config }) {
  return { status: 200, body: buildPolicy(config) }
}

export async function handleGetKeyStatus({ pubkey, store, config, clock }) {
  if (!HEX64.test(pubkey ?? '')) {
    return invalid('pubkey', 'pubkey must be 64 lowercase hex characters')
  }
  const status = await keyStatus({ store, config, pubkey, now: clock.now() })
  return { status: 200, body: status }
}

// Proof-of-work is never required on this path (SPEC.md §7.1) — verifyIncomingEvent is
// only ever reached from the POST /events handler below.
export async function handlePublishEvent({ body, store, config, clock }) {
  const now = clock.now()
  const result = await verifyIncomingEvent(body, { config, store, now })
  if (!result.ok) {
    return { status: result.status, body: result.error }
  }

  await store.putEvent(result.event)
  await store.bumpQuota({
    pubkey: result.event.pubkey,
    pageId: result.event.page_id ?? null,
    kind: result.event.kind,
    at: now,
  })

  return { status: 201, body: { event: result.event } }
}

export async function handleGetEventsByPage({ pageId, anchorId, store, config }) {
  if (!HEX64.test(pageId ?? '')) {
    return invalid('page_id', 'page_id must be a 64-character hex string')
  }

  const candidates = await store.eventsByPage({
    pageId,
    anchorId: anchorId || undefined,
    limit: config.listing.candidatePoolSize,
  })
  const events = diversifyByAuthor(candidates, {
    maxEvents: config.listing.maxEvents,
    maxPerAuthor: config.listing.maxPerAuthor,
  })
  return { status: 200, body: { events } }
}

export async function handleGetVotesByTarget({ targetId, store, config }) {
  if (!HEX64.test(targetId ?? '')) {
    return invalid('target_id', 'target_id must be a 64-character hex string')
  }

  const candidates = await store.votesByTarget({
    targetId,
    limit: config.listing.candidatePoolSize,
  })
  const events = diversifyByAuthor(candidates, {
    maxEvents: config.listing.maxEvents,
    maxPerAuthor: config.listing.maxPerAuthor,
  })
  return { status: 200, body: { events, aggregate: aggregateVotes(candidates) } }
}

export async function handleGetFeed({ cursor, store, config, clock }) {
  const policy = buildPolicy(config)
  const { events, nextCursor } = await buildFeed({
    store,
    config,
    policy,
    cursor: cursor || undefined,
    now: clock.now(),
  })
  return { status: 200, body: { events, next_cursor: nextCursor ?? null } }
}
