// The relay set (SPEC.md section 12). A client holds a set of relays, each readable
// and/or writable; a single relay is a set of one. Nothing here special-cases that —
// the same publish and query paths run whether `relays` has one entry or twenty, which
// is the whole point: a single-relay shortcut is how the multi-relay case rots.

import { publishToRelays } from './publish.js'

function writableRelays(relaysByUrl) {
  return [...relaysByUrl.values()].filter((relay) => relay.writable)
}

function readableRelays(relaysByUrl) {
  return [...relaysByUrl.values()].filter((relay) => relay.readable)
}

// Deduplicates by `id` — a content hash, so this needs no coordination between relays —
// and records which relays carried each event, per SPEC.md section 12: presence on
// several independent relays is a weak positive signal, and it is what makes one relay's
// outage invisible to the reader.
function mergeEvents(responses) {
  const carriers = new Map()
  for (const response of responses) {
    if (!response.ok) continue
    for (const event of response.events) {
      const existing = carriers.get(event.id)
      if (existing) {
        existing.relays.push(response.relay)
        continue
      }
      carriers.set(event.id, { event, relays: [response.relay] })
    }
  }
  return [...carriers.values()]
}

export function createRelayPool({ relays = [], clock } = {}) {
  // Freshness (SPEC.md section 7.2) has to be re-checked once mining finishes, so the
  // pool needs the same injected clock port every other timed thing in this package
  // takes — never a global, per packages/client/AGENTS.md.
  if (!clock || typeof clock.now !== 'function') {
    throw new TypeError('createRelayPool requires an injected clock port')
  }

  const relaysByUrl = new Map(relays.map((relay) => [relay.url, relay]))

  function addRelay(relay) {
    relaysByUrl.set(relay.url, relay)
  }

  function removeRelay(url) {
    relaysByUrl.delete(url)
  }

  function listRelays() {
    return [...relaysByUrl.values()]
  }

  async function publish({ event, privateKey, miningOptions } = {}) {
    return publishToRelays({
      targets: writableRelays(relaysByUrl),
      event,
      privateKey,
      miningOptions,
      clock,
    })
  }

  async function queryPage({ pageId, anchorId, timeoutMs } = {}) {
    const targets = readableRelays(relaysByUrl)
    const responses = await Promise.all(
      targets.map((relay) => relay.queryPage({ pageId, anchorId, timeoutMs }))
    )
    return mergeEvents(responses)
  }

  async function queryVotes({ targetId, timeoutMs } = {}) {
    const targets = readableRelays(relaysByUrl)
    const responses = await Promise.all(
      targets.map((relay) => relay.queryVotes({ targetId, timeoutMs }))
    )
    return mergeEvents(responses)
  }

  async function queryFeed({ cursor, timeoutMs } = {}) {
    const targets = readableRelays(relaysByUrl)
    const responses = await Promise.all(
      targets.map((relay) => relay.queryFeed({ cursor, timeoutMs }))
    )
    return mergeEvents(responses)
  }

  return { addRelay, removeRelay, listRelays, publish, queryPage, queryVotes, queryFeed }
}
