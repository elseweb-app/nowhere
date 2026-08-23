// The storage port this relay depends on. It is documented and validated here, but
// never constructed here — the concrete implementation (Postgres via Supabase, an
// in-memory map for tests, anything else) is injected by the host binding. This keeps
// verification and policy logic testable without a database and swappable without
// touching either.
//
// Methods a storage port MUST implement, every one of them async:
//
//   putEvent(event)
//     Persists one already-verified event, keyed by its `id`. Idempotent: storing the
//     same `id` twice MUST NOT create a duplicate or error.
//
//   eventsByPage({ pageId, anchorId, limit })
//     Returns up to `limit` events (shares and replies) whose `page_id` matches
//     `pageId`, narrowed to `anchorId` when given. Newest first.
//
//   votesByTarget({ targetId, limit })
//     Returns up to `limit` raw `vote` events whose `target_id` matches `targetId`,
//     for independent recount (SPEC.md §5.3). Newest first.
//
//   feedPage({ cursor, limit })
//     Returns `{ events, nextCursor }`: up to `limit` candidate events for the feed,
//     newest first, plus an opaque cursor for the next page (`null` when exhausted).
//     `cursor` is meaningless to relay logic — only the storage port assigns it
//     meaning.
//
//   keyRecord(pubkey)
//     Returns `{ pubkey, firstSeenAt, reports }` for a key the store has seen before,
//     or `null` for a key it has never seen. `firstSeenAt` is Unix seconds. `reports`
//     is the count of abuse findings against this key.
//
//   bumpQuota({ pubkey, pageId, kind, at })
//     Records that `pubkey` published one event of `kind` on `pageId` (`null` for a
//     `vote`, which carries no `page_id`) at `at` (Unix seconds), for later quota
//     accounting. Also responsible for creating a `keyRecord` the first time a
//     `pubkey` is seen.
//
//   quotaUsage({ pubkey, pageId, kind, since })
//     Returns `{ perKey, perKeyPerPage, perKeyPerKind }`: counts of events published
//     by `pubkey` at or after `since` — in total, scoped to `pageId`, and scoped to
//     `kind`, respectively. `pageId` and `kind` may be `null` when the caller has none
//     in scope (e.g. GET /keys/{pubkey}); a `null` pageId's `perKeyPerPage` and a
//     `null` kind's `perKeyPerKind` MUST both be `0`.

const REQUIRED_METHODS = [
  'putEvent',
  'eventsByPage',
  'votesByTarget',
  'feedPage',
  'keyRecord',
  'bumpQuota',
  'quotaUsage',
]

export function assertStorePort(store) {
  if (!store || typeof store !== 'object') {
    throw new TypeError('a storage port must be an object')
  }
  for (const methodName of REQUIRED_METHODS) {
    if (typeof store[methodName] !== 'function') {
      throw new TypeError(`storage port is missing required method "${methodName}"`)
    }
  }
}
