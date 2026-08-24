// The storage port a compute-transport binding MUST implement. Deliberately separate
// from store.js: job/signal/receipt state here is ephemeral admission/signaling
// metadata for a compute job, never a social event, and per the compute privacy
// boundary (packages/protocol/SPEC.md §20) it MUST NOT carry prompt or result text —
// only what routing and admission need. A binding that cannot offer real persistence
// across requests (e.g. a stateless edge function) still needs *some* shared store for
// this; the in-memory implementation in relay/test/memory-compute-store.js is a
// reference for tests and a single-process Node binding only.
//
// Methods a compute storage port MUST implement, every one of them async:
//
//   putJob(job)               — upsert by job_id, idempotent.
//   getJob(jobId)              — the stored job, or null.
//   pendingJobsByCapability({ capability, limit }) — pending jobs offering `capability`,
//                                newest first.
//   appendSignal(jobId, message) — append one signaling message, returns its index.
//   signalsSince(jobId, sinceIndex) — messages with index > sinceIndex, in order.
//   putRevocation(revocation)  — store by authorization_id, idempotent.
//   isRevoked(authorizationId) — true if a valid revocation was stored for it.

const REQUIRED_METHODS = [
  'putJob',
  'getJob',
  'pendingJobsByCapability',
  'appendSignal',
  'signalsSince',
  'putRevocation',
  'isRevoked',
]

export function assertComputeStorePort(store) {
  if (!store || typeof store !== 'object') {
    throw new TypeError('a compute storage port must be an object')
  }
  for (const methodName of REQUIRED_METHODS) {
    if (typeof store[methodName] !== 'function') {
      throw new TypeError(`compute storage port is missing required method "${methodName}"`)
    }
  }
}
