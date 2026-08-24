// Generic admission-control work proof, per SPEC.md §20: proof-of-work for gating an
// expensive action (a compute job, for instance) that is not a social event and should
// not distort the event schema to get PoW's abuse-control properties. `resource` binds
// one mined proof to one specific request — without it, a single valid proof for a
// `(purpose, subject)` pair would be replayable across every request that subject makes
// inside the freshness window, which defeats "repeated abuse gets progressively more
// expensive".
//
// This object carries no `sig` field on purpose: `pow.js`'s `mine`/`hasSufficientWork`
// already strip `id` and an optional `sig` before hashing, so they work here unmodified
// — no change to `pow.js`, and no distortion of the event format it already serves.

import { mine, hasSufficientWork, isFresh } from './pow.js'

const SUPPORTED_TYPE = 'work-proof'

export function buildWorkProof({ purpose, subject, resource, createdAt }) {
  return {
    v: 1,
    type: SUPPORTED_TYPE,
    purpose,
    subject,
    resource,
    created_at: createdAt,
    nonce: 0,
  }
}

export async function mineWorkProof(workProof, difficulty, options) {
  return mine(workProof, difficulty, options)
}

export async function verifyWorkProof(workProof, { difficulty, now, windowSeconds }) {
  if (workProof.type !== SUPPORTED_TYPE) {
    return { valid: false, reason: 'unsupported_type' }
  }

  if (!(await hasSufficientWork(workProof, difficulty))) {
    return { valid: false, reason: 'insufficient_work' }
  }

  if (!isFresh(workProof.created_at, { now, windowSeconds })) {
    return { valid: false, reason: 'stale' }
  }

  return { valid: true, reason: 'valid' }
}
