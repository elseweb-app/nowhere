// Builds the SPEC.md §11 policy document from injected configuration, and resolves
// what one key currently owes for GET /keys/{pubkey} (§7.3). No policy number is a
// literal here — every threshold comes from `config`, per relay/AGENTS.md.
//
// The config shape this module (and quotas.js, verify.js, feed.js) expects:
//
//   {
//     protocolVersions: [1],
//     kinds: ['share', 'reply', 'vote'],
//     freshnessWindowSeconds: 300,
//     maxPayloadBytes: 8192,
//     quotaWindowSeconds: 86400,
//     pow: {
//       maxDifficulty: 24,
//       challengeRequired: false,
//       // Ascending by minAgeSeconds. tiers[0] is what an unknown key pays.
//       tiers: [
//         {
//           minAgeSeconds: 0,
//           difficulty: { share: 20, reply: 18, vote: 14 },
//           quota: { perKeyPerDay: 5, perKeyPerPagePerDay: 1, perKeyPerDayByKind: { vote: 20 } },
//         },
//         { minAgeSeconds: 604800, difficulty: { ... }, quota: { ... } },
//       ],
//     },
//     attestations: { requiredFor: [], trustedIssuers: [...], feedRequires: ['membership'] },
//     listing: { maxEvents: 50, maxPerAuthor: 5, candidatePoolSize: 500 },
//     feed: { maxEvents: 50, maxPerAuthor: 5, candidatePoolSize: 500 },
//   }

import { safeParsePolicy, safeParseKeyStatus } from '@elseweb/protocol'

// A key with any report is held at tier 0 regardless of age — a clean record is part
// of the admission requirement for every tier past the first. Otherwise the highest
// tier whose `minAgeSeconds` the key's age satisfies wins, matching relay/AGENTS.md:
// "tier rises with age and a clean record; quota rises and difficulty falls with it."
export function resolveTier(tiers, { ageSeconds, reports }) {
  if (reports > 0) return tiers[0]

  let resolved = tiers[0]
  for (const tier of tiers) {
    if (ageSeconds >= tier.minAgeSeconds) {
      resolved = tier
    }
  }
  return resolved
}

export function buildPolicy(config) {
  const baselineTier = config.pow.tiers[0]

  const policy = {
    protocol_versions: config.protocolVersions,
    kinds: config.kinds,
    pow: {
      default_difficulty: baselineTier.difficulty,
      max_difficulty: config.pow.maxDifficulty,
      challenge_required: config.pow.challengeRequired,
    },
    freshness_window_seconds: config.freshnessWindowSeconds,
    max_payload_bytes: config.maxPayloadBytes,
    attestations: {
      required_for: config.attestations.requiredFor,
      trusted_issuers: config.attestations.trustedIssuers,
      feed_requires: config.attestations.feedRequires,
    },
    quotas: {
      per_key_per_day: baselineTier.quota.perKeyPerDay,
      per_key_per_page_per_day: baselineTier.quota.perKeyPerPagePerDay,
      per_key_per_day_by_kind: baselineTier.quota.perKeyPerDayByKind,
    },
  }

  // A relay serving a policy it then contradicts is a real bug (relay/AGENTS.md) — the
  // policy we are about to serve is checked against the same schema a client checks it
  // against, not just at the edges.
  const parsed = safeParsePolicy(policy)
  if (!parsed.success) {
    throw new Error('built policy document does not satisfy PolicySchema — this is a relay bug')
  }
  return parsed.output
}

function remainingQuota(limit, used) {
  return Math.max(0, limit - used)
}

// KeyStatusSchema (packages/protocol) shapes `remaining_quota` as a flat map of kind ->
// integer, mirroring `required_difficulty`. A kind's true remaining budget is the
// tighter of the overall per-day cap and that kind's own cap when one exists — an
// event of that kind still spends against both.
export async function keyStatus({ store, config, pubkey, now }) {
  const keyRecord = await store.keyRecord(pubkey)
  const ageSeconds = keyRecord ? now - keyRecord.firstSeenAt : 0
  const reports = keyRecord ? keyRecord.reports : 0
  const tier = resolveTier(config.pow.tiers, { ageSeconds, reports })

  const since = now - config.quotaWindowSeconds
  const overallUsage = await store.quotaUsage({ pubkey, pageId: null, kind: null, since })
  const overallRemaining = remainingQuota(tier.quota.perKeyPerDay, overallUsage.perKey)

  const remainingQuotaByKind = {}
  for (const kind of config.kinds) {
    const kindLimit = tier.quota.perKeyPerDayByKind?.[kind]
    if (kindLimit === undefined) {
      remainingQuotaByKind[kind] = overallRemaining
      continue
    }
    const kindUsage = await store.quotaUsage({ pubkey, pageId: null, kind, since })
    remainingQuotaByKind[kind] = Math.min(
      overallRemaining,
      remainingQuota(kindLimit, kindUsage.perKeyPerKind)
    )
  }

  const keyStatusBody = {
    pubkey,
    required_difficulty: tier.difficulty,
    remaining_quota: remainingQuotaByKind,
  }

  // Same discipline as buildPolicy: a relay reporting a key status it does not itself
  // believe is a bug, not cosmetic.
  const parsed = safeParseKeyStatus(keyStatusBody)
  if (!parsed.success) {
    throw new Error(
      'built key status document does not satisfy KeyStatusSchema — this is a relay bug'
    )
  }
  return parsed.output
}
