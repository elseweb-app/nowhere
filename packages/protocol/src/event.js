// Event identity and signing, per SPEC.md §3:
//
//   canonical_bytes = JCS(event without id and sig)
//   id              = hex(SHA-256(canonical_bytes))
//   sig             = hex(Ed25519-Sign(privkey, SHA-256(canonical_bytes)))
//
// `id` and `sig` are both derived from the same digest, so every function below shares
// one digest computation rather than hashing twice.

import { canonicalBytes } from './canonical.js'
import { sha256, sign, verify, toHex } from './crypto.js'

async function digestOf(event) {
  return sha256(canonicalBytes(event))
}

export async function computeId(event) {
  return toHex(await digestOf(event))
}

export async function signEvent(event, privateKeySeedHex) {
  const digest = await digestOf(event)
  const id = toHex(digest)
  const sig = await sign(privateKeySeedHex, digest)
  return { ...event, id, sig }
}

// The supplied `id` is never trusted: it is recomputed from the event's own content,
// so a tampered field is caught even if the attacker also updated `id` to match.
export async function verifyEvent(event) {
  const digest = await digestOf(event)
  const recomputedId = toHex(digest)
  if (recomputedId !== event.id) return false
  return verify(event.pubkey, digest, event.sig)
}
