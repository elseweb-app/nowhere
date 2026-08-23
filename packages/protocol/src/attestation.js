// Attestations, per SPEC.md §8: a publicly verifiable claim about a key, checkable by
// any third party holding only public information — no call to the issuer, no shared
// secret. Only `issuer-signed` (§8.1) exists in v1; any other `type` is rejected
// outright rather than trusted on faith, so a future type never verifies by accident.

import { canonicalizeValue } from './canonical.js'
import { sha256, verify } from './crypto.js'

const SUPPORTED_TYPE = 'issuer-signed'

// `sig` is excluded the same way an event's is (SPEC.md §3).
export function canonicalizeAttestation(body) {
  const { sig, ...rest } = body
  void sig
  return canonicalizeValue(rest)
}

async function digestOf(attestation) {
  const bytes = new TextEncoder().encode(canonicalizeAttestation(attestation))
  return sha256(bytes)
}

// Checks run cheapest/most-authenticating first, each an early return so a caller
// always learns the *first* thing wrong rather than the last thing checked:
//   1. type       — an attestation type we don't speak can't be judged at all.
//   2. signature  — everything past this point trusts fields the sig protects.
//   3. issuer     — trust is a local policy, not a protocol fact (SPEC.md §8.1).
//   4. expiry     — revocation happens by lapsing, not by a call anywhere (§8.1).
//   5. subject    — only checked when the caller supplies the event's own pubkey.
export async function verifyAttestation(attestation, { now, trustedIssuers, subject } = {}) {
  if (attestation.type !== SUPPORTED_TYPE) {
    return { valid: false, reason: 'unsupported_type' }
  }

  const digest = await digestOf(attestation)
  const signatureValid = await verify(attestation.issuer, digest, attestation.sig)
  if (!signatureValid) {
    return { valid: false, reason: 'signature_invalid' }
  }

  // An absent list trusts nobody. Failing safe matters more than convenience here: a
  // caller who forgot the list must not get a crash that a try/catch could turn into a
  // skipped check.
  if (!(trustedIssuers ?? []).includes(attestation.issuer)) {
    return { valid: false, reason: 'untrusted_issuer' }
  }

  // Exclusive at the boundary: an attestation expiring at exactly `now` is expired.
  if (now >= attestation.expires_at) {
    return { valid: false, reason: 'expired' }
  }

  if (subject !== undefined && subject !== attestation.subject) {
    return { valid: false, reason: 'subject_mismatch' }
  }

  return { valid: true, reason: 'valid' }
}
