// Turning a flat, deduplicated event list into threads.
//
// SPEC.md section 5.2: a reply whose parent is missing MUST be rendered as an orphan, not
// dropped. In a federation the parent may simply live on a relay this reader does not
// use, and discarding it would make the network look emptier the fewer relays someone
// happened to configure — the opposite of what federation is for.

export function assembleThreads({ shares, replies, relaysById, voteScoreByEventId }) {
  const known = new Set(shares.map((share) => share.id))
  for (const reply of replies) known.add(reply.id)

  const repliesByRoot = new Map()
  const orphans = []
  for (const reply of replies) {
    if (!known.has(reply.parent_id)) {
      orphans.push(reply)
      continue
    }
    const siblings = repliesByRoot.get(reply.root_id) ?? []
    siblings.push(reply)
    repliesByRoot.set(reply.root_id, siblings)
  }

  const threads = shares.map((share) => ({
    share,
    // Replies read in the order they were written; the ranking that bounds a view applies
    // to the shares that carry them, not inside one conversation.
    replies: (repliesByRoot.get(share.id) ?? []).sort((a, b) => a.created_at - b.created_at),
    score: voteScoreByEventId.get(share.id) ?? 0,
    relays: relaysById.get(share.id) ?? [],
  }))

  return { threads, orphans }
}
