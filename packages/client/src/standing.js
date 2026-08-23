// Derives standingByPubkey — the map ranking.js's tallyVotes() already accepts but which
// nothing has produced until now (packages/client/AGENTS.md "Ranking": "weight votes by
// voter standing. A raw vote count is the cheapest thing on the network to manufacture").
//
// Key tier and account age are NOT knowable from a set of events: only GET /keys/{pubkey}
// (SPEC.md sections 7.3 and 10) can answer that, and it is a per-key relay round trip
// this function deliberately does not make on a caller's behalf. A host app that wants
// tier/age folded into standing has to fetch it itself, per author, and combine it here —
// faking that signal from events alone would look like real trust while resting on
// nothing the author actually paid for.

import { verifyEventAttestations, trustedAttestations } from './attestations.js'

const TRUSTED_ATTESTATION_WEIGHT = 4
const PERSISTENT_IDENTITY_WEIGHT = 1
const BASE_STANDING = 1

export async function deriveStanding(events, { trustedIssuers = [], now } = {}) {
  const standingByPubkey = {}
  for (const event of events) {
    const outcomes = await verifyEventAttestations(event, { trustedIssuers, now })
    const trustedCount = trustedAttestations(outcomes).length
    const identityWeight = event.identity_mode === 'persistent' ? PERSISTENT_IDENTITY_WEIGHT : 0
    const standing = BASE_STANDING + trustedCount * TRUSTED_ATTESTATION_WEIGHT + identityWeight

    // A pubkey can appear on several events with different attestations attached at
    // different times; standing reflects the best trust that pubkey has ever shown, not
    // whichever event happened to be seen first.
    const existing = standingByPubkey[event.pubkey]
    standingByPubkey[event.pubkey] =
      existing === undefined ? standing : Math.max(existing, standing)
  }
  return standingByPubkey
}
