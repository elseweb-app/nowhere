// Proof of work, per SPEC.md §7: difficulty is the number of leading zero bits of the
// event's `id` digest. Mining varies `nonce` until that threshold is met; verification
// just counts bits of a digest the verifier already computed, which is what makes it
// checkable statelessly by a relay that has never seen the author before.
//
// This module carries no difficulty numbers of its own — per packages/protocol's
// AGENTS.md, thresholds are relay policy, not protocol constants. `difficulty` always
// arrives as a parameter from the caller.

import { canonicalBytes } from './canonical.js'
import { sha256, toHex, fromHex } from './crypto.js'

// How often mine() checks in with the caller and yields to the event loop. These are
// mechanical tuning knobs for responsiveness, not protocol policy, so they live here
// rather than being threaded through as parameters nobody would reasonably vary.
const PROGRESS_INTERVAL = 256
const YIELD_INTERVAL = 64

export function leadingZeroBits(bytes) {
  let bits = 0
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8
      continue
    }
    let mask = 0x80
    while (mask > 0 && (byte & mask) === 0) {
      bits += 1
      mask >>= 1
    }
    break
  }
  return bits
}

export function difficultyOf(idHex) {
  return leadingZeroBits(fromHex(idHex))
}

// Recomputes the digest rather than trusting a supplied `id` — the same discipline
// verifyEvent applies, and for the same reason: a caller could otherwise attach a
// well-mined `id` to different content.
export async function hasSufficientWork(event, requiredDifficulty) {
  const digest = await sha256(canonicalBytes(event))
  return leadingZeroBits(digest) >= requiredDifficulty
}

function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// Searches `nonce` upward from zero. Cancellable via AbortSignal and bounded via
// `maxIterations` because mining runs on the caller's schedule, not the relay's — a
// client MUST be able to stop it and MUST NOT let it appear to hang (SPEC.md §7.4).
export async function mine(event, difficulty, options = {}) {
  const { signal, onProgress, maxIterations = Infinity } = options

  for (let nonce = 0, iterations = 0; ; nonce++, iterations++) {
    if (signal?.aborted) {
      throw new DOMException('mining was aborted', 'AbortError')
    }
    if (iterations >= maxIterations) {
      throw new Error(
        `mining gave up after ${maxIterations} iterations without reaching ${difficulty} bits`
      )
    }

    const candidate = { ...event, nonce }
    const digest = await sha256(canonicalBytes(candidate))

    if (leadingZeroBits(digest) >= difficulty) {
      return { ...candidate, id: toHex(digest) }
    }

    if (onProgress && iterations % PROGRESS_INTERVAL === 0) {
      onProgress({ nonce, iterations })
    }
    // sha256() above already awaits into WebCrypto, but that alone isn't guaranteed to
    // be enough of a scheduling boundary in every runtime, so an abort signal raised
    // mid-search is still observed promptly.
    if (iterations % YIELD_INTERVAL === 0) {
      await yieldToEventLoop()
    }
  }
}

// Inclusive at both boundaries: an event dated exactly `windowSeconds` old, or exactly
// `windowSeconds` in the future, is still fresh.
export function isFresh(createdAt, { now, windowSeconds }) {
  return createdAt >= now - windowSeconds && createdAt <= now + windowSeconds
}
