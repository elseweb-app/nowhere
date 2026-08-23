// Per-pubkey, per-(pubkey, page_id) and per-kind caps, all read from the tier already
// resolved for this author (policy.js). This is step 11 of SPEC.md §4 — the one step
// in the verification pipeline allowed to touch storage.

export async function checkQuota({ store, config, event, tier, now }) {
  const since = now - config.quotaWindowSeconds
  const usage = await store.quotaUsage({
    pubkey: event.pubkey,
    pageId: event.page_id ?? null,
    kind: event.kind,
    since,
  })

  if (usage.perKey >= tier.quota.perKeyPerDay) {
    return { withinQuota: false, retryAfter: config.quotaWindowSeconds }
  }

  // Vote events carry no page_id (SPEC.md §5.3): the per-page cap simply does not
  // apply to them. That is correct, not a gap — a page-scoped cap on an event with no
  // page would be meaningless, not stricter.
  if (event.page_id && usage.perKeyPerPage >= tier.quota.perKeyPerPagePerDay) {
    return { withinQuota: false, retryAfter: config.quotaWindowSeconds }
  }

  const kindLimit = tier.quota.perKeyPerDayByKind?.[event.kind]
  if (kindLimit !== undefined && usage.perKeyPerKind >= kindLimit) {
    return { withinQuota: false, retryAfter: config.quotaWindowSeconds }
  }

  return { withinQuota: true }
}
