// An in-memory implementation of the storage port documented in relay/src/store.js.
// Exists for tests only — relay/src never imports this file.

export function createMemoryStore() {
  const eventsById = new Map()
  const keyRecords = new Map()
  const publishLog = []

  async function putEvent(event) {
    eventsById.set(event.id, event)
  }

  async function eventsByPage({ pageId, anchorId, limit }) {
    const matches = [...eventsById.values()].filter((event) => {
      if (event.page_id !== pageId) return false
      if (anchorId && event.anchor?.id !== anchorId) return false
      return true
    })
    return matches.sort((a, b) => b.created_at - a.created_at).slice(0, limit)
  }

  async function votesByTarget({ targetId, limit }) {
    const matches = [...eventsById.values()].filter(
      (event) => event.kind === 'vote' && event.target_id === targetId
    )
    return matches.sort((a, b) => b.created_at - a.created_at).slice(0, limit)
  }

  async function feedPage({ cursor, limit }) {
    const all = [...eventsById.values()].sort((a, b) => b.created_at - a.created_at)
    const startIndex = cursor ? Number(cursor) : 0
    const page = all.slice(startIndex, startIndex + limit)
    const nextCursor = startIndex + limit < all.length ? String(startIndex + limit) : null
    return { events: page, nextCursor }
  }

  async function keyRecord(pubkey) {
    return keyRecords.get(pubkey) ?? null
  }

  async function bumpQuota({ pubkey, pageId, kind, at }) {
    if (!keyRecords.has(pubkey)) {
      keyRecords.set(pubkey, { pubkey, firstSeenAt: at, reports: 0 })
    }
    publishLog.push({ pubkey, pageId, kind, at })
  }

  async function quotaUsage({ pubkey, pageId, kind, since }) {
    const entries = publishLog.filter((entry) => entry.pubkey === pubkey && entry.at >= since)
    return {
      perKey: entries.length,
      perKeyPerPage: pageId ? entries.filter((entry) => entry.pageId === pageId).length : 0,
      perKeyPerKind: kind ? entries.filter((entry) => entry.kind === kind).length : 0,
    }
  }

  return {
    putEvent,
    eventsByPage,
    votesByTarget,
    feedPage,
    keyRecord,
    bumpQuota,
    quotaUsage,
    // Test-only escape hatch, not part of the storage port contract: lets a test seed
    // a key's age and report count without replaying bumpQuota calls.
    _setKeyRecord(pubkey, record) {
      keyRecords.set(pubkey, record)
    },
  }
}
