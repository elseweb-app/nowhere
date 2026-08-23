// Ranking (SPEC.md section 14; packages/client/AGENTS.md "Ranking"). Lives here rather
// than in each app so all three surfaces order content identically and a fix reaches
// everyone at once.
//
// Never raw chronological. Capped per view. Author-diverse, so one pubkey cannot fill a
// view. Votes weighted by voter standing, never counted raw — a vote is the cheapest
// event on the network to mass-produce (SPEC.md section 5.3).

const DEFAULT_VIEW_LIMIT = 50
const DEFAULT_MAX_PER_AUTHOR = 5
const DEFAULT_VOTER_STANDING = 1

// Recency decays smoothly rather than falling off a cliff, so a strong post from six
// hours ago still outranks a weak one from six minutes ago.
const RECENCY_HALF_LIFE_SECONDS = 6 * 60 * 60
const ATTESTATION_WEIGHT = 4
const PERSISTENT_IDENTITY_WEIGHT = 1
const BASE_WEIGHT = 1

// Reduces a set of vote events to the tally a target should be ranked by. Two things
// happen here rather than being left to the caller: the SPEC.md section 5.3 tie rule
// (latest `created_at` wins; on a tie, the lexicographically greater `id` wins) picks at
// most one effective vote per (voter, target), and each surviving vote is weighted by
// its voter's standing rather than counted as 1.
export function tallyVotes({ voteEvents, standingByPubkey = {} }) {
  const effectiveVoteByVoter = new Map()
  for (const vote of voteEvents) {
    const voterKey = `${vote.pubkey}:${vote.target_id}`
    const current = effectiveVoteByVoter.get(voterKey)
    if (!current || isLaterVote(vote, current)) {
      effectiveVoteByVoter.set(voterKey, vote)
    }
  }

  const scoreByTarget = new Map()
  for (const vote of effectiveVoteByVoter.values()) {
    const standing = standingByPubkey[vote.pubkey] ?? DEFAULT_VOTER_STANDING
    const weighted = vote.content.value * standing
    scoreByTarget.set(vote.target_id, (scoreByTarget.get(vote.target_id) ?? 0) + weighted)
  }
  return scoreByTarget
}

function isLaterVote(candidate, current) {
  if (candidate.created_at !== current.created_at) {
    return candidate.created_at > current.created_at
  }
  return candidate.id > current.id
}

// `trustedAttestationCount` is precomputed by the caller — via
// attestations.js's verifyEventAttestations()/trustedAttestations() — rather than
// verified here: verification is asynchronous WebCrypto work, and ranking stays a plain
// synchronous sort, the same way tallyVotes() takes a precomputed standingByPubkey
// instead of computing voter standing itself. Merely carrying an attestations array
// proves nothing (SPEC.md section 8) — an untrusted or expired one weighs the same as
// none.
function scoreEvent(event, { now, voteScore, trustedAttestationCount }) {
  const ageSeconds = Math.max(0, now - event.created_at)
  const recencyDecay = 1 / (1 + ageSeconds / RECENCY_HALF_LIFE_SECONDS)
  const attestationWeight = trustedAttestationCount > 0 ? ATTESTATION_WEIGHT : 0
  const identityWeight = event.identity_mode === 'persistent' ? PERSISTENT_IDENTITY_WEIGHT : 0
  return (BASE_WEIGHT + attestationWeight + identityWeight + voteScore) * recencyDecay
}

// Sorts by score, then walks the sorted list applying a per-author cap so a single
// prolific or Sybil-farmed pubkey cannot occupy the view, and stops once `limit` events
// have been kept. The cap is enforced on the already-ranked order, not on the input
// order, so a dominant author's *best* events are the ones that survive the cap.
export function rankEvents({
  events,
  voteScoreByEventId = new Map(),
  trustedAttestationCountByEventId = new Map(),
  now,
  limit = DEFAULT_VIEW_LIMIT,
  maxPerAuthor = DEFAULT_MAX_PER_AUTHOR,
}) {
  const scored = events
    .map((event) => ({
      event,
      score: scoreEvent(event, {
        now,
        voteScore: voteScoreByEventId.get(event.id) ?? 0,
        trustedAttestationCount: trustedAttestationCountByEventId.get(event.id) ?? 0,
      }),
    }))
    .sort((a, b) => b.score - a.score)

  const countByAuthor = new Map()
  const ranked = []
  for (const { event } of scored) {
    const count = countByAuthor.get(event.pubkey) ?? 0
    if (count >= maxPerAuthor) continue
    countByAuthor.set(event.pubkey, count + 1)
    ranked.push(event)
    if (ranked.length >= limit) break
  }
  return ranked
}
