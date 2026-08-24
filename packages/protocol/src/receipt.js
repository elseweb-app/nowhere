// Compute receipts, per SPEC.md §19: proof that a specific compute job happened,
// between a requester and a worker, without carrying the job's prompt or result. The
// worker signs first (`worker_sig`, over every field except both signatures); the
// requester MAY countersign afterward (`requester_sig`, over every field including
// `worker_sig`) — this two-stage signing is what lets a verifier tell "the worker
// claims it finished" apart from "the requester confirms it received the result".
//
// `result_hash` is a digest of the actual result, never the result itself. This module
// never touches prompt or result content — that boundary is structural, not a policy
// this code enforces at runtime.

import { canonicalizeValue } from './canonical.js'
import { sha256, sign, verify } from './crypto.js'

const SUPPORTED_TYPE = 'compute-receipt'

// Excludes both signatures — this is what the worker signs.
export function canonicalizeReceipt(body) {
  const { worker_sig, requester_sig, ...rest } = body
  void worker_sig
  void requester_sig
  return canonicalizeValue(rest)
}

// Excludes only the requester's own signature — this is what the requester signs,
// binding the countersignature to the exact worker-signed receipt, not just the
// fields the two of them share.
export function canonicalizeReceiptForCountersign(body) {
  const { requester_sig, ...rest } = body
  void requester_sig
  return canonicalizeValue(rest)
}

async function workerDigestOf(receipt) {
  return sha256(new TextEncoder().encode(canonicalizeReceipt(receipt)))
}

async function requesterDigestOf(receipt) {
  return sha256(new TextEncoder().encode(canonicalizeReceiptForCountersign(receipt)))
}

export async function signReceiptAsWorker(receipt, workerPrivateKeySeedHex) {
  const digest = await workerDigestOf(receipt)
  const worker_sig = await sign(workerPrivateKeySeedHex, digest)
  return { ...receipt, worker_sig }
}

export async function signReceiptAsRequester(receipt, requesterPrivateKeySeedHex) {
  const digest = await requesterDigestOf(receipt)
  const requester_sig = await sign(requesterPrivateKeySeedHex, digest)
  return { ...receipt, requester_sig }
}

// Returns `countersigned` alongside `valid`/`reason` so a caller can distinguish
// "worker claims completion" from "requester confirmed" in one call, without a second
// round trip through this function.
export async function verifyReceipt(receipt, { requireCountersignature = false } = {}) {
  if (receipt.type !== SUPPORTED_TYPE) {
    return { valid: false, reason: 'unsupported_type', countersigned: false }
  }

  const workerDigest = await workerDigestOf(receipt)
  const workerValid = await verify(receipt.worker_pubkey, workerDigest, receipt.worker_sig)
  if (!workerValid) {
    return { valid: false, reason: 'worker_signature_invalid', countersigned: false }
  }

  const countersigned = receipt.requester_sig !== undefined
  if (countersigned) {
    const requesterDigest = await requesterDigestOf(receipt)
    const requesterValid = await verify(
      receipt.requester_pubkey,
      requesterDigest,
      receipt.requester_sig
    )
    if (!requesterValid) {
      return { valid: false, reason: 'requester_signature_invalid', countersigned: false }
    }
  }

  if (requireCountersignature && !countersigned) {
    return { valid: false, reason: 'not_countersigned', countersigned }
  }

  if (receipt.finished_at < receipt.started_at) {
    return { valid: false, reason: 'invalid_timespan', countersigned }
  }

  return { valid: true, reason: 'valid', countersigned }
}
