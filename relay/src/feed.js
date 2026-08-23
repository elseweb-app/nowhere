// SPEC.md §13: the relay's own curated stream, distinct from the page-scoped queries
// that drive the in-page experience. Cross-page by definition, so the
// per-(pubkey, page_id) quota that bounds a page query does not constrain it at all
// (relay/AGENTS.md) — the feed needs, and gets, its own attestation gate and its own
// volume/diversity bounds.

import { verifyAttestation } from '@elseweb/protocol'

async function eventCarriesClaim(event, claim, { trustedIssuers, now }) {
  for (const attestation of event.attestations) {
    if (attestation.type !== 'issuer-signed') continue
    if (attestation.claim !== claim) continue
    const result = await verifyAttestation(attestation, {
      now,
      trustedIssuers,
      subject: event.pubkey,
    })
    if (result.valid) return true
  }
  return false
}

// Shared by feed gating (policy.attestations.feed_requires) and publish-time gating
// (policy.attestations.required_for, checked in verify.js step 9) — both are "does
// this event carry a verified attestation for every one of these claims".
export async function eventSatisfiesClaims(event, requiredClaims, { trustedIssuers, now }) {
  for (const claim of requiredClaims) {
    const satisfied = await eventCarriesClaim(event, claim, { trustedIssuers, now })
    if (!satisfied) return false
  }
  return true
}

// One pubkey MUST NOT occupy an unbounded share of a listing (SPEC.md §10, §14). This
// is deliberately generic so every listing endpoint — not only the feed — can bound
// and diversify with the same rule.
export function diversifyByAuthor(events, { maxEvents, maxPerAuthor }) {
  const countByAuthor = new Map()
  const diversified = []

  for (const event of events) {
    if (diversified.length >= maxEvents) break
    const count = countByAuthor.get(event.pubkey) ?? 0
    if (count >= maxPerAuthor) continue
    countByAuthor.set(event.pubkey, count + 1)
    diversified.push(event)
  }

  return diversified
}

export async function buildFeed({ store, config, policy, cursor, now }) {
  const requiredClaims = policy.attestations?.feed_requires ?? []
  const trustedIssuers = config.attestations.trustedIssuers

  const page = await store.feedPage({ cursor, limit: config.feed.candidatePoolSize })

  const gated = []
  for (const event of page.events) {
    const eligible = await eventSatisfiesClaims(event, requiredClaims, { trustedIssuers, now })
    if (eligible) gated.push(event)
  }

  const events = diversifyByAuthor(gated, {
    maxEvents: config.feed.maxEvents,
    maxPerAuthor: config.feed.maxPerAuthor,
  })

  return { events, nextCursor: page.nextCursor }
}
