// Worker/device delegation, per SPEC.md §18: lets one identity (`owner_pubkey`)
// authorize another (`worker_pubkey`) to act on its behalf with a bounded set of
// `capabilities`, without ever sharing the owner's private key. A worker key never
// signs anything that grants authority over the owner key, so a compromised worker key
// cannot forge a new delegation or impersonate its owner — it can only be revoked.
//
// Revocation is its own small signed object referencing `authorization_id`, so an owner
// can revoke without needing the original delegation object at hand.

import { canonicalizeValue } from './canonical.js'
import { sha256, sign, verify, randomBytes, toHex } from './crypto.js'

const DELEGATION_TYPE = 'worker-delegation'
const REVOCATION_TYPE = 'worker-revocation'
const AUTHORIZATION_ID_BYTES = 16

export function generateAuthorizationId() {
  return toHex(randomBytes(AUTHORIZATION_ID_BYTES))
}

export function canonicalizeDelegation(body) {
  const { sig, ...rest } = body
  void sig
  return canonicalizeValue(rest)
}

export function canonicalizeRevocation(body) {
  const { sig, ...rest } = body
  void sig
  return canonicalizeValue(rest)
}

async function delegationDigestOf(delegation) {
  return sha256(new TextEncoder().encode(canonicalizeDelegation(delegation)))
}

async function revocationDigestOf(revocation) {
  return sha256(new TextEncoder().encode(canonicalizeRevocation(revocation)))
}

export async function signDelegation(delegation, ownerPrivateKeySeedHex) {
  const digest = await delegationDigestOf(delegation)
  const sig = await sign(ownerPrivateKeySeedHex, digest)
  return { ...delegation, sig }
}

export async function signRevocation(revocation, ownerPrivateKeySeedHex) {
  const digest = await revocationDigestOf(revocation)
  const sig = await sign(ownerPrivateKeySeedHex, digest)
  return { ...revocation, sig }
}

// Checks run cheapest/most-authenticating first, same discipline as verifyAttestation:
//   1. type       — a delegation type we don't speak can't be judged at all.
//   2. signature  — everything past this point trusts fields the sig protects.
//   3. self       — a key delegating to itself is meaningless; structural, not
//                    time-dependent, so it is checked before anything time-based.
//   4. revoked    — checked before expiry so a revoked-but-not-yet-expired delegation
//                    still fails closed rather than passing on a technicality.
//   5. expiry     — exclusive at the boundary, matching every other primitive here.
//   6. capability — only checked when the caller asks for one specific capability.
// unknown/revoked/expired/self-delegated all fail closed: none of these silently pass.
export async function verifyDelegation(delegation, { now, revokedIds, requiredCapability } = {}) {
  if (delegation.type !== DELEGATION_TYPE) {
    return { valid: false, reason: 'unsupported_type' }
  }

  const digest = await delegationDigestOf(delegation)
  const signatureValid = await verify(delegation.owner_pubkey, digest, delegation.sig)
  if (!signatureValid) {
    return { valid: false, reason: 'signature_invalid' }
  }

  if (delegation.owner_pubkey === delegation.worker_pubkey) {
    return { valid: false, reason: 'self_delegation' }
  }

  // An absent revoked-id set is "nothing known to be revoked", not "nothing is ever
  // revoked" — the caller is expected to supply whatever it actually knows.
  if ((revokedIds ?? []).includes(delegation.authorization_id)) {
    return { valid: false, reason: 'revoked' }
  }

  if (now >= delegation.expires_at) {
    return { valid: false, reason: 'expired' }
  }

  if (requiredCapability !== undefined && !delegation.capabilities.includes(requiredCapability)) {
    return { valid: false, reason: 'capability_missing' }
  }

  return { valid: true, reason: 'valid' }
}

export async function verifyRevocation(revocation) {
  if (revocation.type !== REVOCATION_TYPE) {
    return { valid: false, reason: 'unsupported_type' }
  }

  const digest = await revocationDigestOf(revocation)
  const signatureValid = await verify(revocation.owner_pubkey, digest, revocation.sig)
  if (!signatureValid) {
    return { valid: false, reason: 'signature_invalid' }
  }

  return { valid: true, reason: 'valid' }
}
