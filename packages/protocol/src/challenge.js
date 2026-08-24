// Proof-of-control challenges, per SPEC.md §17: a consumer wanting to link a pubkey to
// its own account system must not trust a bare claim ("this pubkey is mine"). The
// subject key signs a challenge scoped to one consumer (`audience`) and one action —
// proof of control IS the signature, so unlike an attestation there is no separate
// issuer role here.

import { canonicalizeValue } from './canonical.js'
import { sha256, sign, verify, randomBytes, toHex } from './crypto.js'

const SUPPORTED_TYPE = 'proof-of-control'
const NONCE_BYTES = 16

export function generateChallengeNonce() {
  return toHex(randomBytes(NONCE_BYTES))
}

// `sig` is excluded the same way an event's is (SPEC.md §3).
export function canonicalizeChallenge(body) {
  const { sig, ...rest } = body
  void sig
  return canonicalizeValue(rest)
}

async function digestOf(challenge) {
  const bytes = new TextEncoder().encode(canonicalizeChallenge(challenge))
  return sha256(bytes)
}

export async function signChallenge(challenge, privateKeySeedHex) {
  const digest = await digestOf(challenge)
  const sig = await sign(privateKeySeedHex, digest)
  return { ...challenge, sig }
}

// Checks run cheapest/most-authenticating first, same discipline as verifyAttestation:
//   1. type      — a challenge type we don't speak can't be judged at all.
//   2. signature — everything past this point trusts fields the sig protects.
//   3. audience  — required, no "trust everyone" default: this is what stops a
//                  signature made for one consumer being replayed against another.
//   4. expiry    — exclusive at the boundary, matching every other primitive here.
//   5. action / resource / subject — only checked when the caller supplies an
//      expected value, same optional-binding pattern as verifyAttestation's `subject`.
export async function verifyChallenge(
  challenge,
  { now, audience, action, resource, subject } = {}
) {
  if (challenge.type !== SUPPORTED_TYPE) {
    return { valid: false, reason: 'unsupported_type' }
  }

  const digest = await digestOf(challenge)
  const signatureValid = await verify(challenge.subject, digest, challenge.sig)
  if (!signatureValid) {
    return { valid: false, reason: 'signature_invalid' }
  }

  // Deliberately compared even when `audience` is undefined: an omitted expected
  // audience must reject, never be read as "any audience is fine".
  if (audience !== challenge.audience) {
    return { valid: false, reason: 'audience_mismatch' }
  }

  if (now >= challenge.expires_at) {
    return { valid: false, reason: 'expired' }
  }

  if (action !== undefined && action !== challenge.action) {
    return { valid: false, reason: 'action_mismatch' }
  }

  if (resource !== undefined && resource !== challenge.resource) {
    return { valid: false, reason: 'resource_mismatch' }
  }

  if (subject !== undefined && subject !== challenge.subject) {
    return { valid: false, reason: 'subject_mismatch' }
  }

  return { valid: true, reason: 'valid' }
}
