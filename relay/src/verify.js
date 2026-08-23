// SPEC.md §4: the eleven-step verification pipeline, in exactly the spec's order,
// rejecting on the first failure. Steps 1-10 touch nothing but the event itself and
// `config` — no storage read, no storage write — so an unauthenticated caller cannot
// cause database work by sending garbage. Only step 11 (quota) is allowed to read the
// store.
//
// That constraint is also why step 10 (proof-of-work) checks against the relay's
// baseline "unknown key" difficulty (config.pow.tiers[0]) rather than an adaptive,
// per-key one: knowing which tier this key has earned needs the same store read step
// 11 alone is allowed to make. Adaptive difficulty is still real — GET /keys/{pubkey}
// (policy.js) reports it — it just cannot gate acceptance before the store touch.

import {
  safeParseEvent,
  computeId,
  verifyEvent,
  verifyAttestation,
  hasSufficientWork,
  isFresh,
} from '@elseweb/protocol'

import {
  unsupportedVersionError,
  unsupportedKindError,
  schemaInvalidError,
  payloadTooLargeError,
  staleTimestampError,
  signatureInvalidError,
  attestationInvalidError,
  attestationRequiredError,
  powInsufficientError,
  quotaExceededError,
  statusForCode,
} from './errors.js'
import { eventSatisfiesClaims } from './feed.js'
import { resolveTier } from './policy.js'
import { checkQuota } from './quotas.js'

function rejected(errorEnvelope) {
  return { ok: false, status: statusForCode(errorEnvelope.error.code), error: errorEnvelope }
}

function fieldFromIssues(issues) {
  const path = issues?.[0]?.path ?? []
  if (path.length === 0) return undefined
  return path.map((segment) => segment.key).join('.')
}

function encodedByteLength(rawEvent) {
  return new TextEncoder().encode(JSON.stringify(rawEvent)).length
}

// Unknown attestation types are ignored, not rejected, mirroring the client tolerance
// rule in SPEC.md §8.2 — a relay that hard-rejected an unrecognized type would make it
// impossible to ever introduce one without a coordinated flag day across every relay
// in the federation.
async function firstInvalidAttestation(event, { trustedIssuers, now }) {
  for (const attestation of event.attestations) {
    if (attestation.type !== 'issuer-signed') continue
    const result = await verifyAttestation(attestation, {
      now,
      trustedIssuers,
      subject: event.pubkey,
    })
    if (!result.valid) return result
  }
  return null
}

export async function verifyIncomingEvent(rawEvent, { config, store, now }) {
  // 1. Protocol version.
  if (!config.protocolVersions.includes(rawEvent?.v)) {
    return rejected(
      unsupportedVersionError({
        message: `protocol version ${JSON.stringify(rawEvent?.v)} is not supported`,
        protocolVersions: config.protocolVersions,
      })
    )
  }

  // 2. Kind.
  if (!config.kinds.includes(rawEvent?.kind)) {
    return rejected(
      unsupportedKindError({
        message: `event kind ${JSON.stringify(rawEvent?.kind)} is not accepted`,
        kinds: config.kinds,
      })
    )
  }

  // 3. Schema for the kind.
  const parsed = safeParseEvent(rawEvent)
  if (!parsed.success) {
    return rejected(
      schemaInvalidError({
        message: 'event does not match the schema for its kind',
        field: fieldFromIssues(parsed.issues),
      })
    )
  }
  const event = parsed.output

  // 4. Payload size.
  if (encodedByteLength(rawEvent) > config.maxPayloadBytes) {
    return rejected(
      payloadTooLargeError({
        message: 'event payload exceeds the size limit',
        maxPayloadBytes: config.maxPayloadBytes,
      })
    )
  }

  // 5. Freshness, both directions.
  if (!isFresh(event.created_at, { now, windowSeconds: config.freshnessWindowSeconds })) {
    return rejected(
      staleTimestampError({
        message: 'created_at is outside the freshness window',
        serverTime: now,
        freshnessWindowSeconds: config.freshnessWindowSeconds,
      })
    )
  }

  // 6. id equals hash of recomputed canonical bytes.
  const recomputedId = await computeId(event)
  if (recomputedId !== event.id) {
    return rejected(
      schemaInvalidError({
        message: 'id does not equal the hash of the recomputed canonical bytes',
        field: 'id',
      })
    )
  }

  // 7. Signature. verifyEvent recomputes the same id check step 6 already passed, so
  // by this point its result reflects the signature alone.
  const signatureValid = await verifyEvent(event)
  if (!signatureValid) {
    return rejected(signatureInvalidError({ message: 'sig does not verify against pubkey' }))
  }

  // 8. Every attestation verifies and is unexpired.
  const invalidAttestation = await firstInvalidAttestation(event, {
    trustedIssuers: config.attestations.trustedIssuers,
    now,
  })
  if (invalidAttestation) {
    return rejected(
      attestationInvalidError({
        message: `attestation failed verification: ${invalidAttestation.reason}`,
        reason: invalidAttestation.reason,
      })
    )
  }

  // 9. This relay's own attestation requirements.
  const requiredClaims = config.attestations.requiredFor
  const requirementsMet = await eventSatisfiesClaims(event, requiredClaims, {
    trustedIssuers: config.attestations.trustedIssuers,
    now,
  })
  if (!requirementsMet) {
    return rejected(
      attestationRequiredError({
        message: 'event is missing an attestation this relay requires',
        requiredClaims,
        trustedIssuers: config.attestations.trustedIssuers,
      })
    )
  }

  // 10. Proof of work, against the baseline (unknown-key) difficulty — see file header.
  const baselineDifficulty = config.pow.tiers[0].difficulty[event.kind]
  const sufficientWork = await hasSufficientWork(event, baselineDifficulty)
  if (!sufficientWork) {
    return rejected(
      powInsufficientError({
        message: 'id does not carry sufficient proof-of-work',
        requiredDifficulty: baselineDifficulty,
      })
    )
  }

  // 11. Quota — the only step allowed to touch the store.
  const keyRecord = await store.keyRecord(event.pubkey)
  const ageSeconds = keyRecord ? now - keyRecord.firstSeenAt : 0
  const reports = keyRecord ? keyRecord.reports : 0
  const tier = resolveTier(config.pow.tiers, { ageSeconds, reports })

  const quotaResult = await checkQuota({ store, config, event, tier, now })
  if (!quotaResult.withinQuota) {
    return rejected(
      quotaExceededError({ message: 'author is over quota', retryAfter: quotaResult.retryAfter })
    )
  }

  return { ok: true, event }
}
